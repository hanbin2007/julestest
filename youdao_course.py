#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
youdao_course.py
================
把有道听课客户端抓到的加密 HLS 流，变成可以在浏览器 / 任意播放器里看的视频。

原理
----
有道的课程是 AES-128 加密的 HLS（一个 .m3u8 播放列表 + 一堆 .ts 分片，路径里带
"/encrypt/"）。stream.youdao.com 只在请求带上那一串鉴权头时才返回内容：
    Cookie / Imei / Productid / Videoid / Cardpackageid / Cardpackagecontentid /
    Keyfrom / Referer / User-Agent ...
普通浏览器请求因为缺这些头会被拒。

本脚本起一个本地代理：浏览器里的 hls.js / Safari，或者 ffmpeg，只跟本地代理打交道；
代理负责补齐这些头、把 m3u8 里的分片/密钥地址改写成走代理、再转发上游响应。
解密用的 key 也通过代理拿（带头），所以 hls.js / ffmpeg 能正常解密。

用法
----
1) 在抓包工具里复制那条 .m3u8 请求的“原文/raw”，存成 req.txt
2) 浏览器在线看：
       python3 youdao_course.py serve --request req.txt
   打开 http://127.0.0.1:8808 ，把 m3u8 地址粘进去就能放（支持倍速 / 拖进度）。
3) 下载成 mp4（需要本机有 ffmpeg：brew install ffmpeg）：
       python3 youdao_course.py download --request req.txt \
           --url 'https://stream.youdao.com/.../xxx.m3u8' -o 课程.mp4
   不传 --url 时会用 req.txt 里那条请求自己的地址。

说明：仅用于观看你自己已购买 / 有权访问的课程，请遵守平台条款。会话(Cookie 等)会过期，
过期后重新抓一条请求覆盖 req.txt 即可。
"""

import argparse
import concurrent.futures
import json
import os
import queue
import re
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from ydcore.cache import DiskLRU as _DiskLRU, SEG_CACHE_BYTES
from ydcore.hls import (
    parse_range as _parse_range,
    proxify as _proxify,
    rewrite_m3u8,
    looks_like_m3u8 as _looks_like_m3u8,
    parse_segments,
)
from ydcore.httpio import parse_request
from ydcore.util import which as _which
from ydcore.priority import PriorityGate
from ydcore.appconfig import load_config, save_config, resolve_cache_dir
from ydcore.youdao_api import (
    list_products, get_product_videos, get_product_watch_state,
    resolve_m3u8, play_headers, find_video,
)


_WEB_UI_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ydcore", "web_ui")


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
    """本地代理自带前端依赖（hls.js / artplayer.js），首次从 CDN 取一次并缓存。"""
    if name not in _ASSET_CACHE:
        try:
            req = urllib.request.Request(_ASSET_CDN[name],
                                         headers={"User-Agent": "youdao_course"})
            with urllib.request.urlopen(req, timeout=30) as r:
                _ASSET_CACHE[name] = r.read()
        except Exception:  # noqa: BLE001
            _ASSET_CACHE[name] = b""
    return _ASSET_CACHE[name]


# 缩略图雪碧图参数
THUMB_INTERVAL = 10   # 每 10 秒一帧
THUMB_W = 160
THUMB_H = 90
THUMB_COLS = 10
# 缩略图持久化目录（生成后不删，跨会话复用）
THUMB_DIR = os.path.join(os.path.expanduser("~"), ".youdao_course", "thumbs")
THUMB_WORKERS = 3


def make_handler(base_headers, default_url="", session=None, auto=None,
                 prefetch=True, cache_bytes=SEG_CACHE_BYTES, port=8808,
                 cache_dir=None):
    session = session if session is not None else base_headers
    page = APP_HTML.replace("__AUTO__", json.dumps(auto) if auto else "null")
    video_headers = {}
    vh_lock = threading.Lock()
    seg_cache = _DiskLRU(cache_bytes, cache_dir)

    # 三档优先级闸门：0=LIVE(观看) > 1=AUTO(自动缓存) > 2=MANUAL(手动缓存)。见 ydcore.priority。
    _gate = PriorityGate()
    _pri_n = _gate.n            # /api/status 暴露各档在途数（与闸门同一 dict 引用）
    pri_fetch = _gate.fetch

    # 缩略图雪碧图：服务端用 ffmpeg 生成（复用已缓存分片），供 Artplayer 拖动预览。
    # 持久化到 ~/.youdao_course/thumbs，生成后不删，跨会话复用。
    thumb_dir = THUMB_DIR
    os.makedirs(thumb_dir, exist_ok=True)
    thumb_index_path = os.path.join(thumb_dir, "index.json")
    thumb_meta = {}  # vid -> {"state": "gen"/"ready"/"error", ...}
    thumb_active = set()  # 真正在 ffmpeg 生成中的 vid（区分“生成中”与“排队中”）
    thumb_lock = threading.Lock()
    thumb_q = queue.Queue()
    have_ffmpeg = _which("ffmpeg") is not None
    try:
        with open(thumb_index_path, "r", encoding="utf-8") as f:
            for vid, m in (json.load(f) or {}).items():
                if os.path.exists(os.path.join(thumb_dir, "%s.jpg" % vid)):
                    thumb_meta[vid] = m
    except Exception:  # noqa: BLE001
        pass

    def _save_index():
        with thumb_lock:
            snap = {k: v for k, v in thumb_meta.items() if v.get("state") == "ready"}
        try:
            with open(thumb_index_path, "w", encoding="utf-8") as f:
                json.dump(snap, f)
        except Exception:  # noqa: BLE001
            pass

    def _thumb_worker():
        while True:
            vid, m3u8, duration, tier = thumb_q.get()
            with thumb_lock:
                thumb_active.add(vid)
            try:
                _gen_thumbs(vid, m3u8, duration, tier)
            except Exception as e:  # noqa: BLE001
                with thumb_lock:
                    thumb_meta[vid] = {"state": "error", "reason": str(e)}
            finally:
                with thumb_lock:
                    thumb_active.discard(vid)
                thumb_q.task_done()

    def _gen_thumbs(vid, m3u8, duration, tier):
        if duration <= 0:
            duration = 600
        number = max(1, int(duration // THUMB_INTERVAL))
        rows = (number + THUMB_COLS - 1) // THUMB_COLS
        out = os.path.join(thumb_dir, "%s.jpg" % vid)
        tvid = "t_" + vid  # 缩略图用低清流自己的 Url 头（key 按清晰度绑定）
        with vh_lock:
            th = dict(video_headers.get(tvid) or {})
        if not th:
            with thumb_lock:
                thumb_meta[vid] = {"state": "error", "reason": "no headers"}
            return
        # 先按档位把低清分片+密钥灌进缓存，ffmpeg 再顺序读缓存就很快
        try:
            pl, _, _ = pri_fetch(tier, th, m3u8)
            text = pl.decode("utf-8", "replace")
            urls = [urllib.parse.urljoin(m3u8, ln.strip())
                    for ln in text.splitlines() if ln.strip() and not ln.startswith("#")]
            for ln in text.splitlines():
                if ln.startswith("#EXT-X-KEY") and 'URI="' in ln:
                    urls.insert(0, urllib.parse.urljoin(m3u8, re.search(r'URI="([^"]+)"', ln).group(1)))

            def _grab(u):
                if seg_cache.has((u, tvid)):
                    return
                try:
                    d, c, _ = pri_fetch(tier, th, u)
                    seg_cache.put((u, tvid), (c or "video/mp2t", d))
                except Exception:  # noqa: BLE001
                    pass
            # 并发收紧到 1：受限下行下，高档抢占时不可取消的在途下载越少越好。
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as ex:
                list(ex.map(_grab, urls))
        except Exception:  # noqa: BLE001
            pass
        proxied = "http://127.0.0.1:%d/p?u=%s&vid=%s" % (
            port, urllib.parse.quote(m3u8, safe=""), tvid)
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
        rc = subprocess.call(cmd)
        if rc == 0 and os.path.exists(out):
            with thumb_lock:
                thumb_meta[vid] = {"state": "ready", "url": "/thumbs/%s.jpg" % vid,
                                   "number": number, "column": THUMB_COLS,
                                   "width": THUMB_W, "height": THUMB_H}
            _save_index()
        else:
            with thumb_lock:
                thumb_meta[vid] = {"state": "error", "reason": "ffmpeg rc=%d" % rc}

    def start_thumbs(video, m3u8, duration, tier=2):
        """video: {videoId,contentId,cardPackageId,productId}; m3u8: 低清地址。
        tier: 播放时自动触发=1(AUTO)，手动批量=2(MANUAL)。"""
        vid = str(video["videoId"])
        if not have_ffmpeg:
            return {"state": "error", "reason": "no ffmpeg"}
        with thumb_lock:
            st = thumb_meta.get(vid)
            if st and st["state"] in ("ready", "gen"):
                return st
            thumb_meta[vid] = {"state": "gen"}
        with vh_lock:
            video_headers["t_" + vid] = play_headers(session, video, m3u8)
        thumb_q.put((vid, m3u8, duration, tier))
        return {"state": "gen"}

    for _ in range(max(1, THUMB_WORKERS)):
        threading.Thread(target=_thumb_worker, daemon=True).start()

    # 整集缓冲（把整节课分片下到服务端磁盘缓存）：批量预缓冲 + 状态
    seg_total = {}        # vid -> 总分片数（已知时）
    seg_urls = {}         # vid -> 按播放顺序的分片绝对地址列表（任何来源解析到 m3u8 时填充）
    buf_state = {}        # vid -> "queued"/"working"/"done"/"error"
    buf_lock = threading.Lock()
    buf_q = queue.Queue()

    def _buffer_one(video, m3u8):
        # 手动缓存（MANUAL，档 2）：让位给观看(0)和自动缓存(1)。注意：要和自动缓存
        # 合并到同一集，二者须用同一清晰度——目前前端 pickM3u8/MK_BUF 与播放都取最高清，
        # key 同为 (seg_url, vid) 故天然合并；若改播放器清晰度选择，需同步前端取值。
        vid = str(video["videoId"])
        th = play_headers(session, video, m3u8)
        with vh_lock:
            video_headers[vid] = th
        pl, _, _ = pri_fetch(2, th, m3u8)
        text = pl.decode("utf-8", "replace")
        segs = parse_segments(text, m3u8)
        seg_total[vid] = len(segs)
        seg_urls[vid] = list(segs)  # 供逐片缓存 bitmap 查询
        urls = list(segs)
        for ln in text.splitlines():
            if ln.startswith("#EXT-X-KEY") and 'URI="' in ln:
                urls.insert(0, urllib.parse.urljoin(m3u8, re.search(r'URI="([^"]+)"', ln).group(1)))

        def _grab(u):
            if seg_cache.has((u, vid)):
                return
            try:
                d, c, _ = pri_fetch(2, th, u)
                seg_cache.put((u, vid), (c or "video/mp2t", d))  # 每片下完即可被播放器命中
            except Exception:  # noqa: BLE001
                pass
        # 并发收紧到 1：手动缓存最低优先，抢占时在途下载越少观看越稳。
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as ex:
            list(ex.map(_grab, urls))

    def _buffer_worker():
        while True:
            video, m3u8 = buf_q.get()
            vid = str(video["videoId"])
            with buf_lock:
                buf_state[vid] = "working"
            try:
                _buffer_one(video, m3u8)
                with buf_lock:
                    buf_state[vid] = "done"
            except Exception:  # noqa: BLE001
                with buf_lock:
                    buf_state[vid] = "error"
            finally:
                buf_q.task_done()

    def start_buffer(video, m3u8):
        vid = str(video["videoId"])
        with buf_lock:
            if buf_state.get(vid) in ("queued", "working"):
                return
            buf_state[vid] = "queued"
        buf_q.put((video, m3u8))

    # 单工作线程 = 严格 FIFO 队列、一次缓一集；手动最低优先，越不抢越好。
    threading.Thread(target=_buffer_worker, daemon=True).start()

    # 自动缓存（AUTO，档 1）：以“播放头”为中心、向前后双向不停补未缓存的分片（缓一点用
    # 一点）。让位给观看(0)、压过手动(1>2)；已缓存的不删除非顶到 LRU 上限。切走的那节自动暂停。
    pf_lock = threading.Lock()
    pf_active = {"vid": None}
    pf_threads = {}   # vid -> (thread, stop_event)
    pf_segidx = {}    # vid -> {seg_url: index}（把直播请求映射到播放头下标）
    playhead = {}     # vid -> 最近一次直播请求到的分片下标（预缓存以它为中心扩散）

    def _prefetch_worker(vid, m3u8, stop):
        hdrs = video_headers.get(vid)
        if not hdrs:
            return
        try:
            data, _, _ = pri_fetch(1, hdrs, m3u8)
        except Exception:  # noqa: BLE001
            return
        text = data.decode("utf-8", "replace")
        # 先把密钥缓存好
        for line in text.splitlines():
            if line.startswith("#EXT-X-KEY") and 'URI="' in line:
                kabs = urllib.parse.urljoin(m3u8, re.search(r'URI="([^"]+)"', line).group(1))
                if not seg_cache.has((kabs, vid)):
                    try:
                        kd, kc, _ = pri_fetch(1, hdrs, kabs)
                        seg_cache.put((kabs, vid), (kc or "application/octet-stream", kd))
                    except Exception:  # noqa: BLE001
                        pass
        segs = parse_segments(text, m3u8)
        n = len(segs)
        seg_total[vid] = n
        seg_urls[vid] = list(segs)  # 供逐片缓存 bitmap 查询
        if n == 0:
            return
        pf_segidx[vid] = {u: i for i, u in enumerate(segs)}

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
        while not stop.is_set() and pf_active["vid"] == vid:
            center = playhead.get(vid, 0)
            fetched = recenter = False
            for idx in _order(center):
                if stop.is_set() or pf_active["vid"] != vid:
                    return  # 被切走 -> 停（已缓存的保留，回来可续）
                if playhead.get(vid, 0) != center:
                    recenter = True
                    break  # 播放头移动了 -> 重新居中
                s = segs[idx]
                if seg_cache.has((s, vid)):
                    continue
                try:
                    d, c, _ = pri_fetch(1, hdrs, s)
                    seg_cache.put((s, vid), (c or "video/mp2t", d))
                    fetched = True
                except Exception:  # noqa: BLE001
                    pass
            if recenter:
                continue
            if not fetched:
                time.sleep(2.0)  # 整集已在缓存里，歇会儿再巡（播放头移动/被淘汰后回补）

    def start_prefetch(vid, m3u8):
        with pf_lock:
            pf_active["vid"] = vid
            for ovid, (_, ev) in pf_threads.items():
                if ovid != vid:
                    ev.set()  # 暂停其它正在下的
            cur = pf_threads.get(vid)
            if cur and cur[0].is_alive():
                return
            ev = threading.Event()
            t = threading.Thread(target=_prefetch_worker, args=(vid, m3u8, ev), daemon=True)
            pf_threads[vid] = (t, ev)
            t.start()

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

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
                self._send_bytes(200, page.encode("utf-8"), "text/html; charset=utf-8")
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
                self._send_json({"active": pf_active["vid"],
                                 "cacheItems": len(seg_cache.meta),
                                 "cacheBytes": seg_cache.size})
            else:
                self._send_bytes(404, b"not found", "text/plain")

        def do_POST(self):
            parsed = urllib.parse.urlparse(self.path)
            if parsed.path == "/api/thumbs/batch":
                self._api_thumbs_batch()
            elif parsed.path == "/api/buffer/batch":
                self._api_buffer_batch()
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
                self._send_json({"error": str(e)}, 400)
                return
            queued = skipped = 0
            for d in payload.get("videos") or []:
                bv = self._buffer_video(d)
                vid = str(d.get("videoId"))
                if not bv or buf_state.get(vid) in ("queued", "working", "done"):
                    skipped += 1
                    continue
                start_buffer(*bv)
                queued += 1
            self._send_json({"queued": queued, "skipped": skipped})

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
            snap = seg_cache.cached_segs_by_vid()  # 一次持锁快照，避免逐 url 加锁
            stats = seg_cache.vid_stats()["real"]
            out = {}
            for vid in vids:
                vid = str(vid)
                urls = seg_urls.get(vid)
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
                    ph = playhead.get(vid)
                    pos = (ph / n) if (ph is not None and n) else None
                    out[vid] = {"total": n, "cached": cached, "buckets": cells, "playhead": pos}
                else:
                    # 无有序列表：只能给磁盘计数与已知总数，buckets=null
                    out[vid] = {"total": seg_total.get(vid), "cached": disk,
                                "buckets": None, "playhead": None}
            self._send_json({"segments": out})

        def _api_set_cache_dir(self):
            """设置缓存目录：校验可写 → 创建 → 持久化到 config.json（先校验后写，
            失败绝不动 config，杜绝半生效状态）。为避免热替换正在写入的 _DiskLRU
            （牵涉大量在途下载与线程），改动在网关下次启动时生效；当前会话仍写旧目录。"""
            try:
                payload = self._read_json()
            except Exception as e:  # noqa: BLE001
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
            active = seg_cache.dir if seg_cache.persist else ""
            self._send_json({"ok": True, "cacheDir": d, "active": active,
                             "restartRequired": d != active})

        def _api_status(self, qs):
            with thumb_lock:
                tstates = {k: v.get("state") for k, v in thumb_meta.items()}
                tactive = set(thumb_active)
            stats = seg_cache.vid_stats()  # 一次遍历拿到磁盘真相（含上次会话/观看/预缓存留下的）
            real, thumbb = stats["real"], stats["thumb"]
            vids = qs.get("videoId") or []  # 可选：只查这些 vid 的缓冲明细
            # 关键：枚举范围 = 磁盘已缓存 ∪ 本会话已知总数 ∪ 缓冲状态。覆盖“任何来源的缓存”。
            target = ([str(v) for v in vids] if vids
                      else list(set(list(real.keys()) + list(seg_total.keys()) + list(buf_state.keys()))))

            def _state(vid, cached, total):
                s = buf_state.get(vid)
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
                total = seg_total.get(vid)
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
                          "queued": thumb_q.qsize(), "errors": terr},
                "buffer": {"perVid": buffer, "bytes": seg_cache.size, "limit": seg_cache.max,
                           "queued": buf_q.qsize(),
                           "working": [k for k, s in buf_state.items() if s == "working"],
                           "queued_vids": [k for k, s in buf_state.items() if s == "queued"]},
                "live": {"active": pf_active["vid"],
                         "playhead": ({pf_active["vid"]: playhead.get(pf_active["vid"])}
                                      if pf_active["vid"] else {}),
                         "inFlight": {"live": _pri_n[0], "auto": _pri_n[1], "manual": _pri_n[2]}},
                "ffmpeg": have_ffmpeg, "thumbDir": thumb_dir,
                "cacheDir": seg_cache.dir if seg_cache.persist else "",
                "cacheDirOk": seg_cache.dir_ok(),
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
            with thumb_lock:
                st = thumb_meta.get(vid)
            if st and st["state"] in ("ready", "gen", "error"):
                self._send_json(st)
                return
            parsed = {k: (v[0] if v else None) for k, v in qs.items()}
            tv = self._thumb_video(parsed)
            if not tv:
                self._send_json({"state": "error", "reason": "need ids+src"}, 400)
                return
            self._send_json(start_thumbs(*tv, tier=1))  # 播放时自动触发 → AUTO

        def _api_thumbs_batch(self):
            try:
                length = int(self.headers.get("Content-Length") or 0)
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
            except Exception as e:  # noqa: BLE001
                self._send_json({"error": str(e)}, 400)
                return
            queued = skipped = 0
            for d in payload.get("videos") or []:
                with thumb_lock:
                    st = thumb_meta.get(str(d.get("videoId")))
                if st and st["state"] in ("ready", "gen"):
                    skipped += 1
                    continue
                tv = self._thumb_video(d)
                if tv:
                    start_thumbs(*tv, tier=2)  # 手动批量 → MANUAL
                    queued += 1
                else:
                    skipped += 1
            self._send_json({"queued": queued, "skipped": skipped})

        def _api_thumbs_status(self):
            with thumb_lock:
                states = {k: v.get("state") for k, v in thumb_meta.items()}
            ready = [k for k, s in states.items() if s == "ready"]
            generating = [k for k, s in states.items() if s == "gen"]
            errored = [k for k, s in states.items() if s == "error"]
            nbytes = 0
            try:
                for n in os.listdir(thumb_dir):
                    if n.endswith(".jpg"):
                        nbytes += os.path.getsize(os.path.join(thumb_dir, n))
            except OSError:
                pass
            self._send_json({
                "states": states, "readyCount": len(ready),
                "generating": generating, "queued": thumb_q.qsize(),
                "errorCount": len(errored), "ffmpeg": have_ffmpeg,
                "dir": thumb_dir, "bytes": nbytes,
            })

        def _serve_thumb(self, path):
            name = os.path.basename(path)
            fpath = os.path.join(thumb_dir, name)
            if not os.path.isfile(fpath):
                self._send_bytes(404, b"not found", "text/plain")
                return
            with open(fpath, "rb") as f:
                self._send_bytes(200, f.read(), "image/jpeg",
                                 {"Cache-Control": "max-age=3600"})

        def _api_courses(self):
            try:
                prods = list_products(session)
            except Exception as e:  # noqa: BLE001
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
                self._send_json({"videos": get_product_videos(session, pid)})
            except Exception as e:  # noqa: BLE001
                self._send_json({"error": str(e)}, 502)

        def _api_watch_state(self, qs):
            pid = (qs.get("productId") or [None])[0]
            if not pid:
                self._send_json({"error": "missing productId"}, 400)
                return
            try:
                self._send_json({"watch": get_product_watch_state(session, pid)})
            except Exception as e:  # noqa: BLE001
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
            m3u8 = (qs.get("m3u8") or [None])[0] or resolve_m3u8(session, video)
            if not m3u8:
                self._send_json({"error": "no m3u8 (locked?)"}, 502)
                return
            vid = str(video["videoId"])
            hdrs = play_headers(session, video, m3u8)
            with vh_lock:
                video_headers[vid] = hdrs
            # 当前在看的这集设为缓存“保护集”：顶到上限淘汰时最后才动它（防被挤出）。
            seg_cache.set_protect_vid(vid)
            if prefetch:
                start_prefetch(vid, m3u8)  # 后台整集预缓存；切走会自动暂停
            self._send_json({"url": _proxify(m3u8, video["videoId"]), "m3u8": m3u8})

        def _fetch_upstream(self, target, vid, range_header=None):
            with vh_lock:
                hdrs = video_headers.get(vid, base_headers) if vid else base_headers
            # 观看路径的回源 = 最高档 LIVE(0)：压过一切后台缓存。
            return pri_fetch(0, hdrs, target, range_header)

        def _proxy(self, qs):
            if "u" not in qs:
                self._send_bytes(400, b"missing u", "text/plain")
                return
            target = qs["u"][0]
            vid = (qs.get("vid") or [None])[0]

            # 记录播放头：把这次直播分片请求映射到下标，预缓存据此向两边扩散。
            # （密钥/缩略图等不在 pf_segidx 里，pos 为 None，自然不影响。）
            si = pf_segidx.get(vid)
            if si is not None:
                pos = si.get(target)
                if pos is not None:
                    playhead[vid] = pos

            # m3u8 播放列表：不缓存，取来改写
            if _looks_like_m3u8(target, ""):
                try:
                    data, _, _ = self._fetch_upstream(target, vid)
                except Exception as e:  # noqa: BLE001
                    self._send_bytes(502, str(e).encode("utf-8"), "text/plain")
                    return
                text = data.decode("utf-8", "replace")
                # 观看路径顺带记下分片顺序：仅媒体播放列表(#EXTINF)，避免把 master 的子列表当分片。
                if vid and "#EXTINF" in text:
                    segs = parse_segments(text, target)
                    if segs:
                        seg_urls[vid] = segs
                        seg_total[vid] = len(segs)
                rewritten = rewrite_m3u8(text, target, vid)
                self._send_bytes(200, rewritten.encode("utf-8"),
                                 "application/vnd.apple.mpegurl")
                return

            # 分片 / 密钥：整段缓存，拖动到看过的位置秒开；并支持 Range（Safari 原生拖动）
            ck = (target, vid)
            cached = seg_cache.get(ck)
            if cached is None:
                try:
                    data, ctype, _ = self._fetch_upstream(target, vid)
                except urllib.error.HTTPError as e:
                    self._send_bytes(e.code, e.read() or b"",
                                     e.headers.get("Content-Type", "text/plain"))
                    return
                except Exception as e:  # noqa: BLE001
                    self._send_bytes(502, str(e).encode("utf-8"), "text/plain")
                    return
                ctype = ctype or "application/octet-stream"
                seg_cache.put(ck, (ctype, data))
            else:
                ctype, data = cached

            self._serve_blob(data, ctype, self.headers.get("Range"))

        def _serve_blob(self, data, ctype, range_header):
            total = len(data)
            rng = _parse_range(range_header, total)
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
    server = _QuietServer(("127.0.0.1", port),
                          make_handler(headers, default_url, session, auto,
                                       prefetch, cache_bytes, port, cache_dir))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


def load_session(args):
    if args.request:
        with open(args.request, "r", encoding="utf-8", errors="replace") as f:
            text = f.read()
    elif not sys.stdin.isatty():
        text = sys.stdin.read()
    else:
        raise SystemExit("请用 --request <文件> 指定抓包原文，或从标准输入管道传入。")
    url, headers = parse_request(text)
    return url, headers


def cmd_parse(args):
    url, headers = load_session(args)
    print("URL :", url)
    print("Headers:")
    for k, v in headers.items():
        if k.lower() == "cookie" and len(v) > 60:
            v = v[:57] + "..."
        print("  %s: %s" % (k, v))


def cmd_list(args):
    _, session = load_session(args)
    prods = list_products(session)
    print("共 %d 门课：\n" % len(prods))
    for prod in prods:
        vids = []
        try:
            vids = get_product_videos(session, prod["id"])
        except Exception as e:  # noqa: BLE001
            print("== [%s] %s  (读取失败: %s)" % (prod["id"], prod.get("name"), e))
            continue
        print("== [product %s] %s  —— %d 个视频" %
              (prod["id"], prod.get("name"), len(vids)))
        for v in vids:
            lock = "🔒未解锁" if v["locked"] else "可看"
            print("   video %-7s %-4s %s / %s" %
                  (v["videoId"], lock, v.get("examKey") or "", v.get("title") or ""))
        print()
    print("播放某个：python3 youdao_course.py serve -r %s --video <videoId>"
          % (args.request or "req.txt"))


def _resolve_video(args, session):
    print("正在按 videoId=%s 查找视频……" % args.video)
    v = find_video(session, args.video)
    if not v:
        raise SystemExit("没找到 videoId=%s（确认它在你的已购课程里）。" % args.video)
    if v["locked"]:
        print("注意：该视频在 App 里显示未解锁，可能取不到地址。")
    m3u8 = resolve_m3u8(session, v)
    if not m3u8:
        raise SystemExit("拿不到该视频的 m3u8 地址（可能未解锁）。")
    print("找到：%s / %s" % (v.get("productName"), v.get("title")))
    return play_headers(session, v, m3u8), m3u8


def cmd_serve(args):
    _, session = load_session(args)
    auto = None
    if getattr(args, "video", None):
        print("正在定位 videoId=%s 以便自动播放……" % args.video)
        v = find_video(session, args.video)
        if v:
            auto = {"productId": v["productId"], "videoId": v["videoId"]}
        else:
            print("没找到该 videoId，将正常打开课程列表。")
    prefetch = not args.no_prefetch
    # 让 kill(SIGTERM) 也走 KeyboardInterrupt 优雅退出路径，从而触发 index 落盘。
    signal.signal(signal.SIGTERM, signal.default_int_handler)
    cache_dir, cache_dir_ok = resolve_cache_dir(args.cache_dir)
    server = start_proxy(session, args.port, "", session, auto,
                         prefetch, args.cache_mb * 1024 * 1024, cache_dir)
    print("课程网页已启动： http://127.0.0.1:%d" % args.port)
    print("左侧选课、选讲即可播放，支持搜索 / 倍速 / 上下一讲。Ctrl-C 退出。")
    if cache_dir_ok:
        print("缓存持久化目录：%s（重启不清，上限 %d MB，到顶按 LRU 淘汰）"
              % (cache_dir, args.cache_mb))
    else:
        print("⚠ 缓存目录不可用：%s —— 缓存已停用，请在网页「设置」中修正后重启网关。"
              % cache_dir)
    if prefetch:
        print("后台预缓存：已开（以播放头为中心前后双向补片，给观看让路）")
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        # 正常退出 -> atexit 触发 _DiskLRU._save_index 落盘（kill 已被路由到这里）。
        print("\n正在保存缓存索引并退出……")
        server.shutdown()


def cmd_download(args):
    default_url, headers = load_session(args)
    if getattr(args, "video", None):
        headers, default_url = _resolve_video(args, headers)
    m3u8_url = args.url or default_url
    if not _looks_like_m3u8(m3u8_url, ""):
        print("警告：地址看起来不是 .m3u8，可能下不到完整视频：", m3u8_url)

    if not _which("ffmpeg"):
        raise SystemExit("没找到 ffmpeg，请先安装：brew install ffmpeg")

    server = start_proxy(headers, args.port)
    proxied = "http://127.0.0.1:%d/p?u=%s" % (
        args.port, urllib.parse.quote(m3u8_url, safe=""))

    out = args.output
    cmd = ["ffmpeg", "-y", "-i", proxied, "-c", "copy",
           "-bsf:a", "aac_adtstoasc", out]
    print("运行：", " ".join(cmd))
    rc = subprocess.call(cmd)
    if rc != 0:
        print("直接 copy 失败，改用重新编码再试一次……")
        rc = subprocess.call(["ffmpeg", "-y", "-i", proxied, out])
    server.shutdown()
    if rc == 0:
        print("完成：", os.path.abspath(out))
    else:
        raise SystemExit("ffmpeg 失败，请检查会话是否过期（重新抓包）或地址是否正确。")


def build_parser():
    p = argparse.ArgumentParser(
        description="把有道听课客户端抓到的加密 HLS 流，变成浏览器/任意播放器能看的视频。")
    sub = p.add_subparsers(dest="cmd", required=True)

    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--request", "-r",
                        help="抓包复制出来的请求原文文件（含 .m3u8 那条）。不传则从 stdin 读。")
    common.add_argument("--port", type=int, default=8808, help="本地代理端口（默认 8808）。")

    lp = sub.add_parser("list", parents=[common],
                        help="列出所有已购课程和视频（只需会话 Cookie）。")
    lp.set_defaults(func=cmd_list)

    sp = sub.add_parser("serve", parents=[common], help="起本地代理 + 网页播放器，浏览器在线看。")
    sp.add_argument("--video", "-V", help="打开时自动播放的 videoId（用 list 查到）。")
    sp.add_argument("--no-prefetch", action="store_true",
                    help="关闭整集后台预缓存（默认开启：边看边下整节课，切走自动暂停）。")
    sp.add_argument("--cache-mb", type=int, default=5120,
                    help="磁盘分片缓存上限 MB（默认 5120≈5G，到顶才按 LRU 淘汰）。")
    sp.add_argument("--cache-dir", default=None,
                    help="缓存持久化目录（一次性覆盖，不写回配置；缺省读 config.json，"
                         "再退回 ~/.youdao_course/cache）。常驻设置请在网页「设置」里改。")
    sp.set_defaults(func=cmd_serve)

    dp = sub.add_parser("download", parents=[common], help="下载并合并成 mp4（需要 ffmpeg）。")
    dp.add_argument("--video", "-V", help="要下载的 videoId（用 list 查到）。")
    dp.add_argument("--url", "-u", help="要下载的 m3u8 地址；不传则用 --video 或原文里那条。")
    dp.add_argument("--output", "-o", default="output.mp4", help="输出文件名（默认 output.mp4）。")
    dp.set_defaults(func=cmd_download)

    pp = sub.add_parser("parse", parents=[common], help="只解析并打印抓到的地址和头（排错用）。")
    pp.set_defaults(func=cmd_parse)

    return p


def main():
    args = build_parser().parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
