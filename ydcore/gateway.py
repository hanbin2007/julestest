"""本地解密代理网关：HTTP 处理 + 缩略图/缓冲/预缓存编排 + 状态对象。

Gateway 持有一台网关实例的全部可变状态（原先散在 make_handler 闭包里），并提供
缩略图/整集缓冲/预缓存的后台编排方法。make_handler(gateway) 返回一个 BaseHTTPRequestHandler
子类，其 gw 类属性指向该 Gateway，处理方法统一通过 self.gw.* 访问状态。

并发不变量（刻意不加锁的共享 dict，单写者 + GIL 原子，依赖如下约定）：
  · playhead[vid]   仅由 /p 处理线程在该 vid 的直播分片请求里写；预缓存 worker 只读，
                    读到旧值会在下一轮主动 re-center，stale 读无害。
  · seg_urls[vid]   由 /p、整集缓冲、预缓存写入"该 vid 的有序分片列表"，三者写的是同一
                    内容（同清晰度），互相覆盖等价；读方只做存在性/长度判断。
  · seg_total[vid]  同上，写的是分片总数（同一值）。
  · pf_active["vid"]  仅在 pf_lock 内写；多处无锁读，读到旧值最多让 worker 多跑一轮即退出。
有锁保护的状态：video_headers(vh_lock)、
thumb_meta/thumb_active/thumb_jobs/thumb_procs/thumb_session(thumb_lock)、
buf_state/buf_jobs(buf_lock)、pf_threads/pf_done(pf_lock)、seg_cache(自带锁)。
"""
import concurrent.futures
import json
import logging
import os
import queue
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from ydcore.appconfig import load_config, save_config
from ydcore.cache import DiskLRU, SEG_CACHE_BYTES
from ydcore.hls import UnsatisfiableRange, looks_like_m3u8, parse_range, parse_segments, proxify, rewrite_m3u8
from ydcore.priority import PriorityGate
from ydcore.util import which
from ydcore.youdao_api import (
    get_product_videos, get_product_watch_state, list_products,
    play_headers, resolve_m3u8,
)

_log = logging.getLogger(__name__)

# ---- 前端单页 + 依赖资源 -------------------------------------------------
_WEB_UI_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web_ui")


def _load_app_html():
    """前端单页：从 ydcore/web_ui/app.html 读入（含 __AUTO__ 占位，运行时替换）。"""
    with open(os.path.join(_WEB_UI_DIR, "app.html"), encoding="utf-8") as f:
        return f.read()


APP_HTML = _load_app_html()

_ASSET_CDN = {
    "hls.js": "https://cdn.jsdelivr.net/npm/hls.js@1.5.13/dist/hls.min.js",
    "artplayer.js": "https://cdn.jsdelivr.net/npm/artplayer@5.1.7/dist/artplayer.js",
}
_ASSET_CACHE = {}


def asset_bytes(name):
    """本地代理自带前端依赖（hls.js / artplayer.js），首次从 CDN 取一次并缓存。
    失败时不缓存空值，留给下次调用重试（避免启动时网络抖动永久 brick 播放器）。"""
    if name not in _ASSET_CACHE:
        try:
            req = urllib.request.Request(_ASSET_CDN[name],
                                         headers={"User-Agent": "youdao_course"})
            with urllib.request.urlopen(req, timeout=30) as r:
                _ASSET_CACHE[name] = r.read()
        except Exception:  # noqa: BLE001
            _log.warning("前端依赖拉取失败（下次请求会重试）：%s", name, exc_info=True)
            return b""  # 本次失败返回空，但不入缓存，下次仍可重试
    return _ASSET_CACHE[name]


# 缩略图雪碧图参数
THUMB_INTERVAL = 10   # 每 10 秒一帧
THUMB_W = 160
THUMB_H = 90
THUMB_COLS = 10
# 缩略图持久化目录（生成后不删，跨会话复用）
THUMB_DIR = os.path.join(os.path.expanduser("~"), ".youdao_course", "thumbs")
THUMB_WORKERS = 3


class Gateway:
    """一台网关实例的全部状态 + 后台编排（缩略图 / 整集缓冲 / 预缓存）。"""

    def __init__(self, base_headers, session=None, auto=None, prefetch=True,
                 cache_bytes=SEG_CACHE_BYTES, port=8808, cache_dir=None):
        self.base_headers = base_headers
        self.session = session if session is not None else base_headers
        self.prefetch = prefetch
        self.port = port
        self.page = APP_HTML.replace("__AUTO__", json.dumps(auto) if auto else "null")

        self.video_headers = {}
        self.vh_lock = threading.Lock()
        self.seg_cache = DiskLRU(cache_bytes, cache_dir)
        # 三档优先级闸门：0=LIVE(观看) > 1=AUTO(自动缓存) > 2=MANUAL(手动缓存)。
        self.gate = PriorityGate()

        # 缩略图雪碧图：服务端用 ffmpeg 生成（复用已缓存分片），供 Artplayer 拖动预览。
        self.thumb_dir = THUMB_DIR
        os.makedirs(self.thumb_dir, exist_ok=True)
        self.thumb_index_path = os.path.join(self.thumb_dir, "index.json")
        self.thumb_meta = {}     # vid -> {"state": "gen"/"ready"/"error"/"cancelled", ...}
        self.thumb_active = set()  # 真正在 ffmpeg 生成中的 vid（区分"生成中"与"排队中"）
        self.thumb_jobs = {}     # vid -> (video, m3u8, duration, tier)，供重试重新入队
        self.thumb_procs = {}    # vid -> 运行中的 ffmpeg Popen，供取消时 terminate
        self.thumb_session = set()  # 本会话真正排过队的缩略图 vid（区分"任务"与启动时预载的 ready）
        self.thumb_lock = threading.Lock()
        self.thumb_q = queue.Queue()
        self.have_ffmpeg = which("ffmpeg") is not None
        try:
            with open(self.thumb_index_path, "r", encoding="utf-8") as f:
                for vid, m in (json.load(f) or {}).items():
                    if os.path.exists(os.path.join(self.thumb_dir, "%s.jpg" % vid)):
                        self.thumb_meta[vid] = m
        except FileNotFoundError:
            pass   # 首次运行：尚无缩略图索引，正常
        except Exception:  # noqa: BLE001
            _log.warning("缩略图索引损坏，忽略：%s", self.thumb_index_path, exc_info=True)

        # 整集缓冲（把整节课分片下到服务端磁盘缓存）：批量预缓冲 + 状态
        self.seg_total = {}      # vid -> 总分片数（已知时）
        self.seg_urls = {}       # vid -> 按播放顺序的分片绝对地址列表
        self.buf_state = {}      # vid -> "queued"/"working"/"paused"/"done"/"error"/"cancelled"
        self.buf_jobs = {}       # vid -> (video, m3u8)，供继续/重试重新入队
        self.buf_lock = threading.Lock()
        self.buf_q = queue.Queue()

        # 自动预缓存：以"播放头"为中心向前后双向补未缓存分片。
        self.pf_lock = threading.Lock()
        self.pf_active = {"vid": None}
        self.pf_done = set()     # 本会话预缓存到「整集已满」的 vid（供设置页「已完成」显示看过的讲）
        self.pf_threads = {}     # vid -> (thread, stop_event)
        self.pf_segidx = {}      # vid -> {seg_url: index}
        self.playhead = {}       # vid -> 最近一次直播请求到的分片下标

        for _ in range(max(1, THUMB_WORKERS)):
            threading.Thread(target=self._thumb_worker, daemon=True).start()
        threading.Thread(target=self._buffer_worker, daemon=True).start()

    def pri_fetch(self, t, hdrs, url, range_header=None):
        """按优先级档位回源（委托给闸门）。"""
        return self.gate.fetch(t, hdrs, url, range_header)

    # ---- 缩略图 ----------------------------------------------------------
    def _save_thumb_index(self):
        with self.thumb_lock:
            snap = {k: v for k, v in self.thumb_meta.items() if v.get("state") == "ready"}
        try:
            with open(self.thumb_index_path, "w", encoding="utf-8") as f:
                json.dump(snap, f)
        except Exception:  # noqa: BLE001
            _log.warning("缩略图索引落盘失败：%s", self.thumb_index_path, exc_info=True)

    def _thumb_worker(self):
        while True:
            vid, m3u8, duration, tier = self.thumb_q.get()
            with self.thumb_lock:
                # 出队复查：排队期间被取消的，直接跳过本次生成
                if (self.thumb_meta.get(vid) or {}).get("state") == "cancelled":
                    self.thumb_q.task_done()
                    continue
                self.thumb_active.add(vid)
            try:
                self._gen_thumbs(vid, m3u8, duration, tier)
            except Exception as e:  # noqa: BLE001
                _log.warning("缩略图生成失败 vid=%s", vid, exc_info=True)
                with self.thumb_lock:
                    # 取消已是终态：别用 error 覆盖
                    if (self.thumb_meta.get(vid) or {}).get("state") != "cancelled":
                        self.thumb_meta[vid] = {"state": "error", "reason": str(e)}
            finally:
                with self.thumb_lock:
                    self.thumb_active.discard(vid)
                    self.thumb_procs.pop(vid, None)
                self.thumb_q.task_done()

    def _gen_thumbs(self, vid, m3u8, duration, tier):
        if duration <= 0:
            duration = 600
        number = max(1, int(duration // THUMB_INTERVAL))
        rows = (number + THUMB_COLS - 1) // THUMB_COLS
        out = os.path.join(self.thumb_dir, "%s.jpg" % vid)
        tvid = "t_" + vid  # 缩略图用低清流自己的 Url 头（key 按清晰度绑定）
        with self.vh_lock:
            th = dict(self.video_headers.get(tvid) or {})
        if not th:
            with self.thumb_lock:
                self.thumb_meta[vid] = {"state": "error", "reason": "no headers"}
            return
        # 先按档位把低清分片+密钥灌进缓存，ffmpeg 再顺序读缓存就很快
        try:
            pl, _, _ = self.pri_fetch(tier, th, m3u8)
            text = pl.decode("utf-8", "replace")
            urls = [urllib.parse.urljoin(m3u8, ln.strip())
                    for ln in text.splitlines() if ln.strip() and not ln.startswith("#")]
            for ln in text.splitlines():
                if ln.startswith("#EXT-X-KEY") and 'URI="' in ln:
                    _km = re.search(r'URI="([^"]+)"', ln)
                    if _km:
                        urls.insert(0, urllib.parse.urljoin(m3u8, _km.group(1)))

            def _grab(u):
                if self.seg_cache.has((u, tvid)):
                    return
                try:
                    d, c, _ = self.pri_fetch(tier, th, u)
                    self.seg_cache.put((u, tvid), (c or "video/mp2t", d))
                except Exception:  # noqa: BLE001
                    _log.debug("缩略图源分片预取失败：%s", u, exc_info=True)
            # 并发收紧到 1：受限下行下，高档抢占时不可取消的在途下载越少越好。
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as ex:
                list(ex.map(_grab, urls))
        except Exception:  # noqa: BLE001
            _log.debug("缩略图源 m3u8 预取失败 vid=%s（仍尝试 ffmpeg 直读）", vid, exc_info=True)
        proxied = "http://127.0.0.1:%d/p?u=%s&vid=%s" % (
            self.port, urllib.parse.quote(m3u8, safe=""), tvid)
        vf = ("fps=1/%d,scale=%d:%d:force_original_aspect_ratio=increase,"
              "crop=%d:%d,tile=%dx%d" % (THUMB_INTERVAL, THUMB_W, THUMB_H,
                                         THUMB_W, THUMB_H, THUMB_COLS, rows))
        # -skip_frame nokey：只解关键帧，配合 fps 过滤器既保持均匀间隔又大幅加速
        # -allowed_extensions ALL + -extension_picky 0：ffmpeg 8 默认按扩展名校验，会拒绝
        # 代理段地址（…&vid=t_xxx，无 .ts 后缀），不加这俩缩略图会 rc=183 失败。
        cmd = ["ffmpeg", "-y", "-nostdin",
               "-allowed_extensions", "ALL", "-extension_picky", "0",
               "-skip_frame", "nokey", "-i", proxied,
               "-an", "-vf", vf, "-frames:v", "1", "-q:v", "6", out, "-loglevel", "error"]
        # 用 Popen 而非 call：保留进程句柄，取消任务时可 terminate 掉正在跑的 ffmpeg。
        with self.thumb_lock:
            proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL)
            self.thumb_procs[vid] = proc
        rc = proc.wait()
        # 取消复查与终态落地必须在同一把锁内：否则二者之间有窗口，刚好取消进来会被 ready/error 覆盖。
        # _save_thumb_index 自身要拿 thumb_lock（不可重入），故用 save_idx 标记、出锁后再存。
        save_idx = False
        with self.thumb_lock:
            self.thumb_procs.pop(vid, None)
            # 生成途中被取消（terminate）：保持 cancelled 终态，别落成 ready/error
            if (self.thumb_meta.get(vid) or {}).get("state") == "cancelled":
                return
            if rc == 0 and os.path.exists(out):
                self.thumb_meta[vid] = {"state": "ready", "url": "/thumbs/%s.jpg" % vid,
                                        "number": number, "column": THUMB_COLS,
                                        "width": THUMB_W, "height": THUMB_H}
                save_idx = True
            else:
                self.thumb_meta[vid] = {"state": "error", "reason": "ffmpeg rc=%d" % rc}
        if save_idx:
            self._save_thumb_index()

    def start_thumbs(self, video, m3u8, duration, tier=2):
        """video: {videoId,contentId,cardPackageId,productId}; m3u8: 低清地址。
        tier: 播放时自动触发=1(AUTO)，手动批量=2(MANUAL)。"""
        vid = str(video["videoId"])
        if not self.have_ffmpeg:
            return {"state": "error", "reason": "no ffmpeg"}
        with self.thumb_lock:
            st = self.thumb_meta.get(vid)
            if st and st["state"] in ("ready", "gen"):
                return st
            self.thumb_meta[vid] = {"state": "gen"}
            self.thumb_jobs[vid] = (video, m3u8, duration, tier)  # 供重试重新入队
            self.thumb_session.add(vid)                            # 标记为本会话任务
        with self.vh_lock:
            self.video_headers["t_" + vid] = play_headers(self.session, video, m3u8)
        self.thumb_q.put((vid, m3u8, duration, tier))
        return {"state": "gen"}

    # ---- 整集缓冲 --------------------------------------------------------
    def _buffer_one(self, video, m3u8):
        # 手动缓存（MANUAL，档 2）：让位给观看(0)和自动缓存(1)。注意：要和自动缓存
        # 合并到同一集，二者须用同一清晰度——目前前端 pickM3u8/MK_BUF 与播放都取最高清，
        # key 同为 (seg_url, vid) 故天然合并；若改播放器清晰度选择，需同步前端取值。
        vid = str(video["videoId"])
        th = play_headers(self.session, video, m3u8)
        with self.vh_lock:
            self.video_headers[vid] = th
        pl, _, _ = self.pri_fetch(2, th, m3u8)
        text = pl.decode("utf-8", "replace")
        segs = parse_segments(text, m3u8)
        self.seg_total[vid] = len(segs)
        self.seg_urls[vid] = list(segs)  # 供逐片缓存 bitmap 查询
        urls = list(segs)
        for ln in text.splitlines():
            if ln.startswith("#EXT-X-KEY") and 'URI="' in ln:
                _km = re.search(r'URI="([^"]+)"', ln)
                if _km:
                    urls.insert(0, urllib.parse.urljoin(m3u8, _km.group(1)))

        # 逐片顺序下载（并发本就收紧到 1：手动缓存最低优先，抢占时在途下载越少观看越稳）。
        # 每片前复查 buf_state：被暂停/取消则即时收手并返回该终态——已下分片留在缓存里，
        # 继续时重新入队会被 seg_cache.has 跳过，等价于断点续传。
        for u in urls:
            with self.buf_lock:
                st = self.buf_state.get(vid)
            if st in ("paused", "cancelled"):
                return st
            if self.seg_cache.has((u, vid)):
                continue
            try:
                d, c, _ = self.pri_fetch(2, th, u)
                self.seg_cache.put((u, vid), (c or "video/mp2t", d))  # 每片下完即可被命中
            except Exception:  # noqa: BLE001
                _log.debug("整集缓冲分片失败 vid=%s：%s", vid, u, exc_info=True)
        return "done"

    def _buffer_worker(self):
        while True:
            video, m3u8 = self.buf_q.get()
            vid = str(video["videoId"])
            with self.buf_lock:
                # 出队复查：排队期间被取消/继续顶替的旧条目直接丢弃（仅 queued 才真正开工）
                if self.buf_state.get(vid) != "queued":
                    self.buf_q.task_done()
                    continue
                self.buf_state[vid] = "working"
            try:
                result = self._buffer_one(video, m3u8)  # "done"/"paused"/"cancelled"
            except Exception:  # noqa: BLE001
                _log.warning("整集缓冲失败 vid=%s", vid, exc_info=True)
                result = "error"
            with self.buf_lock:
                # 仅当仍是 working 才落地结果；执行途中被 action 改成 paused/cancelled 则遵从之。
                # pop 也必须在该守卫内：否则"刚下完就被暂停"会误删重试上下文，导致继续无门。
                if self.buf_state.get(vid) == "working":
                    self.buf_state[vid] = result
                    if result == "done":
                        self.buf_jobs.pop(vid, None)  # 成功完成后释放重试上下文
            self.buf_q.task_done()

    def start_buffer(self, video, m3u8):
        vid = str(video["videoId"])
        with self.buf_lock:
            if self.buf_state.get(vid) in ("queued", "working", "paused"):
                return
            self.buf_state[vid] = "queued"
            self.buf_jobs[vid] = (video, m3u8)  # 供继续/重试重新入队
        self.buf_q.put((video, m3u8))

    # ---- 任务操作（暂停/继续/取消/重试）------------------------------------
    # 全部即时复查当前状态后再决策，幂等：非法转换返回 ok=False 而不抛错，便于前端
    # 在 1s 轮询造成的状态漂移下安全重试。
    def act_buffer(self, vid, verb):
        """缓冲任务：pause/resume/cancel/retry。返回 {ok,vid,kind,state,reason?}。"""
        vid = str(vid)
        requeue = None
        with self.buf_lock:
            st = self.buf_state.get(vid)
            job = self.buf_jobs.get(vid)
            if verb == "pause":
                ok = st == "working"
                if ok:
                    self.buf_state[vid] = "paused"  # 缓冲循环下一片处复查后收手
            elif verb == "resume":
                ok = st == "paused" and job is not None
                if ok:
                    self.buf_state[vid] = "queued"
                    requeue = job
            elif verb == "cancel":
                ok = st in ("queued", "working", "paused")
                if ok:
                    self.buf_state[vid] = "cancelled"  # 排队中的靠出队复查丢弃；working 靠循环复查
                    self.buf_jobs.pop(vid, None)
            elif verb == "retry":
                ok = st == "error" and job is not None
                if ok:
                    self.buf_state[vid] = "queued"
                    requeue = job
            else:
                return {"ok": False, "vid": vid, "kind": "buffer", "state": st, "reason": "bad verb"}
            new_state = self.buf_state.get(vid)
        if requeue is not None:
            self.buf_q.put(requeue)  # 队列自带锁，放在 buf_lock 外入队（与 start_buffer 一致）
        reason = None if ok else "状态 %s 下不能执行 %s" % (st, verb)
        return {"ok": ok, "vid": vid, "kind": "buffer", "state": new_state, "reason": reason}

    def act_thumb(self, vid, verb):
        """缩略图任务：cancel(=暂停)/retry。ffmpeg 是单次原子调用，无部分续传，故不支持 pause。"""
        vid = str(vid)
        proc_to_kill = None
        requeue = None
        with self.thumb_lock:
            st = (self.thumb_meta.get(vid) or {}).get("state")
            job = self.thumb_jobs.get(vid)
            if verb == "cancel":
                ok = st == "gen"  # gen 覆盖"排队中"与"正在 ffmpeg"
                if ok:
                    self.thumb_meta[vid] = {"state": "cancelled"}
                    proc_to_kill = self.thumb_procs.get(vid)  # 正在跑则拿到句柄，下面 terminate
            elif verb == "retry":
                ok = st in ("error", "cancelled") and job is not None
                if ok:
                    self.thumb_meta[vid] = {"state": "gen"}
                    requeue = job
            else:
                return {"ok": False, "vid": vid, "kind": "thumb", "state": st, "reason": "bad verb"}
            new_state = (self.thumb_meta.get(vid) or {}).get("state")
        if proc_to_kill is not None:
            try:
                proc_to_kill.terminate()
            except Exception:  # noqa: BLE001
                _log.debug("终止缩略图 ffmpeg 失败 vid=%s", vid, exc_info=True)
        if requeue is not None:
            _, m3u8, duration, tier = requeue
            self.thumb_q.put((vid, m3u8, duration, tier))
        reason = None if ok else "状态 %s 下不能执行 %s" % (st, verb)
        return {"ok": ok, "vid": vid, "kind": "thumb", "state": new_state, "reason": reason}

    # ---- 自动预缓存 ------------------------------------------------------
    def _prefetch_worker(self, vid, m3u8, stop):
        hdrs = self.video_headers.get(vid)
        if not hdrs:
            return
        try:
            data, _, _ = self.pri_fetch(1, hdrs, m3u8)
        except Exception:  # noqa: BLE001
            _log.warning("预缓存取 m3u8 失败 vid=%s（观看不受影响）", vid, exc_info=True)
            return
        text = data.decode("utf-8", "replace")
        # 先把密钥缓存好
        for line in text.splitlines():
            if line.startswith("#EXT-X-KEY") and 'URI="' in line:
                _km = re.search(r'URI="([^"]+)"', line)
                if not _km:
                    continue
                kabs = urllib.parse.urljoin(m3u8, _km.group(1))
                if not self.seg_cache.has((kabs, vid)):
                    try:
                        kd, kc, _ = self.pri_fetch(1, hdrs, kabs)
                        self.seg_cache.put((kabs, vid), (kc or "application/octet-stream", kd))
                    except Exception:  # noqa: BLE001
                        _log.debug("预缓存取密钥失败 vid=%s：%s", vid, kabs, exc_info=True)
        segs = parse_segments(text, m3u8)
        n = len(segs)
        self.seg_total[vid] = n
        self.seg_urls[vid] = list(segs)  # 供逐片缓存 bitmap 查询
        if n == 0:
            return
        self.pf_segidx[vid] = {u: i for i, u in enumerate(segs)}

        def _order(center):
            # 以播放头为中心、前后交替向外扩散的下标序（前方优先一格）。
            if 0 <= center < n:
                yield center
            for d in range(1, n):
                f, b = center + d, center - d
                if f < n:
                    yield f
                if b >= 0:
                    yield b

        # 不停地以播放头为中心、前后双向补未缓存分片；播放头一动就立刻重新居中。
        while not stop.is_set() and self.pf_active["vid"] == vid:
            center = self.playhead.get(vid, 0)
            fetched = recenter = False
            for idx in _order(center):
                if stop.is_set() or self.pf_active["vid"] != vid:
                    return  # 被切走 -> 停（已缓存的保留，回来可续）
                if self.playhead.get(vid, 0) != center:
                    recenter = True
                    break  # 播放头移动了 -> 重新居中
                s = segs[idx]
                if self.seg_cache.has((s, vid)):
                    continue
                try:
                    d, c, _ = self.pri_fetch(1, hdrs, s)
                    self.seg_cache.put((s, vid), (c or "video/mp2t", d))
                    fetched = True
                except Exception:  # noqa: BLE001
                    _log.debug("预缓存分片失败 vid=%s：%s", vid, s, exc_info=True)
            if recenter:
                continue
            if not fetched:
                # 整集都在缓存里 = 这讲预缓存完成：记进本会话完成集（供设置页「已完成」显示）。
                with self.pf_lock:
                    self.pf_done.add(vid)
                time.sleep(2.0)  # 歇会儿再巡（播放头移动/被淘汰后回补）

    def start_prefetch(self, vid, m3u8):
        with self.pf_lock:
            self.pf_active["vid"] = vid
            for ovid, (_, ev) in self.pf_threads.items():
                if ovid != vid:
                    ev.set()  # 暂停其它正在下的
            cur = self.pf_threads.get(vid)
            # 仅当线程存活且 stop-Event 未被 set 时才视为"活跃 worker"；
            # stop-Event 已 set 说明线程正在退出（如 A→B→A 快切），需重建。
            if cur and cur[0].is_alive() and not cur[1].is_set():
                return
            ev = threading.Event()  # 新的未 set Event，不能复用旧的
            t = threading.Thread(target=self._prefetch_worker, args=(vid, m3u8, ev), daemon=True)
            self.pf_threads[vid] = (t, ev)
            t.start()


def make_handler(gateway):
    """返回一个 BaseHTTPRequestHandler 子类，其 gw 指向给定 Gateway。"""

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        gw = gateway

        def log_message(self, fmt, *args):
            sys.stderr.write("[proxy] " + (fmt % args) + "\n")

        def _send_bytes(self, status, body, content_type, extra=None):
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Access-Control-Allow-Origin", "*")
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(body)

        def _send_json(self, obj, status=200):
            self._send_bytes(status, json.dumps(obj, ensure_ascii=False).encode("utf-8"),
                             "application/json; charset=utf-8")

        def do_GET(self):
            parsed = urllib.parse.urlparse(self.path)
            path = parsed.path
            qs = urllib.parse.parse_qs(parsed.query)
            if path in ("/", "/index.html"):
                self._send_bytes(200, self.gw.page.encode("utf-8"), "text/html; charset=utf-8")
            elif path in ("/hls.js", "/artplayer.js"):
                js = asset_bytes(path.lstrip("/"))
                self._send_bytes(200 if js else 502, js or b"// asset unavailable",
                                 "application/javascript; charset=utf-8")
            elif path == "/api/courses":
                self._api_courses()
            elif path == "/api/course":
                self._api_course(qs)
            elif path == "/api/watch_state":
                self._api_watch_state(qs)
            elif path == "/api/play":
                self._api_play(qs)
            elif path == "/api/thumb":
                self._api_thumb(qs)
            elif path == "/api/thumbs/status":
                self._api_thumbs_status()
            elif path == "/api/status":
                self._api_status(qs)
            elif path == "/api/buffer/segments":
                self._api_buffer_segments(qs)
            elif path.startswith("/thumbs/"):
                self._serve_thumb(path)
            elif path == "/p":
                self._proxy(qs)
            elif path == "/api/_debug":
                self._send_json({"active": self.gw.pf_active["vid"],
                                 "cacheItems": len(self.gw.seg_cache.meta),
                                 "cacheBytes": self.gw.seg_cache.size})
            else:
                self._send_bytes(404, b"not found", "text/plain")

        def do_POST(self):
            parsed = urllib.parse.urlparse(self.path)
            if parsed.path == "/api/thumbs/batch":
                self._api_thumbs_batch()
            elif parsed.path == "/api/buffer/batch":
                self._api_buffer_batch()
            elif parsed.path == "/api/tasks/action":
                self._api_tasks_action()
            elif parsed.path == "/api/cache-dir":
                self._api_set_cache_dir()
            else:
                self._send_bytes(404, b"not found", "text/plain")

        def _read_json(self):
            length = int(self.headers.get("Content-Length") or 0)
            return json.loads(self.rfile.read(length).decode("utf-8"))

        def _buffer_video(self, d):
            """缓冲用：高清地址 src。返回 (video, m3u8) 或 None。"""
            try:
                video = {"videoId": int(d["videoId"]), "contentId": int(d["contentId"]),
                         "cardPackageId": int(d["cardPackageId"]), "productId": int(d["productId"])}
            except (KeyError, ValueError, TypeError):
                return None
            src = d.get("src") or ""
            if not (isinstance(src, str) and src.startswith("https://stream.youdao.com")):
                return None
            return video, src

        def _api_buffer_batch(self):
            try:
                payload = self._read_json()
            except Exception as e:  # noqa: BLE001
                _log.debug("请求体解析失败：%s", e)
                self._send_json({"error": str(e)}, 400)
                return
            queued = skipped = 0
            for d in payload.get("videos") or []:
                bv = self._buffer_video(d)
                vid = str(d.get("videoId"))
                if not bv or self.gw.buf_state.get(vid) in ("queued", "working", "done"):
                    skipped += 1
                    continue
                self.gw.start_buffer(*bv)
                queued += 1
            self._send_json({"queued": queued, "skipped": skipped})

        def _api_tasks_action(self):
            """任务操作统一入口：{verb, kind, vid}。verb∈pause/resume/cancel/retry。
            网关侧即时复查当前状态再决策；返回操作后的最新状态（成功 200，非法转换 409）。
            prefetch（正在看那讲的自动预缓存）由播放驱动、切走自停，故只读、不接受操作。"""
            try:
                payload = self._read_json()
            except Exception as e:  # noqa: BLE001
                self._send_json({"error": str(e)}, 400)
                return
            verb = payload.get("verb")
            kind = payload.get("kind")
            vid = str(payload.get("vid") or "")
            if not vid or verb not in ("pause", "resume", "cancel", "retry"):
                self._send_json({"error": "bad params"}, 400)
                return
            if kind == "buffer":
                res = self.gw.act_buffer(vid, verb)
            elif kind == "thumb":
                if verb in ("pause", "resume"):
                    self._send_json({"error": "缩略图不支持暂停/继续"}, 400)
                    return
                res = self.gw.act_thumb(vid, verb)
            else:
                self._send_json({"error": "该任务不可操作"}, 400)
                return
            self._send_json(res, 200 if res.get("ok") else 409)

        def _api_buffer_segments(self, qs):
            """逐片缓存 bitmap（"已缓存的地方"）。可传多个 vid；用 buckets 把分片压成
            定长格子(每格=该区间已缓存占比 0..1)，无论分片多少都给定长、可上色的一条。
            没有有序分片列表(如重启后只看过一次还没复看)时 buckets=null，前端回退到比例条。"""
            vids = qs.get("vid") or qs.get("videoId") or []
            try:
                nb = int((qs.get("buckets") or ["60"])[0])
            except (ValueError, TypeError):
                nb = 60
            nb = max(1, min(nb, 400))
            snap = self.gw.seg_cache.cached_segs_by_vid()  # 一次持锁快照，避免逐 url 加锁
            stats = self.gw.seg_cache.vid_stats()["real"]
            out = {}
            for vid in vids:
                vid = str(vid)
                urls = self.gw.seg_urls.get(vid)
                disk = (stats.get(vid) or {}).get("segments", 0)
                if urls:
                    n = len(urls)
                    cset = snap.get(vid) or set()
                    flags = [1 if u in cset else 0 for u in urls]
                    cached = sum(flags)
                    b = min(nb, n)
                    cells = []
                    for i in range(b):
                        lo, hi = i * n // b, (i + 1) * n // b
                        seg = flags[lo:hi]
                        cells.append(round(sum(seg) / len(seg), 3) if seg else 0)
                    ph = self.gw.playhead.get(vid)
                    pos = (ph / n) if (ph is not None and n) else None
                    out[vid] = {"total": n, "cached": cached, "buckets": cells, "playhead": pos}
                else:
                    # 无有序列表：只能给磁盘计数与已知总数，buckets=null
                    out[vid] = {"total": self.gw.seg_total.get(vid), "cached": disk,
                                "buckets": None, "playhead": None}
            self._send_json({"segments": out})

        def _api_set_cache_dir(self):
            """设置缓存目录：校验可写 → 创建 → 持久化到 config.json（先校验后写，
            失败绝不动 config，杜绝半生效状态）。为避免热替换正在写入的 DiskLRU
            （牵涉大量在途下载与线程），改动在网关下次启动时生效；当前会话仍写旧目录。"""
            try:
                payload = self._read_json()
            except Exception as e:  # noqa: BLE001
                _log.debug("请求体解析失败：%s", e)
                self._send_json({"error": str(e)}, 400)
                return
            raw = (payload.get("dir") or "").strip()
            if not raw:
                self._send_json({"error": "缓存目录不能为空"}, 400)
                return
            d = os.path.abspath(os.path.expanduser(raw))
            try:
                os.makedirs(d, exist_ok=True)
                probe = os.path.join(d, ".ydcourse_write_test")
                with open(probe, "w", encoding="utf-8") as f:
                    f.write("ok")
                os.remove(probe)
            except OSError as e:
                self._send_json({"error": "无法写入该目录：%s" % e}, 400)
                return
            cfg = load_config()
            cfg["cacheDir"] = d
            if not save_config(cfg):
                self._send_json({"error": "保存配置失败（无法写 config.json）"}, 500)
                return
            active = self.gw.seg_cache.dir if self.gw.seg_cache.persist else ""
            self._send_json({"ok": True, "cacheDir": d, "active": active,
                             "restartRequired": d != active})

        def _api_status(self, qs):
            gw = self.gw
            with gw.thumb_lock:
                tstates = {k: v.get("state") for k, v in gw.thumb_meta.items()}
                tactive = set(gw.thumb_active)
                tsession = sorted(gw.thumb_session)  # 本会话排过队的缩略图任务
            with gw.buf_lock:
                bstates = dict(gw.buf_state)  # 一次持锁快照，避免并发遍历崩溃 + 供任务标签全量态
            with gw.pf_lock:
                pf_done = sorted(gw.pf_done)  # 本会话预缓存满的讲（供「已完成」）
            stats = gw.seg_cache.vid_stats()  # 一次遍历拿到磁盘真相
            real, thumbb = stats["real"], stats["thumb"]
            vids = qs.get("videoId") or []  # 可选：只查这些 vid 的缓冲明细
            # 关键：枚举范围 = 磁盘已缓存 ∪ 本会话已知总数 ∪ 缓冲状态。覆盖"任何来源的缓存"。
            target = ([str(v) for v in vids] if vids
                      else list(set(list(real.keys()) + list(gw.seg_total.keys()) + list(bstates.keys()))))

            def _state(vid, cached, total):
                s = bstates.get(vid)
                if s:
                    return s
                if cached <= 0:
                    return None
                if total and cached >= total:
                    return "full"
                if total:
                    return "partial"
                return "cached"  # 磁盘有片但总数未知（如重启后/观看顺带缓存）

            buffer = {}
            for vid in target:
                vid = str(vid)
                r = real.get(vid) or {}
                cached = r.get("segments", 0)
                total = gw.seg_total.get(vid)
                buffer[vid] = {"cached": cached, "total": total,
                               "state": _state(vid, cached, total),
                               "bytes": r.get("bytes", 0),
                               "thumbBytes": (thumbb.get(vid) or {}).get("bytes", 0)}
            tready = sum(1 for s in tstates.values() if s == "ready")
            tgen = [k for k, s in tstates.items() if s == "gen"]
            terr = sum(1 for s in tstates.values() if s == "error")
            self._send_json({
                "thumb": {"states": tstates, "ready": tready, "generating": tgen,
                          "working": sorted(tactive),
                          "queued_vids": [k for k in tgen if k not in tactive],
                          "queued": gw.thumb_q.qsize(), "errors": terr,
                          "session": tsession},
                "buffer": {"perVid": buffer, "bytes": gw.seg_cache.size, "limit": gw.seg_cache.max,
                           "queued": gw.buf_q.qsize(),
                           "working": [k for k, s in bstates.items() if s == "working"],
                           "queued_vids": [k for k, s in bstates.items() if s == "queued"],
                           "states": bstates},
                "live": {"active": gw.pf_active["vid"],
                         "playhead": ({gw.pf_active["vid"]: gw.playhead.get(gw.pf_active["vid"])}
                                      if gw.pf_active["vid"] else {}),
                         "done": pf_done,
                         "inFlight": {"live": gw.gate.n[0], "auto": gw.gate.n[1], "manual": gw.gate.n[2]}},
                "ffmpeg": gw.have_ffmpeg, "thumbDir": gw.thumb_dir,
                "cacheDir": gw.seg_cache.dir if gw.seg_cache.persist else "",
                "cacheDirOk": gw.seg_cache.dir_ok(),
            })

        def _thumb_video(self, d):
            """从 dict 取出生成缩略图需要的字段，返回 (video, m3u8_low, duration) 或 None。"""
            try:
                video = {"videoId": int(d["videoId"]), "contentId": int(d["contentId"]),
                         "cardPackageId": int(d["cardPackageId"]), "productId": int(d["productId"])}
            except (KeyError, ValueError, TypeError):
                return None
            src = d.get("src") or ""
            if not (isinstance(src, str) and src.startswith("https://stream.youdao.com")):
                return None
            try:
                duration = int(float(d.get("duration") or 0))
            except (ValueError, TypeError):
                duration = 0
            return video, src, duration

        def _api_thumb(self, qs):
            vid = (qs.get("videoId") or [None])[0]
            if not vid:
                self._send_json({"state": "error", "reason": "no videoId"}, 400)
                return
            with self.gw.thumb_lock:
                st = self.gw.thumb_meta.get(vid)
            if st and st["state"] in ("ready", "gen", "error"):
                self._send_json(st)
                return
            parsed = {k: (v[0] if v else None) for k, v in qs.items()}
            tv = self._thumb_video(parsed)
            if not tv:
                self._send_json({"state": "error", "reason": "need ids+src"}, 400)
                return
            self._send_json(self.gw.start_thumbs(*tv, tier=1))  # 播放时自动触发 → AUTO

        def _api_thumbs_batch(self):
            try:
                length = int(self.headers.get("Content-Length") or 0)
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
            except Exception as e:  # noqa: BLE001
                _log.debug("缩略图批量请求体解析失败：%s", e)
                self._send_json({"error": str(e)}, 400)
                return
            queued = skipped = 0
            for d in payload.get("videos") or []:
                with self.gw.thumb_lock:
                    st = self.gw.thumb_meta.get(str(d.get("videoId")))
                if st and st["state"] in ("ready", "gen"):
                    skipped += 1
                    continue
                tv = self._thumb_video(d)
                if tv:
                    self.gw.start_thumbs(*tv, tier=2)  # 手动批量 → MANUAL
                    queued += 1
                else:
                    skipped += 1
            self._send_json({"queued": queued, "skipped": skipped})

        def _api_thumbs_status(self):
            with self.gw.thumb_lock:
                states = {k: v.get("state") for k, v in self.gw.thumb_meta.items()}
            ready = [k for k, s in states.items() if s == "ready"]
            generating = [k for k, s in states.items() if s == "gen"]
            errored = [k for k, s in states.items() if s == "error"]
            nbytes = 0
            try:
                for n in os.listdir(self.gw.thumb_dir):
                    if n.endswith(".jpg"):
                        nbytes += os.path.getsize(os.path.join(self.gw.thumb_dir, n))
            except OSError:
                pass
            self._send_json({
                "states": states, "readyCount": len(ready),
                "generating": generating, "queued": self.gw.thumb_q.qsize(),
                "errorCount": len(errored), "ffmpeg": self.gw.have_ffmpeg,
                "dir": self.gw.thumb_dir, "bytes": nbytes,
            })

        def _serve_thumb(self, path):
            name = os.path.basename(path)
            fpath = os.path.join(self.gw.thumb_dir, name)
            if not os.path.isfile(fpath):
                self._send_bytes(404, b"not found", "text/plain")
                return
            with open(fpath, "rb") as f:
                self._send_bytes(200, f.read(), "image/jpeg",
                                 {"Cache-Control": "max-age=3600"})

        def _api_courses(self):
            try:
                prods = list_products(self.gw.session)
            except Exception as e:  # noqa: BLE001
                _log.warning("拉取课程列表失败（会话过期？）", exc_info=True)
                self._send_json({"error": str(e)}, 502)
                return
            courses = [{
                "id": p.get("id"), "name": p.get("name"),
                "cardType": p.get("cardType"),
                "authors": [a.get("name") if isinstance(a, dict) else a
                            for a in (p.get("authors") or [])],
            } for p in prods]
            self._send_json({"courses": courses})

        def _api_course(self, qs):
            pid = (qs.get("productId") or [None])[0]
            if not pid:
                self._send_json({"error": "missing productId"}, 400)
                return
            try:
                self._send_json({"videos": get_product_videos(self.gw.session, pid)})
            except Exception as e:  # noqa: BLE001
                _log.warning("拉取课程视频失败 productId=%s", pid, exc_info=True)
                self._send_json({"error": str(e)}, 502)

        def _api_watch_state(self, qs):
            pid = (qs.get("productId") or [None])[0]
            if not pid:
                self._send_json({"error": "missing productId"}, 400)
                return
            try:
                self._send_json({"watch": get_product_watch_state(self.gw.session, pid)})
            except Exception as e:  # noqa: BLE001
                _log.warning("拉取观看状态失败 productId=%s", pid, exc_info=True)
                self._send_json({"error": str(e)}, 502)

        def _api_play(self, qs):
            try:
                video = {
                    "videoId": int(qs["videoId"][0]),
                    "contentId": int(qs["contentId"][0]),
                    "cardPackageId": int(qs["cardPackageId"][0]),
                    "productId": int(qs["productId"][0]),
                }
            except (KeyError, ValueError):
                self._send_json({"error": "bad params"}, 400)
                return
            live_id = (qs.get("liveId") or [None])[0]  # 直播回放才有；用于 Liveid 解密头
            if live_id:
                video["liveId"] = live_id
            m3u8 = (qs.get("m3u8") or [None])[0] or resolve_m3u8(self.gw.session, video)
            if not m3u8:
                self._send_json({"error": "no m3u8 (locked?)"}, 502)
                return
            vid = str(video["videoId"])
            hdrs = play_headers(self.gw.session, video, m3u8)
            with self.gw.vh_lock:
                self.gw.video_headers[vid] = hdrs
            # 当前在看的这集设为缓存"保护集"：顶到上限淘汰时最后才动它（防被挤出）。
            self.gw.seg_cache.set_protect_vid(vid)
            if self.gw.prefetch:
                self.gw.start_prefetch(vid, m3u8)  # 后台整集预缓存；切走会自动暂停
            self._send_json({"url": proxify(m3u8, video["videoId"]), "m3u8": m3u8})

        def _fetch_upstream(self, target, vid, range_header=None):
            with self.gw.vh_lock:
                hdrs = self.gw.video_headers.get(vid, self.gw.base_headers) if vid else self.gw.base_headers
            # 观看路径的回源 = 最高档 LIVE(0)：压过一切后台缓存。
            return self.gw.pri_fetch(0, hdrs, target, range_header)

        def _proxy(self, qs):
            if "u" not in qs:
                self._send_bytes(400, b"missing u", "text/plain")
                return
            target = qs["u"][0]
            vid = (qs.get("vid") or [None])[0]

            # 记录播放头：把这次直播分片请求映射到下标，预缓存据此向两边扩散。
            # （密钥/缩略图等不在 pf_segidx 里，pos 为 None，自然不影响。）
            si = self.gw.pf_segidx.get(vid)
            if si is not None:
                pos = si.get(target)
                if pos is not None:
                    self.gw.playhead[vid] = pos

            # m3u8 播放列表：不缓存，取来改写
            if looks_like_m3u8(target, ""):
                try:
                    data, _, _ = self._fetch_upstream(target, vid)
                except Exception as e:  # noqa: BLE001
                    _log.warning("取播放列表失败（会话过期？）：%s", target, exc_info=True)
                    self._send_bytes(502, str(e).encode("utf-8"), "text/plain")
                    return
                text = data.decode("utf-8", "replace")
                # 观看路径顺带记下分片顺序：仅媒体播放列表(#EXTINF)，避免把 master 的子列表当分片。
                if vid and "#EXTINF" in text:
                    segs = parse_segments(text, target)
                    if segs:
                        self.gw.seg_urls[vid] = segs
                        self.gw.seg_total[vid] = len(segs)
                rewritten = rewrite_m3u8(text, target, vid)
                self._send_bytes(200, rewritten.encode("utf-8"),
                                 "application/vnd.apple.mpegurl")
                return

            # 分片 / 密钥：整段缓存，拖动到看过的位置秒开；并支持 Range（Safari 原生拖动）
            ck = (target, vid)
            cached = self.gw.seg_cache.get(ck)
            if cached is None:
                try:
                    data, ctype, _ = self._fetch_upstream(target, vid)
                except urllib.error.HTTPError as e:
                    self._send_bytes(e.code, e.read() or b"",
                                     e.headers.get("Content-Type", "text/plain"))
                    return
                except Exception as e:  # noqa: BLE001
                    _log.debug("取分片失败：%s", target, exc_info=True)
                    self._send_bytes(502, str(e).encode("utf-8"), "text/plain")
                    return
                ctype = ctype or "application/octet-stream"
                self.gw.seg_cache.put(ck, (ctype, data))
            else:
                ctype, data = cached

            self._serve_blob(data, ctype, self.headers.get("Range"))

        def _serve_blob(self, data, ctype, range_header):
            total = len(data)
            try:
                rng = parse_range(range_header, total)
            except UnsatisfiableRange:
                # RFC 7233 §4.4：Range 不可满足，返回 416 + Content-Range: bytes */total
                self._send_bytes(416, b"", ctype, {
                    "Accept-Ranges": "bytes",
                    "Content-Range": "bytes */%d" % total,
                })
                return
            if rng is None:
                self._send_bytes(200, data, ctype, {"Accept-Ranges": "bytes"})
                return
            start, end = rng
            self._send_bytes(206, data[start:end + 1], ctype, {
                "Accept-Ranges": "bytes",
                "Content-Range": "bytes %d-%d/%d" % (start, end, total),
            })

    return Handler


class _QuietServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def handle_error(self, request, client_address):
        # 播放器/ffmpeg 提前断开连接很正常，不刷栈
        if sys.exc_info()[0] in (ConnectionResetError, BrokenPipeError):
            return
        super().handle_error(request, client_address)


def start_proxy(headers, port, default_url="", session=None, auto=None,
                prefetch=True, cache_bytes=SEG_CACHE_BYTES, cache_dir=None):
    gateway = Gateway(headers, session=session, auto=auto, prefetch=prefetch,
                      cache_bytes=cache_bytes, port=port, cache_dir=cache_dir)
    server = _QuietServer(("127.0.0.1", port), make_handler(gateway))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server
