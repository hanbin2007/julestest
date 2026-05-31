"""本地解密代理网关：HTTP 处理 + 缩略图/缓冲/预缓存编排 + 状态对象。

Gateway 持有一台网关实例的全部可变状态（原先散在 make_handler 闭包里），并提供
缩略图/整集缓冲/预缓存的后台编排方法。make_handler(gateway) 返回一个 BaseHTTPRequestHandler
子类，其 gw 类属性指向该 Gateway，处理方法统一通过 self.gw.* 访问状态。

并发不变量（刻意不加锁的共享 dict，单写者 + GIL 原子，依赖如下约定）：
  · playhead[vid]   仅由 /p 处理线程在该 vid 的直播分片请求里写；预缓存 worker 只读，
                    读到旧值会在下一轮主动 re-center，stale 读无害。
  · seg_urls[vid]   由 /p、整集缓冲、预缓存、warm 经 _learn_segments 写入"该 vid 的有序
                    分片列表"；总数真相恒为 len(seg_urls[vid])（不再有冗余 seg_total）。
                    读方只做存在性/长度判断。
  · pf_active["vid"]  仅在 pf_lock 内写；多处无锁读，读到旧值最多让 worker 多跑一轮即退出。
有锁保护的状态：video_headers(vh_lock)、
thumb_meta/thumb_active/thumb_jobs/thumb_procs/thumb_session(thumb_lock)、
buf_state/buf_jobs(buf_lock)、pf_threads/pf_done(pf_lock)、seg_cache(自带锁)。
"""
import collections
import json
import logging
import math
import os
import queue
import re
import subprocess
import sys
import tempfile
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


# 允许回源的上游主机（精确等值，无通配后缀）：
#   stream.youdao.com    —— m3u8 播放列表 + .ts 分片
#   live.ydshengxue.com  —— 直播回放 AES 解密 key 接口（/p 的 key 分支会回源到此）
# 三处校验（buffer 入口/thumb 入口/_proxy）共用此常量，避免各自硬编码漂移。
_ALLOWED_HOSTS = frozenset({"stream.youdao.com", "live.ydshengxue.com"})

MAX_BODY = 8 * 1024 * 1024  # 请求体上限 8MB，防超大 POST body 拖垮内存

# 缩略图雪碧图参数
THUMB_INTERVAL = 10   # 每 10 秒一帧
THUMB_W = 160
THUMB_H = 90
THUMB_COLS = 10
# 缩略图持久化目录（生成后不删，跨会话复用）。
# YD_THUMB_DIR 仅供隔离 e2e 重定向到临时目录用(生产绝不设此 env, 故落回默认 ~/.youdao_course/thumbs,
# 行为与历史完全一致)。隔离测试需要它, 否则隔离网关会把 index.json/.jpg 写进生产 thumbs 目录 = 违约。
THUMB_DIR = os.environ.get("YD_THUMB_DIR") or os.path.join(
    os.path.expanduser("~"), ".youdao_course", "thumbs")
THUMB_WORKERS = 3
# ffmpeg 生成超时(秒): proc.wait 无界时一个挂死/慢源会永久占住一个 thumb worker, 整条缩略图队列
# 卡在 queued/gen 不动(#4)。超时后 terminate→(5s)→kill, 终态落 error reason="ffmpeg timeout %ds"。
# YD_THUMB_FFMPEG_TIMEOUT 仅供隔离 e2e/单元测试调小(默认 120s 太长); 生产不设此 env 即用默认。
_THUMB_FFMPEG_TIMEOUT = int(os.environ.get("YD_THUMB_FFMPEG_TIMEOUT") or 120)
# 缩略图源段独立桶上限(#1,#8): 缩略图源段(低清流)不再和 256MB 播放桶 seg_cache 抢容量,
# 物理隔离到自己的小硬桶 thumb_seg_cache。这样生成 D 的缩略图绝不会把已缓存(但当前没在看)
# 的 A/B/C 播放段挤出(保护窗口覆盖不到任意已缓存段, 只有物理分桶才能真正限界)。
# 64MB 足够放下一集低清流的全部源段(雪碧图生成顺序读); 生成完即 drop_vid 立即释放。
# YD_THUMB_CACHE_BYTES 仅供隔离 e2e/单元测试调小; 生产不设此 env 即用默认。
_THUMB_CACHE_BYTES = int(os.environ.get("YD_THUMB_CACHE_BYTES") or (64 * 1024 * 1024))
# buf_state 跨重启保留的"终态"(done/cancelled)上限: 防止跨上千讲无限膨胀。
# 非终态(queued/working/paused/error)永远保留(用户可能要 resume/retry)。
_BUF_TERMINAL_KEEP = 500
# 任务事件日志(操作历史真治本): 网关在每个真实终态转换点 append 一条带单调 seq 的事件,
# web 按 seq>上次拉增量写 TaskHistory。ring 有界 2000 条: web 高频拉取正常永不落后,
# 数日停机才丢极老事件(由 full->done 回填兜底)。_task_seq 是历史峰值, 跨重启不归零。
_TASK_EVENTS_KEEP = 2000


class Gateway:
    """一台网关实例的全部状态 + 后台编排（缩略图 / 整集缓冲 / 预缓存）。"""

    @staticmethod
    def _quarantine_corrupt(path, label):
        """JSON 损坏时把原文件搬到 .corrupt-<ts>, 而非直接让后续 _save 覆盖丢失。
        损坏可能是磁盘故障/硬重启半截写入, 保留原始字节供事后人工恢复。"""
        if not path or not os.path.exists(path):
            return
        try:
            bak = "%s.corrupt-%d" % (path, int(time.time()))
            os.replace(path, bak)
            _log.warning("%s 索引损坏, 已隔离到 %s; 内存重置, 后续将重建", label, bak)
        except OSError:
            _log.warning("%s 索引损坏且无法隔离: %s", label, path, exc_info=True)

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
        # 缩略图源段以 "t_"+vid 为 key 灌进同一 DiskLRU; 注入拆分器让 vid_stats 把它们归
        # thumb 桶(去前缀), 而 cache.py 自身不必硬编码 "t_" 命名约定。
        self.seg_cache.set_namespace_splitter(
            lambda vid: ("thumb", vid[2:]) if isinstance(vid, str) and vid.startswith("t_") else ("real", vid)
        )
        # mustFix-1: 升级一次性迁移。旧版把缩略图源段(t_)和播放段混灌进同一 256MB 播放桶
        # + index.json; re-arch 后源段改进独立 thumb_seg_cache, 生成完在那边 drop。但旧
        # index.json 里残留的 t_ 键回载进播放桶后永无 worker drop(drop 只在 thumb 桶发生),
        # 永久占用播放桶容量(生产 ~3.3GB)还挤出真实播放段。注入 splitter 之后扫一次干净。
        self.seg_cache.sweep_thumb_bucket()
        # 三档优先级闸门：0=LIVE(观看) > 1=AUTO(自动缓存) > 2=MANUAL(手动缓存)。
        self.gate = PriorityGate()

        # 掉盘恢复守卫(#2): 区分"运行中掉盘(内存权威, 盘回来后刷回盘)"
        # vs "启动即掉盘/从未成功载入(盘是真相, 盘回来后必须重载而非用空内存覆盖)"。
        # 必须在任何回载之前置 False; 全部 *.json 成功载入后才置 True。
        self._ever_loaded = False
        # _recover_flush_loop 与 _reload_all_persist 都会动同一批持久化态, 串行化避免
        # 恢复 tick 与并发 flush 交错(#19 治本在 Task 14, 此处先给恢复路径自己一把锁)。
        self._recover_lock = threading.Lock()

        # ---- 任务事件日志(操作历史真治本) -----------------------------------
        # 必须在所有回载(thumb 回载/buf_state 回载)之前就绪: init 阶段唯一"新发生"的
        # 终态(僵尸 queued->error 309 / thumb gen->error 166)发生在 web 轮询建立之前,
        # 若 seq/deque/emit 能力没就绪, 这些事件会永久丢(R3)。临界区只取 task_lock,
        # 绝不嵌套 buf_lock/thumb_lock/pf_lock(调用方已持那些锁, 避免死锁)。
        self.task_lock = threading.Lock()
        self._task_seq = 0  # 全局单调序号(历史峰值, 跨重启不归零)
        # per-boot epoch(#3): 掉盘期 seq 在内存涨但盘没写, kill-9 重启从盘载老 seq →
        # 新事件复用旧 seq, 旧 evt-<seq> 方案会被 web 误去重丢真终态。每 boot epoch +1,
        # 事件 id 变 evt-<epoch>-<seq>: 复用的 seq 在新 epoch 下是另一行, 永不撞。
        # epoch 持久化在 task_events.json 顶层, load 时 = 盘上 epoch + 1(新 boot 必更大)。
        self._task_epoch = 1
        self.task_events = collections.deque(maxlen=_TASK_EVENTS_KEEP)
        self.task_events_path = (
            os.path.join(self.seg_cache.dir, "task_events.json")
            if self.seg_cache.persist else None
        )
        # init 期终态事件掉盘补发(#18): 启动期(或启动即掉盘)若磁盘不可写, init 期发生的
        # 僵尸终态(buffer queued->error / thumb gen->error)只进内存 deque 没落盘, 此后
        # kill-9 会永久丢。这些事件经 _emit_init_event 发, 没落成会暂存到此; 盘回来后
        # _recover_once 调 _replay_pending_init_events 重发落盘。必须在 _load_persist_tables
        # (会触发 init 期 _emit_init_event)之前就绪。
        self._pending_init_events = []
        self._load_task_events()

        # 缩略图雪碧图：服务端用 ffmpeg 生成（复用已缓存分片），供 Artplayer 拖动预览。
        self.thumb_dir = THUMB_DIR
        os.makedirs(self.thumb_dir, exist_ok=True)
        self.thumb_index_path = os.path.join(self.thumb_dir, "index.json")
        # thumb_jobs.json 跟 thumb_index.json 一个目录, 跨重启保留失败/取消任务的重试上下文。
        self.thumb_jobs_path = os.path.join(self.thumb_dir, "thumb_jobs.json")
        # 缩略图源段独立物理桶(#1,#8): 低清流源段不再灌进 256MB 播放桶 seg_cache,
        # 改进自己的小硬桶(默认 64MB), 落在 thumb_dir/segcache。物理隔离是唯一能真正限界
        # "生成 D 缩略图把 A/B/C 已缓存播放段挤出"的手段(保护窗口覆盖不到任意已缓存段)。
        # 生成完(_gen_thumbs finally)调 thumb_seg_cache.drop_vid('t_'+vid) 立即释放源段。
        # DiskLRU(persist_dir) 不自建目录(掉盘守卫语义), 故先建 segcache 子目录再构造,
        # 否则首启 isdir=False -> ok=False -> 源段一片都缓存不进。它是内部再生成缓存,
        # 跟着 thumb_dir 走(thumb_dir 本就 makedirs), 不是外置盘上的用户数据, 建之无害。
        self._thumb_seg_dir = os.path.join(self.thumb_dir, "segcache")
        os.makedirs(self._thumb_seg_dir, exist_ok=True)
        self.thumb_seg_cache = DiskLRU(_THUMB_CACHE_BYTES, self._thumb_seg_dir)
        # 注入同一 t_ 拆分器: thumb_seg_cache 里全是 t_<vid> 键, vid_stats()['thumb'] 即得
        # 去前缀的 {vid: {bytes,segments}}, /api/status 的 per-vid thumbBytes 直接复用。
        self.thumb_seg_cache.set_namespace_splitter(
            lambda vid: ("thumb", vid[2:]) if isinstance(vid, str) and vid.startswith("t_") else ("real", vid)
        )
        self.thumb_meta = {}     # vid -> {"state": "gen"/"ready"/"error"/"cancelled", ...}
        self.thumb_active = set()  # 真正在 ffmpeg 生成中的 vid（区分"生成中"与"排队中"）
        self.thumb_jobs = {}     # vid -> (video, m3u8, duration, tier)，供重试重新入队
        self.thumb_procs = {}    # vid -> 运行中的 ffmpeg Popen，供取消时 terminate
        self.thumb_session = set()  # 本会话真正排过队的缩略图 vid（区分"任务"与启动时预载的 ready）
        self.thumb_lock = threading.Lock()
        self.thumb_q = queue.Queue()
        self.have_ffmpeg = which("ffmpeg") is not None

        # 整集缓冲（把整节课分片下到服务端磁盘缓存）：批量预缓冲 + 状态
        # 总数真相恒为 len(seg_urls[vid])；不再维护冗余 seg_total（旧版会与 seg_urls 漂移）。
        self.seg_urls = {}       # vid -> 按播放顺序的分片绝对地址列表
        self.buf_state = {}      # vid -> "queued"/"working"/"paused"/"done"/"error"/"cancelled"
        self.buf_jobs = {}       # vid -> (video, m3u8)，供继续/重试重新入队
        self._last_buf_error = {}  # vid -> str: 最近一次 buffer 失败原因(分片失败/AES key/m3u8)
        self.buf_lock = threading.Lock()
        self.buf_q = queue.Queue()

        # seg_urls.json：把"该 vid 的分片有序列表"持久化到缓存目录。重启后回载,
        # 让设置页的"总数 / 缓冲条 buckets"立刻能复原（不必等用户再点一次回放/缓冲）。
        # 没配持久化缓存目录就跳过（临时目录每次启动都会清,持久化也没意义）。
        self.seg_urls_path = (
            os.path.join(self.seg_cache.dir, "seg_urls.json")
            if self.seg_cache.persist else None
        )

        # buf_state.json / buf_jobs.json：缓冲任务状态 + 重试上下文落盘,
        # 重启后用户排好队的整集缓冲、暂停态、失败状态都还在,可以 resume/retry。
        # working → 启动时回退成 queued 重新入队(没法续上一片,反正都是 seg_cache 走断点)。
        self.buf_state_path = (
            os.path.join(self.seg_cache.dir, "buf_state.json")
            if self.seg_cache.persist else None
        )
        self.buf_jobs_path = (
            os.path.join(self.seg_cache.dir, "buf_jobs.json")
            if self.seg_cache.persist else None
        )
        self.buf_errors_path = (
            os.path.join(self.seg_cache.dir, "buf_errors.json")
            if self.seg_cache.persist else None
        )
        # video_metadata.json：vid → {productId, contentId, cardPackageId, src, liveId, duration}
        # 反向镜像。warm / thumb_batch / buffer_batch / play 任何一处接到完整 video dict 都
        # 落盘一份, 让网关后续即使 web 离线也知道每个 vid 的 src/headers, 启动后能自愈。
        self.video_meta = {}
        self.meta_lock = threading.Lock()  # 保护 video_meta + seg_urls 的读-改-写(_remember_video/_learn_segments)
        self.video_meta_path = (
            os.path.join(self.seg_cache.dir, "video_metadata.json")
            if self.seg_cache.persist else None
        )
        # 自动预缓存：以"播放头"为中心向前后双向补未缓存分片。
        self.pf_lock = threading.Lock()
        # pf_active 记录当前预缓存的 owner: vid + 唯一 token(#11)。token 由 _pf_new_token
        # 单调分配, A→B→A 快切时新旧 worker token 不同, 旧 worker finally 不会误清新 owner。
        self.pf_active = {"vid": None, "token": 0}
        self.pf_next_token = 0   # 单调 token 分配器(pf_lock 保护)
        self.pf_done = set()     # 预缓存到「整集已满」的 vid（供设置页「已完成」+任务历史用)
        self.pf_threads = {}     # vid -> (thread, stop_event, token)  # token: #11 per-worker
        self.pf_segidx = {}      # vid -> {seg_url: index}
        self.playhead = {}       # vid -> 最近一次直播请求到的分片下标
        # pf_control: 预缓存(自动)任务的用户控制态(pf_lock 保护)。缺省(absent)= running。
        # vid -> "paused" | "cancelled"。running 态不存(省盘 + 缺省即 running);
        # worker 每片复查: paused 则原地空转不前进也不退出, cancelled 等同 stop.is_set()。
        # act_prefetch 改它并落盘, 跨 kill-9 保留。
        self.pf_control = {}
        # pf_done.json: 跨会话保留预缓存完成的讲, 让任务历史里 prefetch:done 不会丢。
        self.pf_done_path = (
            os.path.join(self.seg_cache.dir, "pf_done.json")
            if self.seg_cache.persist else None
        )
        # pf_control.json: 预缓存控制态(paused/cancelled)跨重启保留(G5)。
        self.pf_control_path = (
            os.path.join(self.seg_cache.dir, "pf_control.json")
            if self.seg_cache.persist else None
        )
        # 全局后台缓存开关(G3): True = 三种后台任务(buffer/thumb/prefetch)全体暂停推进,
        # 但不改各自 per-task 状态。落盘 bg_state.json 跨重启保留。bg_lock 保护单字段读写。
        self._bg_paused = False
        self.bg_lock = threading.Lock()
        self.bg_state_path = (
            os.path.join(self.seg_cache.dir, "bg_state.json")
            if self.seg_cache.persist else None
        )

        # playhead.json: 预缓存中心点持久化。直播分片每秒触发,如果每次都落盘 IO 太多;
        # 用 _playhead_dirty 标志 + 后台 _playhead_flush 线程 5s 一刷,丢的最大值 = 5 秒位置漂移,
        # 网关重启后预缓存从 5 秒前的位置继续,完全可接受。
        # 同时含 _protect_vid 字段(嵌入同一文件): cache LRU "保护集"。
        self.playhead_path = (
            os.path.join(self.seg_cache.dir, "playhead.json")
            if self.seg_cache.persist else None
        )
        self._playhead_dirty = False
        # #19 治本后: playhead 专用锁已退役。撕裂洞由 _atomic_write_json 的唯一 tmp 名
        # 根上堵死(各写各的 tmp + 原子 replace), _save_playhead 不再需要串行化锁。

        # 所有持久化路径/dict/锁都就绪后, 一次性回载全部 *.json 持久化表(顺序见方法内)。
        # 抽成 _load_persist_tables 让掉盘恢复守卫(#2)能在盘回来后复用同一回载路径,
        # 而不是用空内存覆盖磁盘。emit_init_events=True: init 期允许发僵尸终态事件。
        self._load_persist_tables(emit_init_events=True)

        # 全部 *.json 已成功载入(或本就无盘/无文件): 此后内存即权威, 掉盘恢复走"刷回盘"。
        # 注意: 启动时若 seg_cache.ok=False(盘没挂), 上面所有 isfile/open 读盘均落空 ->
        # 内存全空; 这种情况下不能置 _ever_loaded(否则盘回来会用空内存覆盖, 即本 bug)。
        #
        # nit _ever_loaded 时机: _ever_loaded 必须由"载入时盘是否可用"判定, 且要在下面那两次
        # 落盘【之前】定格。否则若 _save_buf_state/_save_buf_errors 撞到瞬时 OSError,
        # _atomic_write_json 会把 seg_cache.ok 翻 False, 导致这里漏置 _ever_loaded ->
        # 后续 _recover_once 误走重载支路 -> 双发 init 终态事件。先按载入态定格, 再落盘。
        if self.seg_cache.ok:
            self._ever_loaded = True

        # 启动时若做了僵尸修正/终态裁剪, 立刻回写一次, 让下次启动不再重复处理同样的僵尸。
        # (init 阶段还没启 buffer worker, 无并发, 不需 buf_lock。)放在 _ever_loaded 定格后:
        # 即便这两次落盘撞瞬时 OSError 翻了 seg_cache.ok, 也不影响已定格的 _ever_loaded。
        self._save_buf_state()
        self._save_buf_errors()

        for _ in range(max(1, THUMB_WORKERS)):
            threading.Thread(target=self._thumb_worker, daemon=True).start()
        threading.Thread(target=self._buffer_worker, daemon=True).start()
        # 后台 flush 线程: playhead 节流落盘(5s/次),只在 dirty 时写。
        threading.Thread(target=self._playhead_flush_loop, daemon=True).start()
        # 后台 flush 线程: 掉盘恢复后重刷全部持久化状态(防丢掉盘窗口内的变更)。
        threading.Thread(target=self._recover_flush_loop, daemon=True).start()

    def pri_fetch(self, t, hdrs, url, range_header=None):
        """按优先级档位回源（委托给闸门）。"""
        return self.gate.fetch(t, hdrs, url, range_header)

    def _load_persist_tables(self, emit_init_events=True):
        """从磁盘回载全部 *.json 持久化表到内存(thumb_index/thumb_jobs/seg_urls/
        video_meta+video_headers/buf_jobs/buf_state/buf_errors/pf_done/playhead)。

        __init__ 与掉盘恢复守卫(_reload_all_persist) 共用此一处回载逻辑, 避免两份漂移。
        所有目标容器在方法开头重置为空再载: __init__ 路径本就是空, 恢复路径只在
        "从未载入(_ever_loaded=False)"时调(内存也是空), 故重置安全、且保证幂等。

        emit_init_events: 仅 __init__ 期为 True —— 上次被砍中途留下的僵尸终态
        (gen->error / 僵尸 queued->error)是"新发生"的转换, 必须发(R3)。掉盘恢复重载
        不是新转换, 传 False 不重发, 避免同一僵尸在盘抖动时反复刷历史。"""
        # 目标容器重置(幂等 + 防 reload 路径累积旧态)
        self.thumb_meta = {}
        self.thumb_jobs = {}
        self.seg_urls = {}
        self.video_meta = {}
        self.buf_jobs = {}
        self.buf_state = {}
        self._last_buf_error = {}
        self.pf_done = set()
        self.pf_control = {}
        self.playhead = {}

        _jpeg_ok = self._jpeg_ok
        # 回载 thumb_index.json: 现在存全部状态(ready/gen/error/cancelled),
        # ready 校验 .jpg 文件存在 + 有效(开头 magic bytes 是 JPEG SOI 0xFFD8 + 非 0 字节),
        # 网关被砍中 ffmpeg 时 .jpg 可能半截,仅 exists 会误认 ready, 前端展示 broken image。
        # 启动时若是 gen 状态(网关被砍时正在生成的) → 回退成 error,等用户手动重试。
        try:
            with open(self.thumb_index_path, "r", encoding="utf-8") as f:
                for vid, m in (json.load(f) or {}).items():
                    st = (m or {}).get("state")
                    if st == "ready":
                        jpg = os.path.join(self.thumb_dir, "%s.jpg" % vid)
                        if _jpeg_ok(jpg):
                            self.thumb_meta[vid] = m
                        # .jpg 缺失/损坏 → 不进 thumb_meta, 重新触发 thumb 会真重启
                    elif st == "gen":
                        # 进程被砍时正在跑的 ffmpeg → 算失败,等重试
                        self.thumb_meta[vid] = {"state": "error", "reason": "interrupted"}
                        # [发射点 9] init 期唯一*新发生*的 thumb 终态(gen->error): 上次被砍中途,
                        # 这是新转换不是回载快照, 必须发(R3)。回载原样的 ready/error/cancelled 不发(R4)。
                        # 走 _emit_init_event: 掉盘期没落盘成功会暂存待盘回来补发(#18)。
                        if emit_init_events:
                            self._emit_init_event("thumb", vid, "error", "interrupted")
                    elif st in ("error", "cancelled"):
                        self.thumb_meta[vid] = m
        except FileNotFoundError:
            pass   # 首次运行：尚无缩略图索引，正常
        except Exception:  # noqa: BLE001
            self._quarantine_corrupt(self.thumb_index_path, "缩略图")
        # thumb_jobs.json: 重试上下文 (vid → [video_dict, m3u8, duration, tier])
        if os.path.isfile(self.thumb_jobs_path):
            try:
                with open(self.thumb_jobs_path, "r", encoding="utf-8") as f:
                    raw = json.load(f) or {}
                for vid, payload in raw.items():
                    # 兼容 [v, m, dur, tier] 4-tuple
                    if isinstance(payload, list) and len(payload) == 4:
                        v, m, dur, tier = payload
                        if isinstance(v, dict) and isinstance(m, str) and m:
                            self.thumb_jobs[str(vid)] = (v, m, int(dur or 0), int(tier or 2))
            except Exception:  # noqa: BLE001
                self._quarantine_corrupt(self.thumb_jobs_path, "thumb_jobs")

        # seg_urls.json：把"该 vid 的分片有序列表"持久化到缓存目录。重启后回载,
        # 让设置页的"总数 / 缓冲条 buckets"立刻能复原（不必等用户再点一次回放/缓冲）。
        if self.seg_urls_path and os.path.isfile(self.seg_urls_path):
            try:
                with open(self.seg_urls_path, "r", encoding="utf-8") as f:
                    loaded = json.load(f) or {}
                for vid, urls in loaded.items():
                    if isinstance(urls, list) and urls:
                        self.seg_urls[str(vid)] = list(urls)
            except Exception:  # noqa: BLE001
                self._quarantine_corrupt(self.seg_urls_path, "seg_urls")
                self.seg_urls = {}

        # 启动时回载 3 张表(先 video_meta, 再 buf_jobs, 再 buf_state):
        # buf_state 引用 buf_jobs 的 (video, m3u8), 顺序错会 resume/retry 跑空。
        if self.video_meta_path and os.path.isfile(self.video_meta_path):
            try:
                with open(self.video_meta_path, "r", encoding="utf-8") as f:
                    self.video_meta = json.load(f) or {}
            except Exception:  # noqa: BLE001
                self._quarantine_corrupt(self.video_meta_path, "video_metadata")
                self.video_meta = {}
        # 重建 video_headers: video_headers 本身不持久化(含 session 字段 Cookie/UA,跨重启
        # 由 req.txt 重新加载),但 per-vid 部分(Url/Videoid/Cardpackageid/Liveid)能从
        # video_meta 派生。play_headers(self.session, meta, m3u8) 重建一遍, 这样
        # 网关脱离 web 启动后,所有曾见过的 vid 立刻能直接观看(不必先打 /api/play)。
        # tvid="t_"+vid (缩略图源,低清流)等到自动 thumb 时再按当时的低清 m3u8 重建。
        for vid, meta in self.video_meta.items():
            m3u8 = meta.get("m3u8")
            if not m3u8:
                continue
            try:
                self.video_headers[str(vid)] = play_headers(self.session, meta, m3u8)
            except Exception:  # noqa: BLE001
                _log.debug("启动重建 video_headers 失败 vid=%s", vid, exc_info=True)
        if self.buf_jobs_path and os.path.isfile(self.buf_jobs_path):
            try:
                with open(self.buf_jobs_path, "r", encoding="utf-8") as f:
                    raw = json.load(f) or {}
                # 文件存的是 {vid: [video_dict, m3u8]}, 还原成 (video, m3u8) tuple
                for vid, payload in raw.items():
                    if isinstance(payload, list) and len(payload) == 2:
                        v, m = payload
                        if isinstance(v, dict) and isinstance(m, str) and m:
                            self.buf_jobs[str(vid)] = (v, m)
            except Exception:  # noqa: BLE001
                self._quarantine_corrupt(self.buf_jobs_path, "buf_jobs")
                self.buf_jobs = {}
        if self.buf_state_path and os.path.isfile(self.buf_state_path):
            try:
                with open(self.buf_state_path, "r", encoding="utf-8") as f:
                    loaded = json.load(f) or {}
                # working → queued: 网关被砍时正在跑的任务, 重启后无法续片中位置,
                # 但 seg_cache 是断点续传的, 重新入队等价于继续。
                # done/cancelled 保留(供任务列表"已完成/已取消"显示历史),不重新入队。
                # paused/queued/error 保留, 用户能 resume/retry。
                # 先把终态(done/cancelled)按出现顺序收集, 只保留最近 _BUF_TERMINAL_KEEP 个,
                # 避免 buf_state 跨上千讲无限膨胀。非终态(queued/working/paused/error)全留。
                terminal = []
                live_items = []
                for vid, st in loaded.items():
                    if not (isinstance(st, str) and st in (
                        "queued", "working", "paused", "done", "error", "cancelled"
                    )):
                        continue
                    if st in ("done", "cancelled"):
                        terminal.append((str(vid), st))
                    else:
                        live_items.append((str(vid), st))
                # 终态只保留尾部(假定 JSON 写入顺序≈时间顺序; dict 在 py3.7+ 保序)
                for vid, st in terminal[-_BUF_TERMINAL_KEEP:]:
                    self.buf_state[vid] = st
                for vid, st in live_items:
                    # working → queued: 网关被砍时正在跑的任务, 重启后无法续片中位置,
                    # 但 seg_cache 是断点续传的, 重新入队等价于继续。
                    actual = "queued" if st == "working" else st
                    if actual == "queued":
                        job = self.buf_jobs.get(vid)
                        if job:
                            self.buf_state[vid] = "queued"
                            self.buf_q.put(job)
                        else:
                            # 没重试上下文的 queued = 僵尸: 永远跑不起来。转成 error,
                            # 用户能看到"失败"并(若 web 重提 batch)重新排队, 不再卡在 queued。
                            self.buf_state[vid] = "error"
                            reason = "重启后丢失任务上下文, 请重新缓存"
                            self._last_buf_error[vid] = reason
                            # [发射点 4] init 期唯一*新发生*的 buffer 终态(僵尸 queued->error):
                            # 发生在 web 轮询建立之前, seq/emit 已在 init 早期就绪故能发(R3)。
                            # 其它回载原样态(done/cancelled/paused/error/queued)一律不发(R4)。
                            # 走 _emit_init_event: 掉盘期没落盘成功会暂存待盘回来补发(#18)。
                            if emit_init_events:
                                self._emit_init_event("buffer", vid, "error", reason)
                    else:
                        self.buf_state[vid] = actual
            except Exception:  # noqa: BLE001
                self._quarantine_corrupt(self.buf_state_path, "buf_state")
                self.buf_state = {}

        # buf_errors.json: 失败原因文本跨重启保留。只保留仍处 error 态的 vid 的原因,
        # 其它(done/cancelled/被 retry 成功的)清掉,避免无限累积旧错误。
        if self.buf_errors_path and os.path.isfile(self.buf_errors_path):
            try:
                with open(self.buf_errors_path, "r", encoding="utf-8") as f:
                    loaded = json.load(f) or {}
                for vid, reason in loaded.items():
                    if (isinstance(reason, str) and reason
                            and self.buf_state.get(str(vid)) == "error"
                            and str(vid) not in self._last_buf_error):
                        self._last_buf_error[str(vid)] = reason
            except Exception:  # noqa: BLE001
                self._quarantine_corrupt(self.buf_errors_path, "buf_errors")
                self._last_buf_error = {}

        # pf_done.json: 跨会话保留预缓存完成的讲, 让任务历史里 prefetch:done 不会丢。
        if self.pf_done_path and os.path.isfile(self.pf_done_path):
            try:
                with open(self.pf_done_path, "r", encoding="utf-8") as f:
                    loaded = json.load(f) or []
                if isinstance(loaded, list):
                    for vid in loaded:
                        self.pf_done.add(str(vid))
            except Exception:  # noqa: BLE001
                self._quarantine_corrupt(self.pf_done_path, "pf_done")
                self.pf_done = set()

        # pf_control.json: 预缓存控制态(paused/cancelled)跨重启保留(G5)。缺省=running 不存。
        # 重启后 paused/cancelled 的讲不会有 worker 在跑(worker 是会话级线程, 进程死了线程也没了);
        # 用户 resume 时 act_prefetch 才会按需重启 worker。故只需把控制态回载即可。
        if self.pf_control_path and os.path.isfile(self.pf_control_path):
            try:
                with open(self.pf_control_path, "r", encoding="utf-8") as f:
                    loaded = json.load(f) or {}
                for vid, ctl in loaded.items():
                    if isinstance(ctl, str) and ctl in ("paused", "cancelled"):
                        self.pf_control[str(vid)] = ctl
            except Exception:  # noqa: BLE001
                self._quarantine_corrupt(self.pf_control_path, "pf_control")
                self.pf_control = {}

        # bg_state.json: 全局后台缓存开关(G3)跨重启保留。
        self._bg_paused = False
        if self.bg_state_path and os.path.isfile(self.bg_state_path):
            try:
                with open(self.bg_state_path, "r", encoding="utf-8") as f:
                    loaded = json.load(f) or {}
                self._bg_paused = bool(loaded.get("paused"))
            except Exception:  # noqa: BLE001
                self._quarantine_corrupt(self.bg_state_path, "bg_state")
                self._bg_paused = False

        # playhead.json: 预缓存中心点 + protect_vid + extra_protect 回载。
        if self.playhead_path and os.path.isfile(self.playhead_path):
            try:
                with open(self.playhead_path, "r", encoding="utf-8") as f:
                    loaded = json.load(f) or {}
                ph = loaded.get("playhead") or {}
                if isinstance(ph, dict):
                    for vid, idx in ph.items():
                        try:
                            self.playhead[str(vid)] = int(idx)
                        except (ValueError, TypeError):
                            continue
                pv = loaded.get("protect_vid")
                if isinstance(pv, str) and pv:
                    self.seg_cache.set_protect_vid(pv)
                ep = loaded.get("extra_protect")
                if isinstance(ep, list):
                    self.seg_cache.set_extra_protect(ep)
            except Exception:  # noqa: BLE001
                self._quarantine_corrupt(self.playhead_path, "playhead")
                self.playhead = {}

    def _atomic_write_json(self, path, data, ok_gate=None):
        """tmp + os.replace 原子落盘 JSON。返回是否真的写成功(掉盘/跳过/异常都 False)。

        闸门(健康判定)默认看段盘 self.seg_cache.ok: 段盘掉线时跳过, 避免无限错误日志
        风暴 + 防止用空快照覆盖有效数据。#17: 缩略图持久化落在 thumb_dir(默认系统盘),
        与段盘(可能外置盘)是【不同的盘】, 故 thumb 写盘传 ok_gate=self._thumb_dir_ok 用
        自己的健康探针 —— 段盘掉线绝不冻结 thumb 写盘; 反之 thumb 盘掉线也不污染段盘 ok。
        ok_gate 为 None 时沿用旧行为(段盘闸门 + OSError 连锁标记 seg_cache.ok=False)。

        #19 治本: tmp 名带【唯一后缀】(tempfile.mkstemp 在同目录开唯一文件), 不再用共享
        path+'.tmp'。共享名时两线程并发写同一 path 会互相截断对方写一半的 tmp / os.replace
        交错 -> 目标 JSON 撕裂成半文件。唯一 tmp + 原子 os.replace 让任一时刻目标都是某次
        完整写入, 永不撕裂 —— 覆盖 seg_urls/video_meta/pf_done/playhead/task_events/thumb
        全部 *.json, playhead 专用锁可退役。"""
        if not path:
            return False
        if ok_gate is None:
            if not self.seg_cache.ok:
                return False  # 段盘掉线: 不再尝试写盘
        elif not ok_gate():
            return False      # 自定义闸门(如 thumb_dir 探针)判定不可写: 跳过
        d = os.path.dirname(path) or "."
        base = os.path.basename(path)
        tmp = None
        try:
            # 同目录开唯一 tmp(保证 os.replace 是同文件系统的原子重命名)。
            fd, tmp = tempfile.mkstemp(dir=d, prefix=base + ".", suffix=".tmp")
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False)
            os.replace(tmp, path)
            return True
        except Exception as e:  # noqa: BLE001
            _log.warning("索引落盘失败:%s", path, exc_info=True)
            # 失败时清掉自己的 tmp(唯一名, 不会误删别的写者的), 否则残留半截文件白占盘。
            if tmp:
                try:
                    os.remove(tmp)
                except OSError:
                    pass
            # 只有走默认段盘闸门时, OSError 才连锁标记段盘掉线。自定义闸门(thumb)的
            # 失败不得污染 seg_cache.ok —— 那是另一块盘的健康标志。
            if ok_gate is None and isinstance(e, OSError):
                self.seg_cache.ok = False  # 掉盘连锁标记
            return False

    def _thumb_dir_ok(self):
        """缩略图持久化目录(thumb_dir)当前是否可写 —— 与段盘 seg_cache.ok 完全解耦(#17)。
        thumb_index/thumb_jobs 都落在 thumb_dir(默认 ~/.youdao_course/thumbs, 多在系统盘),
        段盘(可能是外置盘)掉线不该把缩略图状态也冻住。逻辑对齐 DiskLRU.dir_ok:
        目录在且可写即真。每次写盘实时复查, 故 thumb 盘中途掉线也能及时跳过。"""
        d = getattr(self, "thumb_dir", None)
        if not d:
            return False
        return os.path.isdir(d) and os.access(d, os.W_OK)

    def _save_buf_state(self):
        """落盘 buf_state. 调用方必须已经持有 buf_lock(或本就在锁外的 init 阶段)。"""
        if not self.buf_state_path:
            return
        self._atomic_write_json(self.buf_state_path, dict(self.buf_state))

    def _save_buf_errors(self):
        """落盘 _last_buf_error (vid -> 失败原因文本)。调用方持有 buf_lock。
        和 buf_state.json 配套: error 状态跨重启可见,reason 也跟着回来。"""
        if not self.buf_errors_path:
            return
        self._atomic_write_json(self.buf_errors_path, dict(self._last_buf_error))

    def _save_buf_jobs(self):
        """落盘 buf_jobs. 同上,调用方持有 buf_lock。
        (video, m3u8) tuple 序列化成 [video_dict, m3u8] 二元组。"""
        if not self.buf_jobs_path:
            return
        out = {}
        for vid, payload in self.buf_jobs.items():
            try:
                v, m = payload
                if isinstance(v, dict) and isinstance(m, str):
                    out[str(vid)] = [v, m]
            except Exception:  # noqa: BLE001
                continue
        self._atomic_write_json(self.buf_jobs_path, out)

    def _save_video_meta(self):
        """落盘 video_metadata. 调用方持 vh_lock 或 init 阶段。"""
        if not self.video_meta_path:
            return
        self._atomic_write_json(self.video_meta_path, dict(self.video_meta))

    def _save_pf_done(self):
        """落盘 pf_done. 调用方持 pf_lock 或确保不冲突。"""
        if not self.pf_done_path:
            return
        self._atomic_write_json(self.pf_done_path, sorted(self.pf_done))

    def _save_pf_control(self):
        """落盘 pf_control(预缓存 paused/cancelled 控制态)。调用方持 pf_lock。
        paused/cancelled 跨 kill-9 保留(G5): act_prefetch 改完即落盘。"""
        if not self.pf_control_path:
            return
        self._atomic_write_json(self.pf_control_path, dict(self.pf_control))

    def _save_bg_state(self):
        """落盘全局后台缓存开关(G3)。调用方持 bg_lock。"""
        if not self.bg_state_path:
            return
        self._atomic_write_json(self.bg_state_path, {"paused": bool(self._bg_paused)})

    # ---- 任务事件日志 ----------------------------------------------------
    def _load_task_events(self):
        """回载 task_events.json: {epoch, seq: 峰值, events: [...]}。
        _task_seq = max(顶层 seq, events 内 max seq), 永不倒退(防文件被部分篡改/截断)。
        _task_epoch = (顶层 epoch, 或 events 内 max epoch) + 1: 新 boot 必比盘上大,
        故掉盘期复用的 seq 在新 epoch 下是另一行(#3, 防 web 误去重丢真终态)。
        损坏走 _quarantine_corrupt 隔离 + 内存重置 seq=0。epoch 用 max(当前, 墙钟)+1:
        旧版 except 分支 self._task_epoch+1 在 __init__(epoch=1)下确定性落到 2, 可能撞历史
        epoch=2 行致 web 误去重复活已删事件; 改用墙钟做底永不撞历史小 epoch(corrupt epoch)。

        mustFix-3: 对 _task_seq/_task_epoch/task_events 的写整段在 with self.task_lock 内
        (reload 期 web/worker 也可能并发 _emit_task_event 读写这三者, 不上锁 -> deque
        mutated-during-iteration / seq 竞争)。成功路径也【先 clear deque 再 append】, 否则
        reload 复用本方法时旧事件会累积。emit 仍只取 task_lock, 故本方法持 task_lock 期间
        不得调任何 emit(只填内存); 临界区内绝不嵌套 buf/thumb/meta/pf 锁。
        临时缓存目录(task_events_path=None)无文件可载, 直接 return(epoch 保持构造时的 1)。
        盘上有路径但无文件(首启 / 掉盘期发的 init 事件从未落盘): reload 复用本方法时
        必须把内存 deque 重置成盘上真相(空), 否则 __init__ 期那条只在内存、没落盘的"幻影"
        事件会残留, 叠加 _replay_pending_init_events 补发 -> 同一僵尸双发(shouldFix 失败信号)。"""
        path = self.task_events_path
        if not path:
            return
        if not os.path.isfile(path):
            # 盘上无文件 = 没有已落盘事件; 把内存 deque 对齐到此真相(reload 去幻影)。
            with self.task_lock:
                self.task_events.clear()
            return
        try:
            with open(path, "r", encoding="utf-8") as f:
                loaded = json.load(f) or {}
            top_seq = int(loaded.get("seq") or 0)
            top_epoch = int(loaded.get("epoch") or 0)
            events = loaded.get("events") or []
            kept = []
            max_ev = 0
            max_epoch = 0
            for ev in events:
                if not isinstance(ev, dict):
                    continue
                try:
                    s = int(ev.get("seq"))
                except (TypeError, ValueError):
                    continue
                if s > max_ev:
                    max_ev = s
                try:
                    e = int(ev.get("epoch"))
                    if e > max_epoch:
                        max_epoch = e
                except (TypeError, ValueError):
                    pass
                kept.append(ev)
            with self.task_lock:
                # 成功路径也先 clear 再 append: reload 复用本方法时不累积旧事件。
                self.task_events.clear()
                for ev in kept:
                    self.task_events.append(ev)
                self._task_seq = max(top_seq, max_ev)
                # 新 boot = 盘上最大 epoch + 1(顶层与事件内取较大者, 防文件被部分篡改)。
                self._task_epoch = max(top_epoch, max_epoch) + 1
        except Exception:  # noqa: BLE001
            self._quarantine_corrupt(path, "task_events")
            with self.task_lock:
                self.task_events.clear()
                self._task_seq = 0
                # corrupt epoch 撞号治本: 旧版 +1 在 __init__(epoch=1)下确定性落到 2,
                # 可能撞历史 epoch=2 行 -> web 误去重让 #3 复活。用墙钟做底(单调、跨重启
                # 必比任何历史小 epoch 大), 永不撞历史小 epoch。
                self._task_epoch = max(self._task_epoch, int(time.time())) + 1

    def _save_task_events(self):
        """落盘 task_events. 调用方已持 task_lock(_emit 内)或确保无并发。
        persist=False 时 task_events_path=None, 静默跳过不落盘(R9)。
        写 {epoch: 本 boot epoch, seq: 历史峰值 _task_seq, events: [...有界 deque, 旧->新]}。
        epoch 落盘后下次 load 会 +1, 保证跨重启 epoch 单调(#3)。

        返回 True 当且仅当真的写成功落盘; path=None / 掉盘跳过 / 异常都返回 False。
        init 期补发(#18)靠这个返回值判定"这条事件落盘没成功 -> 暂存待补发"。"""
        if not self.task_events_path:
            return False
        return self._atomic_write_json(
            self.task_events_path,
            {"epoch": self._task_epoch, "seq": self._task_seq,
             "events": list(self.task_events)},
        )

    def _emit_task_event(self, kind, vid, state, reason=None):
        """在一个真实终态转换点 append 一条事件并落盘。

        kind ∈ {buffer, thumb, prefetch}; state 按 kind 取值
        (buffer: done|error|paused|cancelled / thumb: done|error / prefetch: done);
        reason 仅 error 携带, 截 200 字符。

        临界区只取 task_lock, 绝不嵌套 buf_lock/thumb_lock/pf_lock:
        调用方(worker/act/init)往往已持有那些锁, 在此再取会死锁。_task_seq 单调递增
        是内存权威(即便落盘被掉盘跳过), web 靠 seq 区分事件、两侧绝不按状态值去重(R1)。"""
        # #15: 盖上该 vid 的 productId(共享讲同 videoId 跨课, web 按 (productId,videoId)
        # 才能归属到正确课程)。从 video_meta 读(buffer/thumb/warm/play 入口都先 _remember_video
        # 落过)。dict.get 是 GIL 原子, 不嵌套 meta_lock(避免与 task_lock 形成锁序冲突/死锁)。
        meta = self.video_meta.get(str(vid)) or {}
        product_id = meta.get("productId")
        with self.task_lock:
            self._task_seq += 1
            ev = {
                "epoch": self._task_epoch,  # #3: 跨重启复用 seq 时靠 epoch 区分行
                "seq": self._task_seq,
                "ts": time.time(),
                "kind": kind,
                "vid": str(vid),
                "productId": product_id,  # #15: 共享讲归属(可能为 None)
                "state": state,
                "reason": (reason[:200] if reason else None),
            }
            self.task_events.append(ev)
            # 返回是否真落盘成功: init 期补发(#18)据此判定要不要暂存这条待盘回来补发。
            return self._save_task_events()

    def _emit_init_event(self, kind, vid, state, reason=None):
        """init 期(__init__ 回载 / 启动即掉盘后重载)的终态事件专用发射口(#18)。

        这些是 init 唯一"新发生"的真转换(僵尸 buffer queued->error / thumb gen->error
        interrupted), 发生在 web 轮询建立之前。普通 _emit_task_event 在掉盘期会进内存 deque
        但 _save_task_events 静默跳过 -> 只在内存、没落盘; 此后 kill-9 会永久丢这条真终态。

        本方法照常 emit; 若这次没落盘成功(掉盘), 把语义 (kind,vid,state,reason) 暂存到
        self._pending_init_events, 待盘回来后由 _recover_once 调 _replay_pending_init_events
        重新 emit(全新 seq/epoch -> 落盘后是带新 id 的一行, web 不会误去重)。"""
        if not self._emit_task_event(kind, vid, state, reason):
            self._pending_init_events.append((kind, str(vid), state, reason))

    def _replay_pending_init_events(self):
        """盘回来后把掉盘期没落盘成功的 init 终态事件重新 emit(而非仅 reflush)。
        逐条重发分配全新 seq+当前 epoch, 落盘后是带新 id 的事件行(#18)。补发成功(已落盘)
        才出队, 仍没落成(盘又抖)就留着下次再补 -> 幂等、不丢。由 _recover_once 两条支路调。"""
        if not self._pending_init_events:
            return
        pending = self._pending_init_events
        self._pending_init_events = []
        leftover = []
        for kind, vid, state, reason in pending:
            if not self._emit_task_event(kind, vid, state, reason):
                leftover.append((kind, vid, state, reason))  # 盘又抖, 留到下次补
        self._pending_init_events = leftover

    def _save_playhead(self):
        """落盘 playhead + protect_vid. 由 _playhead_flush_loop 节流调用,不直接在
        /p 处理线程里调(每秒可能多次写盘,无价值)。

        #19 治本后: 撕裂洞由 _atomic_write_json 的唯一 tmp 名根上堵死, playhead 专用锁
        已退役(不再需要靠串行化绕过共享 tmp 名)。本方法被 5s 节流线程和掉盘恢复
        (_flush_all_persist)两条线程调用并发也不会撕裂: 各写各的唯一 tmp + 原子 replace,
        目标 playhead.json 任一时刻都是某次完整写入。"""
        if not self.playhead_path:
            return
        data = {
            "playhead": dict(self.playhead),
            "protect_vid": self.seg_cache.protect_vid,
            "extra_protect": self.seg_cache.extra_protect_vids(),
        }
        # 只有真写成功才清 dirty: _atomic_write_json 掉盘时静默跳过(返回 False),
        # 此时若清了 dirty, 失败的 flush 不会重试, 位置/保护集可能再也补不上。
        if self._atomic_write_json(self.playhead_path, data):
            self._playhead_dirty = False

    def _playhead_flush_loop(self):
        """每 5s 检查 playhead/protect_vid 是否 dirty, 是就落盘。
        网关被砍最多丢 5s 内的播放位置漂移, 预缓存中心从 5s 前的位置继续,无感。"""
        while True:
            time.sleep(5)
            if self._playhead_dirty:
                try:
                    self._save_playhead()
                except Exception:  # noqa: BLE001
                    _log.debug("playhead 节流落盘失败", exc_info=True)

    def _flush_all_persist(self):
        """掉盘恢复后把全部内存态强制重刷回盘(运行中掉盘: 内存权威)。
        掉盘期间 _atomic_write_json 全被跳过, 盘回来后磁盘 JSON 还停在掉盘前快照,
        不重刷的话此后一次 kill -9 会丢掉整个掉盘窗口内的状态变更。
        各 _save_* 自带掉盘守卫 + 持各自锁的约定, 此处遵从原有锁序。"""
        self._save_seg_urls()
        self._save_video_meta()
        self._save_pf_done()
        with self.pf_lock:
            self._save_pf_control()
        with self.bg_lock:
            self._save_bg_state()
        self._save_playhead()
        self._save_thumb_index()
        with self.task_lock:
            self._save_task_events()  # 掉盘窗口内的事件也重刷, 否则丢
        with self.buf_lock:
            self._save_buf_state()
            self._save_buf_jobs()
            self._save_buf_errors()
        self._save_thumb_jobs()  # 自持 thumb_lock 快照, 调用方不得持锁
        self.seg_cache._dirty = True  # 让 cache 的 _flush_loop 也重写 index.json

    def _reload_all_persist(self):
        """启动即掉盘(从未载入)后盘回来: 盘才是真相, 从磁盘重载全部持久化态到内存,
        而不是用空内存覆盖磁盘(本 bug #2 的治本)。重跑 cache 索引 + 全部 *.json 回载。

        与 __init__ 回载共用底层 _load_persist_tables; 只补 cache 索引重载 + 重建
        video_headers(派生态, 让重载后立刻能直接观看)。不在此重入队 buffer/thumb worker
        (它们已在跑, 见到回载好的 buf_q/thumb 状态会自然推进)。

        mustFix-2: _load_persist_tables 传 emit_init_events=False —— 重载不是新转换,
        僵尸 queued->error / thumb gen->error 在 __init__ 期已发过(掉盘期没落成的暂存到
        _pending_init_events, 由 _recover_once 在本方法返回后 _replay_pending_init_events
        补发)。这里再发会双发同一僵尸事件(web 多写一行历史)。

        mustFix-3: 整个重载(reset + 回填同临界区)在【与 _flush_all_persist 一致的固定锁序】
        buf_lock -> thumb_lock -> meta_lock -> pf_lock 内, 避免运行期 web/worker 并发读改
        buf_state/video_meta/seg_urls/thumb_meta/playhead 致 dict/deque mutated-during-iteration
        (web 500)。_load_task_events 自持 task_lock(锁序最内, 永不在持有它时取上面四锁);
        本临界区内绝不调任何 emit(emit 只取 task_lock, 但锁内 emit 会让 task_lock 落到
        buf/thumb/meta/pf 之后, 仍是一致序 —— 不过 emit_init_events=False 本就不在此 emit)。"""
        # 1) cache 自身索引(index.json -> meta/size): 启动时 ok=False 跳过了 _load_index。
        if self.seg_cache.persist and self.seg_cache.ok:
            try:
                self.seg_cache._load_index()
                # mustFix-1: 重载也清旧 t_ 缩略图源段残留(否则掉盘恢复又把它们回播放桶)。
                self.seg_cache.sweep_thumb_bucket()
            except Exception:  # noqa: BLE001
                _log.warning("掉盘恢复重载 cache 索引失败", exc_info=True)
        # 2) task_events 先于其它表回载(自持 task_lock, 锁序最内)。
        self._load_task_events()
        # 3) 全部 *.json 持久化表回载到内存。整段在固定锁序内(reset+回填同临界区), 重载期
        #    web/worker 看到的始终是"全旧"或"全新", 不会撞到半重置的 dict。emit_init_events=False。
        with self.buf_lock, self.thumb_lock, self.meta_lock, self.pf_lock:
            self._load_persist_tables(emit_init_events=False)
            # nit reload 后落盘: 回载把僵尸 buf_state(queued->error)修正了, 落回盘让下次
            #     启动不再重复处理同样的僵尸(此时已持 buf_lock, 满足 _save_* 的持锁约定)。
            self._save_buf_state()
            self._save_buf_errors()
        # 4) 重建 video_headers(派生态): 让重载后曾见过的 vid 立刻能直接观看。
        #    在四锁外做: video_headers 由 vh_lock 保护(与上面四锁无序约束), 且 play_headers
        #    可能慢, 不该把 buf/thumb/meta/pf 锁占住。读 video_meta 用 GIL 原子快照。
        for vid, meta in list(self.video_meta.items()):
            m3u8 = meta.get("m3u8")
            if not m3u8:
                continue
            try:
                hdrs = play_headers(self.session, meta, m3u8)
            except Exception:  # noqa: BLE001
                _log.debug("掉盘恢复重建 video_headers 失败 vid=%s", vid, exc_info=True)
                continue
            with self.vh_lock:
                self.video_headers[str(vid)] = hdrs

    def _recover_once(self):
        """掉盘恢复的单次 tick(从 _recover_flush_loop 抽出, 供单元测试直接调)。
        语义:
          · ok 仍 False(盘没回来) -> 不动作。
          · ok True 且从未载入(_ever_loaded=False, 即启动即掉盘) -> 重载磁盘(盘是真相)。
          · ok True 且曾载入(运行中掉盘后回来) -> 刷回内存(内存是真相)。
        ok 的 False->True 触发判定由 _recover_flush_loop 负责(prev_ok); _recover_once
        只看当前 ok + _ever_loaded, 故重复调用幂等(刷/载都可安全重做)。"""
        if not self.seg_cache.ok:
            return
        with self._recover_lock:
            if not self._ever_loaded:
                # 启动即掉盘、从未载入: 盘才是真相, 重载而非覆盖。
                _log.warning("启动即掉盘后缓存盘回来, 从磁盘重载持久化态(防空内存覆盖)")
                self._reload_all_persist()
                self._ever_loaded = True
            else:
                # 运行中掉盘后回来: 内存态权威, 刷回盘。
                _log.warning("缓存盘恢复可写, 重刷全部持久化状态")
                self._flush_all_persist()
            # #18: 掉盘期没落盘成功的 init 终态事件, 盘回来后重新 emit 并落盘(两条支路都补)。
            # 放在重载/刷回之后: 重载支路里 _reload_all_persist 会 _load_task_events 续上盘上
            # 峰值 seq, 此时补发分配的新 seq 不会与盘上已有事件撞。
            self._replay_pending_init_events()

    def _recover_flush_loop(self):
        """监测掉盘恢复: seg_cache.ok 由 False→True 时跑一次 _recover_once。
        启动即掉盘 -> 重载磁盘; 运行中掉盘 -> 刷回内存(见 _recover_once)。"""
        prev_ok = self.seg_cache.ok
        while True:
            time.sleep(5)
            now_ok = self.seg_cache.ok
            # ok 可能被 _save_index/_atomic_write_json 在掉盘时设 False; 目录恢复后
            # 由 dir_ok() 探测回真, 再手动把 ok 拉回 True 解除封印。
            if not now_ok and self.seg_cache.dir_ok():
                self.seg_cache.ok = True
                now_ok = True
            if now_ok and not prev_ok:
                try:
                    self._recover_once()
                except Exception:  # noqa: BLE001
                    _log.warning("掉盘恢复处理失败", exc_info=True)
            prev_ok = now_ok

    def _init_persist_min(self, cache_dir, ok=True):
        """[测试 seam] 不走真实网络/不起 worker, 只搭出掉盘恢复路径(_recover_once /
        _reload_all_persist / _flush_all_persist)所需的最小持久化骨架。

        构造方式: 调用方 Gateway.__new__(Gateway) 后调本方法。设:
          · 一个真实 DiskLRU(cache_dir) 作 seg_cache(故 ok/dir_ok/_load_index/persist 都真)。
          · 全部 *.json 持久化路径指向 cache_dir; thumb_dir 隔离到 cache_dir/_thumb(不碰生产)。
          · 全部内存态空 dict/set + 必要的锁 + 空 task_events 基础设施。
          · _ever_loaded=False(模拟"启动即掉盘从未载入"; 运行中掉盘测试自行置 True)。
          · seg_cache.ok 被强制设为传入的 ok(模拟启动时盘可用/不可用)。
        生产代码不依赖本方法; 仅单元测试用。"""
        self.base_headers = {}
        self.session = {}
        self.port = 0  # 缩略图 ffmpeg 代理 URL 用; 单测不起真 server, 0 即可
        self.video_headers = {}
        self.vh_lock = threading.Lock()
        self.seg_cache = DiskLRU(SEG_CACHE_BYTES, cache_dir)
        self.seg_cache.set_namespace_splitter(
            lambda vid: ("thumb", vid[2:]) if isinstance(vid, str) and vid.startswith("t_") else ("real", vid)
        )
        self.seg_cache.sweep_thumb_bucket()  # mustFix-1: 与生产 __init__ 同构(扫旧 t_ 残留)
        self.seg_cache.ok = ok  # 模拟启动时盘(不)可用

        self._ever_loaded = False
        self._recover_lock = threading.Lock()

        # task_events 基础设施
        self.task_lock = threading.Lock()
        self._task_seq = 0
        self._task_epoch = 1  # #3: per-boot epoch(测试骨架不回载, 直接给初值)
        self.task_events = collections.deque(maxlen=_TASK_EVENTS_KEEP)
        self.task_events_path = os.path.join(cache_dir, "task_events.json")
        self._pending_init_events = []  # #18: 掉盘期 init 终态事件暂存待补发

        # thumb 隔离目录(不碰生产 THUMB_DIR)
        self.thumb_dir = os.path.join(cache_dir, "_thumb")
        os.makedirs(self.thumb_dir, exist_ok=True)
        self.thumb_index_path = os.path.join(self.thumb_dir, "index.json")
        self.thumb_jobs_path = os.path.join(self.thumb_dir, "thumb_jobs.json")
        # 缩略图源段独立物理桶(#1,#8): 与生产 __init__ 同构, 落在 thumb_dir/segcache。
        self._thumb_seg_dir = os.path.join(self.thumb_dir, "segcache")
        os.makedirs(self._thumb_seg_dir, exist_ok=True)
        self.thumb_seg_cache = DiskLRU(_THUMB_CACHE_BYTES, self._thumb_seg_dir)
        self.thumb_seg_cache.set_namespace_splitter(
            lambda vid: ("thumb", vid[2:]) if isinstance(vid, str) and vid.startswith("t_") else ("real", vid)
        )
        self.thumb_meta = {}
        self.thumb_active = set()
        self.thumb_jobs = {}
        self.thumb_procs = {}
        self.thumb_session = set()
        self.thumb_lock = threading.Lock()
        self.thumb_q = queue.Queue()
        self.have_ffmpeg = False

        # 整集缓冲
        self.seg_urls = {}
        self.buf_state = {}
        self.buf_jobs = {}
        self._last_buf_error = {}
        self.buf_lock = threading.Lock()
        self.buf_q = queue.Queue()
        self.meta_lock = threading.Lock()
        self.video_meta = {}

        # 预缓存
        self.pf_lock = threading.Lock()
        self.pf_active = {"vid": None, "token": 0}  # #11: owner = vid+token
        self.pf_next_token = 0
        self.pf_done = set()
        self.pf_control = {}  # G1: 预缓存控制态(paused/cancelled), 缺省=running
        self.pf_threads = {}
        self.pf_segidx = {}
        self.playhead = {}
        self._playhead_dirty = False
        # #19 治本后: playhead 专用锁退役(唯一 tmp 名根上堵撕裂洞), 与生产 __init__ 同构。
        # G3: 全局后台缓存开关 + 锁(与生产 __init__ 同构)
        self._bg_paused = False
        self.bg_lock = threading.Lock()

        # 全部持久化路径
        self.seg_urls_path = os.path.join(cache_dir, "seg_urls.json")
        self.buf_state_path = os.path.join(cache_dir, "buf_state.json")
        self.buf_jobs_path = os.path.join(cache_dir, "buf_jobs.json")
        self.buf_errors_path = os.path.join(cache_dir, "buf_errors.json")
        self.video_meta_path = os.path.join(cache_dir, "video_metadata.json")
        self.pf_done_path = os.path.join(cache_dir, "pf_done.json")
        self.pf_control_path = os.path.join(cache_dir, "pf_control.json")  # G5
        self.bg_state_path = os.path.join(cache_dir, "bg_state.json")      # G3
        self.playhead_path = os.path.join(cache_dir, "playhead.json")

    def _remember_video(self, video, m3u8):
        """从一次 thumb/buffer/warm/play 调用记下该 vid 的元数据。
        video 至少要有 videoId/contentId/cardPackageId/productId, 可选 liveId。
        idempotent: 同 vid 反复调用只会保持最新一组。"""
        try:
            vid = str(int(video["videoId"]))
        except (KeyError, ValueError, TypeError):
            return
        rec = {
            "videoId": int(video["videoId"]),
            "contentId": int(video.get("contentId") or 0) or None,
            "cardPackageId": int(video.get("cardPackageId") or 0) or None,
            "productId": int(video.get("productId") or 0) or None,
            "m3u8": m3u8 if isinstance(m3u8, str) else None,
        }
        if video.get("liveId"):
            try:
                rec["liveId"] = int(video["liveId"])
            except (ValueError, TypeError):
                rec["liveId"] = str(video["liveId"])
        if video.get("duration"):
            try:
                rec["duration"] = int(float(video["duration"]))
            except (ValueError, TypeError):
                pass
        with self.meta_lock:
            old = self.video_meta.get(vid)
            if old == rec:
                return  # 无变化,不重复 IO
            self.video_meta[vid] = rec
            self._save_video_meta()

    def _learn_segments(self, vid, segs):
        """记下该 vid 的有序分片列表 (m3u8 解析出的绝对 URL 序) 并落盘。
        4 处来源 (整集缓冲/预缓存/warm/观看代理) 统一走这一条路, 避免逻辑漂移。
        total 真相 = len(seg_urls[vid]); seg_total 旧字典已删, 总数恒由此派生。
        Plan 2 会在调用方用一把锁包住本方法 (本体只做 set + save, 锁可干净包裹)。
        返回写入的分片数 (供调用方按需用)。"""
        vid = str(vid)
        segs = list(segs or [])
        if not segs:
            return 0
        with self.meta_lock:
            self.seg_urls[vid] = segs
            self._save_seg_urls()  # 持久化, 重启后总数/buckets 立刻能复原
        return len(segs)

    def _vid_counts(self, vid, disk_real, disk_snap):
        """单一真相源: 返回 (cached, total, buckets_basis)。
        cached = 磁盘真相 (该 vid 真实在盘的 .ts/.m4s 段数), 永不塌成 0。
        total  = len(seg_urls[vid]) (m3u8 学到的分片总数), 未知则 None。
        disk_real = vid_stats()['real'] (一次性快照), disk_snap = cached_segs_by_vid()。
        /api/status 与 /api/buffer/segments 都调本方法, 二者结构上不可能再分歧。
        buckets_basis ∈ {'urls','flat','none'}:
          'urls' = seg_urls 与磁盘有交集, 按 URL 逐片上色 (正常);
          'flat' = seg_urls 与磁盘 0 交集但磁盘有片 (clarity 漂移) → 整条按 disk/total 比例填;
          'none' = 没有 seg_urls (重启后只看过一次) → 前端回退比例条。"""
        vid = str(vid)
        disk = (disk_real.get(vid) or {}).get("segments", 0)
        urls = self.seg_urls.get(vid)
        total = len(urls) if urls else None
        if not urls:
            return disk, total, "none"
        cset = disk_snap.get(vid) or set()
        hit = sum(1 for u in urls if u in cset)
        if hit == 0 and disk > 0:
            # clarity 漂移: seg_urls 是某清晰度的 URL, 盘上是另一清晰度。
            # 不能按 URL 算 (会得 0), 改为整条按 disk/total 比例填 (flat)。
            return disk, total, "flat"
        return disk, total, "urls"

    def _save_seg_urls(self):
        """落盘 seg_urls 给重启回载用。set 现场调用，开销很小（每个 vid 一次）。
        seg_urls 按 "单写者-per-key + GIL 原子" 不上锁,这里通过 keys 先快照再逐 key 读取,
        过程中即便有别的 vid 在写也不会让本次落盘的 dict 视图崩。
        写盘统一走 _atomic_write_json: tmp + os.replace + seg_cache.ok 掉盘守卫。"""
        if not self.seg_urls_path:
            return
        # keys 快照可能撞 RuntimeError(dict 改大小);重试几次即可,写事件本身很稀。
        keys = None
        for _ in range(5):
            try:
                keys = list(self.seg_urls.keys())
                break
            except RuntimeError:
                continue
        if keys is None:
            return
        snap = {}
        for k in keys:
            v = self.seg_urls.get(k)
            if v:
                snap[k] = list(v)
        self._atomic_write_json(self.seg_urls_path, snap)

    # ---- 缩略图 ----------------------------------------------------------
    @staticmethod
    def _jpeg_ok(path):
        """JPEG 文件存在且头是 SOI(0xFFD8): 网关被砍中 ffmpeg 时 .jpg 可能半截,
        仅 exists 会误认 ready 让前端展示 broken image。生成时与启动回载共用此校验。"""
        try:
            if os.path.getsize(path) < 16:
                return False
            with open(path, "rb") as fh:
                head = fh.read(3)
            return head[:2] == b"\xff\xd8"  # SOI marker
        except OSError:
            return False

    def _save_thumb_index(self):
        # 落盘全部状态(ready/gen/error/cancelled),不再只存 ready。回载时 gen 会被
        # 当成 error("interrupted"),让用户看到"上次跑到一半,可点重试"。
        # 写盘走 _atomic_write_json(tmp + os.replace + 掉盘守卫): kill -9 中途不再
        # 留半截/零字节索引,否则会丢全部缩略图状态。Plan 3 依赖此原子性,勿重做。
        with self.thumb_lock:
            snap = {k: dict(v) for k, v in self.thumb_meta.items() if v.get("state")}
        # #17: 缩略图持久化用自己的 thumb_dir 健康探针, 与段盘 seg_cache.ok 解耦 ——
        # 段盘掉线绝不冻结缩略图状态落盘(thumb_dir 多在系统盘, 跟段盘是两块盘)。
        self._atomic_write_json(self.thumb_index_path, snap, ok_gate=self._thumb_dir_ok)

    def _save_thumb_jobs(self):
        """落盘 thumb_jobs (重试上下文)。自身在 thumb_lock 下快照, 调用方必须 *不* 持锁。"""
        if not self.thumb_jobs_path:
            return
        with self.thumb_lock:
            items = list(self.thumb_jobs.items())
        out = {}
        for vid, payload in items:
            try:
                v, m, dur, tier = payload
                if isinstance(v, dict) and isinstance(m, str):
                    out[str(vid)] = [v, m, int(dur or 0), int(tier or 2)]
            except Exception:  # noqa: BLE001
                continue
        # #17: 同 thumb_index, 用 thumb_dir 探针闸门, 不被段盘掉线连累。
        self._atomic_write_json(self.thumb_jobs_path, out, ok_gate=self._thumb_dir_ok)

    def _thumb_worker(self):
        while True:
            vid, m3u8, duration, tier = self.thumb_q.get()
            # 全局后台开关(G3): _bg_paused 时不开工生成, 原地空转等待解除(不改 thumb_meta,
            # 该任务仍是 gen, 不入队不消失)。每圈复查取消, 让 per-task cancel 期间照样生效。
            while self._bg_paused:
                if (self.thumb_meta.get(vid) or {}).get("state") == "cancelled":
                    break
                time.sleep(0.3)
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
                        # [发射点 8] worker except 落地 error(沿用上面 !=cancelled 守卫: cancel
                        # 已是终态时不发, 避免与 act 的 cancel 重复)。reason 取 str(e)(emit 内截 200)。
                        self._emit_task_event("thumb", vid, "error", str(e))
            finally:
                with self.thumb_lock:
                    self.thumb_active.discard(vid)
                    self.thumb_procs.pop(vid, None)
                self.thumb_q.task_done()

    def _seg_cache_for(self, vid):
        """按 vid 前缀选物理桶(#1,#8): 缩略图源段(t_前缀)进独立小桶 thumb_seg_cache,
        播放段进 256MB seg_cache。/p 回环、缩略图源预取、has/put 全走此 seam 路由,
        保证两类段物理分离、互不淘汰。cache.py 不识前缀(命名约定是 gateway 的事)。"""
        if isinstance(vid, str) and vid.startswith("t_"):
            return self.thumb_seg_cache
        return self.seg_cache

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
                # [发射点 7] 缺低清流头 -> 早 return error(不抛异常, worker except 抓不到,
                # 必须在此就地发)。终态落地, 非回载快照。
                self._emit_task_event("thumb", vid, "error", "no headers")
            return
        # 缩略图源段已物理隔离到 thumb_seg_cache(#1,#8): 不再灌进播放桶, 也就不会挤出
        # A/B/C 已缓存播放段, 故不再需要 add_protect_vid(tvid) 跨桶保护(那本就覆盖不到
        # 任意已缓存段)。生成完(成功/失败/取消)统一 drop_vid 立即释放源段, 不留尾巴。
        try:
            self._gen_thumbs_inner(vid, tvid, m3u8, tier, out, number, rows)
        finally:
            self.thumb_seg_cache.drop_vid(tvid)

    def _gen_thumbs_inner(self, vid, tvid, m3u8, tier, out, number, rows):
        th = dict(self.video_headers.get(tvid) or {})
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

            for u in urls:
                # 预取期复查取消: 与出队复查(_thumb_worker)/ffmpeg 后复查同口径。取消后立即停下载,
                # 不再把整批低清源段拉完(省带宽 + 减共享缓存压力), 也不进入 Popen 启动 ffmpeg。
                if (self.thumb_meta.get(vid) or {}).get("state") == "cancelled":
                    return
                # 缩略图源段进独立桶 thumb_seg_cache(经 _seg_cache_for 路由), 不挤播放桶(#1,#8)。
                tcache = self._seg_cache_for(tvid)
                if tcache.has((u, tvid)):
                    continue
                try:
                    d, c, _ = self.pri_fetch(tier, th, u)
                    tcache.put((u, tvid), (c or "video/mp2t", d))
                except Exception:  # noqa: BLE001
                    _log.debug("缩略图源分片预取失败：%s", u, exc_info=True)
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
        # -rw_timeout(微秒): 源 HTTP 读卡住时让 ffmpeg 自身在源头快速失败, 不必干等总超时。
        cmd = ["ffmpeg", "-y", "-nostdin",
               "-rw_timeout", "30000000",
               "-allowed_extensions", "ALL", "-extension_picky", "0",
               "-skip_frame", "nokey", "-i", proxied,
               "-an", "-vf", vf, "-frames:v", "1", "-q:v", "6", out, "-loglevel", "error"]
        # 用 Popen 而非 call：保留进程句柄，取消任务时可 terminate 掉正在跑的 ffmpeg。
        # Popen 在锁外 fork/exec：fork 可能有延迟，不该让它阻塞其它 thumb_lock 持有者
        # (状态读取/取消)。fork 完成后再进锁仅登记句柄。
        proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL)
        with self.thumb_lock:
            self.thumb_procs[vid] = proc
        # 有界等待(#4): 挂死/慢源不能无限占住一个 thumb worker。超时常量按 env 实时取(隔离测试可调小),
        # 默认回落模块 _THUMB_FFMPEG_TIMEOUT。超时则 terminate→(5s)→kill, rc 置 -1 走下方 error 分支。
        timeout = int(os.environ.get("YD_THUMB_FFMPEG_TIMEOUT") or _THUMB_FFMPEG_TIMEOUT)
        timed_out = False
        try:
            rc = proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            try:
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=5)
            except Exception:  # noqa: BLE001
                _log.debug("缩略图 ffmpeg 超时后清理失败 vid=%s", vid, exc_info=True)
            rc = -1
        # 取消复查与终态落地必须在同一把锁内：否则二者之间有窗口，刚好取消进来会被 ready/error 覆盖。
        # _save_thumb_index 自身要拿 thumb_lock（不可重入），故用标记、出锁后再存。
        save_idx = False
        with self.thumb_lock:
            self.thumb_procs.pop(vid, None)
            # 生成途中被取消（terminate）：保持 cancelled 终态，别落成 ready/error
            if (self.thumb_meta.get(vid) or {}).get("state") == "cancelled":
                save_idx = True  # cancelled 也要落盘(全态持久化)
            elif rc == 0 and self._jpeg_ok(out):
                self.thumb_meta[vid] = {"state": "ready", "url": "/thumbs/%s.jpg" % vid,
                                        "number": number, "column": THUMB_COLS,
                                        "width": THUMB_W, "height": THUMB_H}
                save_idx = True
                # [发射点 5] gen->ready 终态落地(thumb 历史的"完成"用 done 表示)。
                # 在 cancelled 守卫之内: 被取消的不会进这支, 故不与 act cancel 重复(R7)。
                self._emit_task_event("thumb", vid, "done")
            else:
                # rc==0 但文件损坏(半截/非 JPEG) 也算 error: 与启动校验同口径。
                # 超时单独成因(reason 含 timeout, 供 web 区分"卡死被砍"vs"ffmpeg 真失败")。
                if timed_out:
                    reason = "ffmpeg timeout %ds" % timeout
                elif rc != 0:
                    reason = "ffmpeg rc=%d" % rc
                else:
                    reason = "bad jpeg"
                self.thumb_meta[vid] = {"state": "error", "reason": reason}
                save_idx = True  # error 也落盘,重启后用户看到可重试
                # [发射点 6] gen->error(ffmpeg rc!=0 或 jpeg 坏)。reason 就地取(R8)。
                self._emit_task_event("thumb", vid, "error", reason)
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
            if st and st.get("state") in ("ready", "gen"):
                return st
            # started_ts: watchdog 据此判定卡死(#7); ffmpeg 有界超时也据此口径。
            self.thumb_meta[vid] = {"state": "gen", "started_ts": time.time()}
            self.thumb_jobs[vid] = (video, m3u8, duration, tier)  # 供重试重新入队
            self.thumb_session.add(vid)                            # 标记为本会话任务
        # 出锁后落 thumb_jobs / thumb_index, 给重启重试上下文。
        self._save_thumb_jobs()
        self._save_thumb_index()
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
        # 缓冲过程加 LRU 保护: 边缓冲边播别集时, 不希望本 vid 早分片被淘汰自身的新分片。
        # 多 vid 同时缓冲也都受保护(set 而非单 vid)。finally 里移除。
        self.seg_cache.add_protect_vid(vid)
        self._playhead_dirty = True  # 新增保护集, 触发 playhead.json 落盘(<=5s)
        th = play_headers(self.session, video, m3u8)
        with self.vh_lock:
            self.video_headers[vid] = th
        pl, _, _ = self.pri_fetch(2, th, m3u8)
        text = pl.decode("utf-8", "replace")
        segs = parse_segments(text, m3u8)
        self._learn_segments(vid, segs)  # 设 seg_urls + 落盘 (供逐片 bitmap / 总数)
        # key 单独跟踪: 缺 key 会让 ffmpeg 解密失败/播放黑屏, 必须算 error 而非 done。
        key_urls = []
        for ln in text.splitlines():
            if ln.startswith("#EXT-X-KEY") and 'URI="' in ln:
                _km = re.search(r'URI="([^"]+)"', ln)
                if _km:
                    key_urls.append(urllib.parse.urljoin(m3u8, _km.group(1)))
        urls = key_urls + list(segs)  # key 优先下

        # 逐片顺序下载（并发本就收紧到 1：手动缓存最低优先，抢占时在途下载越少观看越稳）。
        # 每片前复查 buf_state：被暂停/取消则即时收手并返回该终态——已下分片留在缓存里，
        # 继续时重新入队会被 seg_cache.has 跳过，等价于断点续传。
        key_failed = 0  # AES key 拉取失败数(任何 ≥1 都得 error,否则播放解密失败)
        seg_failed = []  # 分片拉取失败 URL 列表(超过阈值不再算 done)
        for u in urls:
            with self.buf_lock:
                st = self.buf_state.get(vid)
            if st in ("paused", "cancelled"):
                return st
            # 全局后台开关(G3): _bg_paused 时原地空转(不前进、不改 buf_state, 仍留 working),
            # 解除后从本片续。期间仍每圈复查 buf_state, 让 per-task pause/cancel 照样即时生效。
            while self._bg_paused:
                with self.buf_lock:
                    st = self.buf_state.get(vid)
                if st in ("paused", "cancelled"):
                    return st
                time.sleep(0.3)
            if self.seg_cache.has((u, vid)):
                continue
            # 主动让 LIVE: 若现在有用户在看视频(LIVE 档活跃), MANUAL 暂停一下,
            # 让 LIVE 把当前突发分片下完再继续。priority_gate.acquire 内部会等,
            # 但已经 in-flight 的 HTTP 不可中断 — 这里主动检测降低发起新请求的频率,
            # 配合 grace 机制让 LIVE 的实际带宽占用更稳定。
            if self.gate.n[0] > 0:
                time.sleep(0.3)
            is_key = u in key_urls
            try:
                d, c, _ = self.pri_fetch(2, th, u)
                self.seg_cache.put((u, vid), (c or "video/mp2t", d))  # 每片下完即可被命中
            except Exception as e:  # noqa: BLE001
                _log.warning("整集缓冲分片失败 vid=%s%s: %s", vid,
                             " (KEY)" if is_key else "", str(e)[:120])
                if is_key:
                    key_failed += 1
                    self._last_buf_error[vid] = "AES key 拉取失败: %s" % (str(e)[:120])
                else:
                    seg_failed.append(u)
                    self._last_buf_error[vid] = "分片下载失败 %d 个: %s" % (
                        len(seg_failed), str(e)[:80])
        # 严判完成: 任何 key 失败 → error;否则按分片成功比例
        if key_failed > 0:
            return "error"
        if seg_failed:
            # 分片有失败但 key OK: 算"部分完成"(用户能播但可能跳片)
            # 实际架构没有 "partial" 终态, 折中: 失败 >5% 算 error, 否则 done(降级允许)。
            # 用整数阈值避免 int/float 混比: ceil(5%) 至少 1。19 片时阈值=1, 失败 1 即 error。
            threshold = max(1, math.ceil(len(segs) * 0.05))
            if len(seg_failed) >= threshold:
                return "error"
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
                self._save_buf_state()
            try:
                result = self._buffer_one(video, m3u8)  # "done"/"paused"/"cancelled"/"error"
            except Exception as e:  # noqa: BLE001
                _log.warning("整集缓冲失败 vid=%s", vid, exc_info=True)
                self._last_buf_error[vid] = "m3u8 拉取/解析失败: %s" % (str(e)[:150])
                result = "error"
            finally:
                # 缓冲终态(任何结局): 摘掉 LRU 保护, 让别的缓冲/淘汰能动这一集的分片
                self.seg_cache.remove_protect_vid(vid)
                self._playhead_dirty = True  # 保护集变了, 触发 playhead.json 重刷
            with self.buf_lock:
                # 仅当仍是 working 才落地结果；执行途中被 action 改成 paused/cancelled 则遵从之。
                # pop 也必须在该守卫内：否则"刚下完就被暂停"会误删重试上下文，导致继续无门。
                if self.buf_state.get(vid) == "working":
                    self.buf_state[vid] = result
                    if result == "done":
                        self.buf_jobs.pop(vid, None)  # 成功完成后释放重试上下文
                        self._save_buf_jobs()
                    # 终态非 error: 清掉旧失败原因(可能是上一次 retry 前的); error: 落盘原因。
                    if result != "error":
                        self._last_buf_error.pop(vid, None)
                    self._save_buf_errors()
                    # [发射点 1] worker 终态落地(守卫 buf_state==working): working->done/error。
                    # done->working->done 物理上两次进到这里, 各发一条不同 seq 的事件(R1)。
                    # 仅 done/error 在此发(R2: paused/cancelled 由 act_buffer 发; 若被 act 改走
                    # state, 上面守卫为 False 不会进来)。error reason 此刻读 _last_buf_error(R8:
                    # 分片/key 失败已写到最终值)。emit 仍在 buf_lock 内, 只嵌套 task_lock 不冲突。
                    if result in ("done", "error"):
                        self._emit_task_event(
                            "buffer", vid, result,
                            self._last_buf_error.get(vid) if result == "error" else None,
                        )
                self._save_buf_state()
            self.buf_q.task_done()

    def start_buffer(self, video, m3u8):
        vid = str(video["videoId"])
        with self.buf_lock:
            # done 也跳过：整集已缓存好的不再重排（批量计数据此判定为「跳过」）。
            if self.buf_state.get(vid) in ("queued", "working", "paused", "done"):
                return False
            self.buf_state[vid] = "queued"
            self.buf_jobs[vid] = (video, m3u8)  # 供继续/重试重新入队
            self._save_buf_state()
            self._save_buf_jobs()
        self._remember_video(video, m3u8)
        self.buf_q.put((video, m3u8))
        return True

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
                    # [发射点 2] working->paused 由 act 发(R2): worker 此后复查到 paused 收手,
                    # 其终态守卫 buf_state==working 不成立, 不会重复发。
                    self._emit_task_event("buffer", vid, "paused")
            elif verb == "resume":
                ok = st == "paused" and job is not None
                if ok:
                    self.buf_state[vid] = "queued"
                    self._last_buf_error.pop(vid, None)
                    requeue = job
                    # resume 转入 queued(非终态), 不发: 真正完成时 worker 会发 done/error。
            elif verb == "cancel":
                ok = st in ("queued", "working", "paused")
                if ok:
                    self.buf_state[vid] = "cancelled"  # 排队中的靠出队复查丢弃；working 靠循环复查
                    self.buf_jobs.pop(vid, None)
                    # [发射点 3] q/w/p->cancelled 由 act 发(R2)。排队条目残留在 buf_q 会被
                    # worker 出队复查丢弃(不产生 state 变化), 那条路径绝不再补发(R7), 否则一次
                    # cancel 出两条。
                    self._emit_task_event("buffer", vid, "cancelled")
            elif verb == "retry":
                ok = st == "error" and job is not None
                if ok:
                    self.buf_state[vid] = "queued"
                    self._last_buf_error.pop(vid, None)
                    requeue = job
            else:
                return {"ok": False, "vid": vid, "kind": "buffer", "state": st, "reason": "bad verb"}
            new_state = self.buf_state.get(vid)
            if ok:
                # 任何状态转换后都落盘 state + jobs(cancel 删了 jobs, 其它没动 jobs 也一样落盘)
                self._save_buf_state()
                self._save_buf_jobs()
                self._save_buf_errors()  # retry/resume 清了 reason 也要落盘
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
                    self.thumb_meta[vid] = {"state": "gen", "started_ts": time.time()}
                    self.thumb_session.add(vid)  # 重试也是"本会话任务",否则 UI 会把它从本会话列表丢掉
                    requeue = job
            else:
                return {"ok": False, "vid": vid, "kind": "thumb", "state": st, "reason": "bad verb"}
            new_state = (self.thumb_meta.get(vid) or {}).get("state")
            save_idx_after = ok  # 状态变了就落盘 thumb_index(cancelled/gen 都会跨重启可见)
        if save_idx_after:
            self._save_thumb_index()
        if proc_to_kill is not None:
            try:
                proc_to_kill.terminate()
            except Exception:  # noqa: BLE001
                _log.debug("终止缩略图 ffmpeg 失败 vid=%s", vid, exc_info=True)
        if requeue is not None:
            video, m3u8, duration, tier = requeue
            # 关键修复: 重试(尤其重启后)必须重建 t_<vid> 头, 否则 _gen_thumbs 拿到空头 → "no headers"。
            # 启动只重建普通 vid 头(video_meta), 不含缩略图低清流头; 这里从持久化的 job 元组重建。
            try:
                with self.vh_lock:
                    self.video_headers["t_" + vid] = play_headers(self.session, video, m3u8)
            except Exception:  # noqa: BLE001
                _log.warning("重试时重建缩略图头失败 vid=%s", vid, exc_info=True)
            self.thumb_q.put((vid, m3u8, duration, tier))
        reason = None if ok else "状态 %s 下不能执行 %s" % (st, verb)
        return {"ok": ok, "vid": vid, "kind": "thumb", "state": new_state, "reason": reason}

    def act_prefetch(self, vid, verb):
        """预缓存(自动)任务：pause/resume/cancel。返回 {ok,vid,kind,state,reason?}。

        pf_control[vid] ∈ {paused, cancelled}; 缺省(absent)= running。镜像 act_buffer 的
        即时复查 + 幂等约定: 非法转换返回 ok=False(reason 为人话中文), 不抛错。

        - pause:  running -> paused。worker 下一片复查到 paused 即原地空转(不前进不退出),
                  resume 时不必重新 /api/play。
        - resume: paused -> running。删除控制态; 若 worker 线程已不在(如 kill-9 重启后),
                  按 video_meta 里的 m3u8 重启 worker 续缓存。
        - cancel: running/paused -> cancelled。set 该讲 worker 的 stop-Event(等同 stop.is_set),
                  worker 收手退出; 控制态留 cancelled, 直到再次 /api/play(切回该讲)清掉重来。
        """
        vid = str(vid)
        restart_m3u8 = None
        with self.pf_lock:
            cur = self.pf_control.get(vid)  # None=running / "paused" / "cancelled"
            cur_state = cur or "running"
            thread_entry = self.pf_threads.get(vid)
            has_ctx = bool(
                (thread_entry and thread_entry[0].is_alive())
                or self.pf_active.get("vid") == vid
                or (self.video_meta.get(vid) or {}).get("m3u8")
            )
            if verb == "pause":
                # running 才能暂停; 缺上下文(从没预缓存过这讲)无从暂停。
                ok = cur_state == "running" and has_ctx
                if ok:
                    self.pf_control[vid] = "paused"
            elif verb == "resume":
                # 只有 paused 能继续; 需要 m3u8 才能(必要时)重启 worker。
                m3u8 = (self.video_meta.get(vid) or {}).get("m3u8")
                ok = cur_state == "paused" and bool(m3u8)
                if ok:
                    self.pf_control.pop(vid, None)  # 回到缺省 running
                    alive = bool(thread_entry and thread_entry[0].is_alive()
                                 and not thread_entry[1].is_set())
                    if not alive:
                        restart_m3u8 = m3u8  # worker 没了(kill-9 重启等): 出锁后重启
            elif verb == "cancel":
                ok = cur_state in ("running", "paused") and has_ctx
                if ok:
                    self.pf_control[vid] = "cancelled"
                    if thread_entry:
                        thread_entry[1].set()  # 等同 stop.is_set(): worker 复查后退出
            else:
                return {"ok": False, "vid": vid, "kind": "prefetch",
                        "state": cur_state, "reason": "未知操作 %s" % verb}
            if ok:
                self._save_pf_control()
            new_state = self.pf_control.get(vid) or "running"
        if restart_m3u8 is not None:
            # start_prefetch 自带 pf_lock, 放锁外调(避免重入); 它会分配新 token + 起新线程,
            # worker 复查 pf_control 见缺省=running 正常推进。
            self.start_prefetch(vid, restart_m3u8)
        if ok:
            reason = None
        elif verb not in ("pause", "resume", "cancel"):
            reason = "未知操作 %s" % verb
        elif verb == "resume" and cur_state != "paused":
            reason = "该讲未处于暂停状态，无法继续"
        elif verb == "resume":
            reason = "该讲未在预缓存，无法继续"
        elif not has_ctx:
            reason = "该讲未在预缓存"
        else:
            reason = "状态 %s 下不能执行 %s" % (cur_state, verb)
        return {"ok": ok, "vid": vid, "kind": "prefetch", "state": new_state, "reason": reason}

    # ---- 自动预缓存 ------------------------------------------------------
    def _pf_new_token(self, vid):
        """[#11] 分配一个唯一 token 并把 pf_active 的 owner 设为 (vid, token)。
        每个新 worker 启动时调一次; 调用方须持 pf_lock(本方法不自锁, 由 start_prefetch
        统一在 pf_lock 内调用以保证"设 active + 分配 token + 起线程"原子)。返回新 token。"""
        self.pf_next_token += 1
        tok = self.pf_next_token
        self.pf_active["vid"] = vid
        self.pf_active["token"] = tok
        return tok

    def _pf_clear_if_owner(self, vid, token):
        """[#11] CAS 清理: 仅当当前 pf_active 仍属于 (vid, token) 这个 worker 才清空。
        A→B→A 快切后, 被切走的旧 worker token 已过期, pf_active 已被新 worker 改写,
        此处 token 不匹配 -> 不动, 避免旧 worker 的 finally 误杀新 owner。"""
        with self.pf_lock:
            if self.pf_active.get("vid") == vid and self.pf_active.get("token") == token:
                self.pf_active["vid"] = None

    def _prefetch_worker(self, vid, m3u8, stop, token):
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
        self._learn_segments(vid, segs)  # 设 seg_urls + 落盘 (供逐片 bitmap / 总数)
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
        # 任何退出路径（被切走 return / 整集缓存完成 return / 循环条件退出）都经 finally
        # 清掉 pf_active，避免 worker 退出后 pf_active 仍残留本 vid 误导状态/重建判断。
        # [#11] "我仍是 owner" = pf_active 的 vid 且 token 都匹配本 worker;
        # A→B→A 快切后旧 worker token 过期, 即使 vid 又变回 A 也立即让位给新 worker。
        def _is_owner():
            a = self.pf_active
            return a.get("vid") == vid and a.get("token") == token

        def _idle():
            # 暂停: 本讲被 pause(pf_control=paused) 或全局后台开关 _bg_paused。
            # 二者都让 worker 原地空转(不前进、不退出), 解除后从原位置续(无需重新 /api/play)。
            # cancelled 不在此 —— 它由 _cancelled() 走 stop 同款退出路径。
            return self.pf_control.get(vid) == "paused" or self._bg_paused

        def _cancelled():
            return self.pf_control.get(vid) == "cancelled"
        try:
            while not stop.is_set() and _is_owner() and not _cancelled():
                # 暂停态(本讲 paused 或全局 bg_paused): 原地空转, 不前进也不退出, 不动 pf_done。
                if _idle():
                    time.sleep(0.3)
                    continue
                center = self.playhead.get(vid, 0)
                fetched = recenter = False
                for idx in _order(center):
                    if stop.is_set() or not _is_owner() or _cancelled():
                        return  # 被切走/被取消 -> 停（已缓存的保留，回来可续）
                    # 每片复查暂停: 与 buffer 逐片复查 buf_state 同口径, 即时收手。
                    if _idle():
                        recenter = True  # 跳出 for, 回到外层 while 进入 idle 空转
                        break
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
                    # 整集都在缓存里 = 这讲预缓存完成：记进 pf_done(供"已完成"+任务历史显示),
                    # 落盘 pf_done.json 跨重启保留, 然后退出本线程。
                    with self.pf_lock:
                        was_done = vid in self.pf_done  # [R6] 幂等守卫: 已 done 过不重发
                        self.pf_done.add(vid)
                    self._save_pf_done()
                    # [发射点 10] 整集满 ->done。仅首次(not was_done)才发: 同讲反复看满
                    # pf_done.add 是 no-op, 无条件发会重复(R6)。emit 在 pf_lock 外, 只取 task_lock。
                    if not was_done:
                        self._emit_task_event("prefetch", vid, "done")
                    return
        finally:
            # [#11] CAS 清: 只在 pf_active 仍属于本 worker(vid+token 双匹配)时清。
            # A→B→A 快切后本 worker 已是"旧"worker, token 过期 -> 不动新 owner。
            self._pf_clear_if_owner(vid, token)

    def start_prefetch(self, vid, m3u8):
        with self.pf_lock:
            # 切回该讲(/api/play 触发)= 新一轮预缓存会话: 清掉旧的 cancelled/paused 控制态,
            # 让新 worker 正常推进(否则一旦 cancel 过, 重看也永远不预缓存)。act_prefetch.resume
            # 不走这里(它显式保留语义, 自己 pop paused)。
            if self.pf_control.pop(vid, None) is not None:
                self._save_pf_control()
            # 清掉已死线程(老 vid 的 worker 跑完早退): 否则 pf_threads 随会话无限膨胀。
            # 只删非当前 vid 且线程已不 alive 的; 当前 vid 下面单独判活/复用。
            dead = [ov for ov, (t, _ev, _tk) in self.pf_threads.items()
                    if ov != vid and not t.is_alive()]
            for ov in dead:
                self.pf_threads.pop(ov, None)
            for ovid, (_, ev, _tk) in self.pf_threads.items():
                if ovid != vid:
                    ev.set()  # 暂停其它正在下的
            cur = self.pf_threads.get(vid)
            # 仅当线程存活且 stop-Event 未被 set 时才视为"活跃 worker"；
            # stop-Event 已 set 说明线程正在退出（如 A→B→A 快切），需重建。
            if cur and cur[0].is_alive() and not cur[1].is_set():
                # 复用活 worker: pf_active 的 owner 仍是它(同 vid 同 token), 重申一遍即可,
                # 不分配新 token(否则会把这个活 worker 自己"切走")。
                self.pf_active["vid"] = vid
                self.pf_active["token"] = cur[2]
                return
            ev = threading.Event()  # 新的未 set Event，不能复用旧的
            # [#11] 新 worker 拿唯一 token, pf_active owner 原子切到 (vid, token)。
            tok = self._pf_new_token(vid)
            t = threading.Thread(target=self._prefetch_worker, args=(vid, m3u8, ev, tok),
                                 daemon=True)
            self.pf_threads[vid] = (t, ev, tok)
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
            elif path == "/api/status":
                self._api_status(qs)
            elif path == "/api/task_events":
                self._api_task_events(qs)
            elif path == "/api/buffer/segments":
                self._api_buffer_segments(qs)
            elif path.startswith("/thumbs/"):
                self._serve_thumb(path)
            elif path == "/p":
                self._proxy(qs)
            elif path == "/api/_debug":
                gw = self.gw
                _real = gw.seg_cache.vid_stats()["real"]
                with gw.pf_lock:
                    pf_threads = sorted(gw.pf_threads.keys())
                with gw.buf_lock:
                    buf_states = dict(gw.buf_state)
                    buf_errors = dict(gw._last_buf_error)
                self._send_json({
                    "active": gw.pf_active["vid"],
                    "cacheItems": len(gw.seg_cache.meta),
                    "cacheBytes": gw.seg_cache.size,
                    # 缩略图源段独立物理桶(#1,#8): e2e 断言它与播放桶 seg_cache 物理分离
                    # (不同目录/不同 size/独立上限), 缩略图生成不挤播放段。
                    "thumbSegItems": len(gw.thumb_seg_cache.meta),
                    "thumbSegBytes": gw.thumb_seg_cache.size,
                    "thumbSegMax": gw.thumb_seg_cache.max,
                    "thumbSegDir": gw.thumb_seg_cache.dir,
                    "segCacheDir": gw.seg_cache.dir if gw.seg_cache.persist else "",
                    # vid -> 磁盘真实分片数 (e2e 断言 cached 三端一致用)
                    "vidReal": {v: d.get("segments", 0)
                                for v, d in _real.items()},
                    # vid -> len(seg_urls) (e2e 断言 total 真相用)
                    "vidTotal": {v: len(u) for v, u in gw.seg_urls.items()},
                    "extraProtect": gw.seg_cache.extra_protect_vids(),
                    "liveVid": gw.seg_cache.protect_vid,
                    "pfThreads": pf_threads,
                    "bufStates": buf_states,
                    "bufErrors": buf_errors,
                })
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
            elif parsed.path == "/api/bg/pause":
                self._api_bg_pause()
            elif parsed.path == "/api/cache-dir":
                self._api_set_cache_dir()
            elif parsed.path == "/api/warm":
                self._api_warm()
            elif parsed.path == "/api/_test_emit":
                self._api_test_emit()
            else:
                self._send_bytes(404, b"not found", "text/plain")

        def _read_json(self):
            length = int(self.headers.get("Content-Length") or 0)
            if length > MAX_BODY:
                self._send_json({"error": "请求体过大"}, 413)
                return None
            return json.loads(self.rfile.read(length).decode("utf-8"))

        def _parse_video(self, d):
            """从请求 dict 解析缩略图/缓冲共用的视频参数，返回 (video, src, duration) 或 None。
            video: {videoId,contentId,cardPackageId,productId,[liveId]}; src 经 _ALLOWED_HOSTS 白名单校验。
            缓冲方忽略 duration; 缩略图方需要它算帧数。"""
            try:
                video = {"videoId": int(d["videoId"]), "contentId": int(d["contentId"]),
                         "cardPackageId": int(d["cardPackageId"]), "productId": int(d["productId"])}
            except (KeyError, ValueError, TypeError):
                return None
            # 直播回放：play_headers 据此挂 Liveid 头去取 AES key；点播缺省即可。
            live_id = d.get("liveId")
            if live_id:
                video["liveId"] = str(live_id)
            src = d.get("src") or ""
            if not isinstance(src, str):
                return None
            p = urllib.parse.urlparse(src)
            if p.scheme not in ("http", "https") or (p.hostname or "").lower() not in _ALLOWED_HOSTS:
                return None
            try:
                duration = int(float(d.get("duration") or 0))
            except (ValueError, TypeError):
                duration = 0
            return video, src, duration

        def _buffer_video(self, d):
            """缓冲用：高清地址 src。返回 (video, m3u8) 或 None（丢弃 duration）。"""
            tv = self._parse_video(d)
            return (tv[0], tv[1]) if tv else None

        def _api_warm(self):
            """轻量回填:给一批 (vid, src, ids, liveId?), 只取 m3u8 学到分片顺序+总数,
            不下分片。给设置页"重启后大量已缓存讲总数未知"一次性补齐用。"""
            try:
                payload = self._read_json()
            except Exception as e:  # noqa: BLE001
                _log.debug("warm 请求体解析失败：%s", e)
                self._send_json({"error": str(e)}, 400)
                return
            if payload is None:
                return  # _read_json 已回 413
            warmed = 0
            skipped = 0
            errors = []
            # 一次性快照所有 vid 的磁盘 URL 集合,后面 stale 检测复用,避免每条都加锁。
            disk_by_vid = self.gw.seg_cache.cached_segs_by_vid()
            for d in payload.get("videos") or []:
                tv = self._thumb_video(d)  # 复用 (video, src, duration) 解析；duration 忽略
                if not tv:
                    errors.append({"videoId": d.get("videoId"), "reason": "bad payload"})
                    continue
                video, m3u8, _ = tv
                vid = str(video["videoId"])
                # 已有 seg_urls: 检查它和磁盘是否有交集。0 交集 = clarity 漂移(旧 seg_urls 是低清,
                # 盘上分片是高清,或反之),要重新拉新 src 的 m3u8。否则保持 skip。
                existing = self.gw.seg_urls.get(vid)
                # 任何 warm 调用都反向镜像 video metadata (即便 skip 了 seg_urls 这一步,
                # 重启后网关也知道这个 vid 的 src/ids,未来可以独立自愈)。
                # 带上原始 d 里的 duration/liveId(_thumb_video 不返回 duration 字段)。
                self.gw._remember_video({**video, "duration": d.get("duration"),
                                         "liveId": d.get("liveId")}, m3u8)
                if existing:
                    disk_urls = disk_by_vid.get(vid) or set()
                    if disk_urls and not any(u in disk_urls for u in existing):
                        _log.info("seg_urls vid=%s 与磁盘 0 交集, 推断 clarity 漂移, 重新 warm", vid)
                    else:
                        skipped += 1
                        continue
                try:
                    th = play_headers(self.gw.session, video, m3u8)
                    with self.gw.vh_lock:
                        self.gw.video_headers[vid] = th
                    data, _ctype, _st = self.gw.pri_fetch(2, th, m3u8)  # MANUAL 档,不抢观看带宽
                    text = data.decode("utf-8", "replace")
                    segs = parse_segments(text, m3u8)
                    if not segs:
                        errors.append({"videoId": video["videoId"], "reason": "no segments"})
                        continue
                    self.gw._learn_segments(vid, segs)  # 设 seg_urls + 落盘
                    warmed += 1
                except Exception as e:  # noqa: BLE001
                    _log.debug("warm 失败 vid=%s", vid, exc_info=True)
                    errors.append({"videoId": video["videoId"], "reason": str(e)[:200]})
            self._send_json({"warmed": warmed, "skipped": skipped, "errors": errors})

        def _api_test_emit(self):
            """仅测试用: 直接驱动 _emit_task_event, 不依赖真实网络/分片下载。
            生产绝不启用: 必须设环境变量 YD_TEST_EMIT=1 才暴露, 否则恒 404。
            隔离 e2e 用它精确制造 done→cancel→done 等终态序列, 复刻"两条不同 seq done"
            的核心失败信号(旧字符串-diff 方案此处只剩 1 条 = FAIL)。
            body: {"events": [{"kind","vid","state","reason"?}, ...]} 顺序逐条 emit。"""
            if os.environ.get("YD_TEST_EMIT") != "1":
                self._send_bytes(404, b"not found", "text/plain")
                return
            try:
                payload = self._read_json()
            except Exception as e:  # noqa: BLE001
                self._send_json({"error": str(e)}, 400)
                return
            if payload is None:
                return  # _read_json 已回 413
            n = 0
            for ev in (payload.get("events") or []):
                kind = ev.get("kind")
                vid = ev.get("vid")
                state = ev.get("state")
                if not (isinstance(kind, str) and state and vid is not None):
                    continue
                # #15 e2e: 可选 productId 先经 _remember_video 落进 video_meta, 让真实
                # _emit_task_event 从 video_meta 盖上 productId(走生产同一路径, 不绕过)。
                pid = ev.get("productId")
                if pid is not None:
                    try:
                        self.gw._remember_video(
                            {"videoId": int(vid), "productId": int(pid)}, None)
                    except (TypeError, ValueError):
                        pass
                self.gw._emit_task_event(kind, vid, state, ev.get("reason"))
                n += 1
            self._send_json({"emitted": n, "seq": self.gw._task_seq,
                             "epoch": self.gw._task_epoch})

        def _api_buffer_batch(self):
            try:
                payload = self._read_json()
            except Exception as e:  # noqa: BLE001
                _log.debug("请求体解析失败：%s", e)
                self._send_json({"error": str(e)}, 400)
                return
            if payload is None:
                return  # _read_json 已回 413
            queued = skipped = 0
            # skippedReasons(G4): {vid: 人话中文原因}, 让 web 能说清"哪几讲为何没排进去"。
            skipped_reasons = {}
            for d in payload.get("videos") or []:
                bv = self._buffer_video(d)
                if not bv:
                    skipped += 1
                    vk = str(d.get("videoId") or "?")
                    skipped_reasons[vk] = "参数无效或地址不在白名单"
                    continue
                # start_buffer 在 buf_lock 内判重并入队，返回是否真排入（避免无锁预读 buf_state）。
                if self.gw.start_buffer(*bv):
                    queued += 1
                else:
                    skipped += 1
                    vk = str(bv[0].get("videoId"))
                    with self.gw.buf_lock:
                        st = self.gw.buf_state.get(vk)
                    skipped_reasons[vk] = {
                        "done": "整集已缓存完成",
                        "working": "正在缓存中",
                        "queued": "已在缓存队列",
                        "paused": "已暂停(去任务列表继续)",
                    }.get(st, "已在缓存中")
            self._send_json({"queued": queued, "skipped": skipped,
                             "skippedReasons": skipped_reasons})

        def _api_tasks_action(self):
            """任务操作统一入口：{verb, kind, vid}。verb∈pause/resume/cancel/retry。
            网关侧即时复查当前状态再决策；返回操作后的最新状态（成功 200，非法转换 409）。
            kind∈buffer/thumb/prefetch。prefetch(自动预缓存)支持 pause/resume/cancel(不支持
            retry: 切回该讲即重新预缓存); thumb 仅 cancel/retry(ffmpeg 原子无续传)。"""
            try:
                payload = self._read_json()
            except Exception as e:  # noqa: BLE001
                self._send_json({"error": str(e)}, 400)
                return
            if payload is None:
                return  # _read_json 已回 413
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
            elif kind == "prefetch":
                if verb == "retry":
                    self._send_json({"error": "预缓存不支持重试(切回该讲即重新预缓存)"}, 400)
                    return
                res = self.gw.act_prefetch(vid, verb)
            else:
                self._send_json({"error": "该任务不可操作"}, 400)
                return
            self._send_json(res, 200 if res.get("ok") else 409)

        def _api_bg_pause(self):
            """全局后台缓存开关(G3): body {paused: bool} -> {ok, paused}。
            置位即落盘 bg_state.json 跨重启保留; 三种后台 worker(buffer/thumb/prefetch)
            读 self._bg_paused 决定是否原地空转, 不改各自 per-task 状态。"""
            try:
                payload = self._read_json()
            except Exception as e:  # noqa: BLE001
                self._send_json({"error": str(e)}, 400)
                return
            if payload is None:
                return  # _read_json 已回 413
            if "paused" not in payload or not isinstance(payload.get("paused"), bool):
                self._send_json({"error": "需要 boolean 字段 paused"}, 400)
                return
            paused = bool(payload["paused"])
            with self.gw.bg_lock:
                self.gw._bg_paused = paused
                self.gw._save_bg_state()
            self._send_json({"ok": True, "paused": paused})

        def _api_buffer_segments(self, qs):
            """逐片缓存 bitmap（"已缓存的地方"）。可传多个 vid；用 buckets 把分片压成
            定长格子(每格=该区间已缓存占比 0..1)，无论分片多少都给定长、可上色的一条。
            cached/total 由 _vid_counts 统一计算 (与 /api/status 同源, 结构上不可能分歧)。
            没有有序分片列表时 buckets=null，前端回退到比例条；clarity 漂移时 buckets 给
            整条 disk/total 比例填(flat)，避免按 URL 匹配算出 0 而误显示"未缓存"。"""
            vids = qs.get("vid") or qs.get("videoId") or []
            try:
                nb = int((qs.get("buckets") or ["60"])[0])
            except (ValueError, TypeError):
                nb = 60
            nb = max(1, min(nb, 400))
            snap = self.gw.seg_cache.cached_segs_by_vid()  # 一次持锁快照，避免逐 url 加锁
            disk_real = self.gw.seg_cache.vid_stats()["real"]
            out = {}
            for vid in vids:
                vid = str(vid)
                cached, total, basis = self.gw._vid_counts(vid, disk_real, snap)
                urls = self.gw.seg_urls.get(vid)
                ph = self.gw.playhead.get(vid)
                pos = (ph / total) if (ph is not None and total) else None
                if basis == "none" or not urls:
                    out[vid] = {"total": total, "cached": cached,
                                "buckets": None, "playhead": None}
                    continue
                n = len(urls)
                if basis == "flat":
                    # clarity 漂移: 不能按 URL 上色, 整条按已缓存比例平铺。
                    frac = round(cached / n, 3) if n else 0
                    b = min(nb, n)
                    cells = [frac for _ in range(b)]
                else:  # "urls": 正常逐片上色
                    cset = snap.get(vid) or set()
                    flags = [1 if u in cset else 0 for u in urls]
                    b = min(nb, n)
                    cells = []
                    for i in range(b):
                        lo, hi = i * n // b, (i + 1) * n // b
                        seg = flags[lo:hi]
                        cells.append(round(sum(seg) / len(seg), 3) if seg else 0)
                out[vid] = {"total": total, "cached": cached, "buckets": cells, "playhead": pos}
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
            if payload is None:
                return  # _read_json 已回 413
            raw = (payload.get("dir") or "").strip()
            if not raw:
                self._send_json({"error": "缓存目录不能为空"}, 400)
                return
            # realpath（而非 abspath）解掉符号链接，防经软链逃逸到主目录外；再限定在用户主目录下。
            d = os.path.realpath(os.path.expanduser(raw))
            base = os.path.realpath(os.path.expanduser("~"))
            if os.path.commonpath([base, d]) != base:
                self._send_json({"error": "目录必须在用户主目录下"}, 400)
                return
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
                pf_control = dict(gw.pf_control)  # {vid: paused|cancelled}; 供 web 渲染控制态
            real = gw.seg_cache.vid_stats()["real"]  # 播放段磁盘真相(thumb 桶已物理迁出)
            # 缩略图源段已物理隔离到独立桶 thumb_seg_cache(#1,#8): per-vid thumbBytes 与
            # 聚合 thumb.bytes 都从它读, 不再从 seg_cache 的 thumb 桶(那桶现已恒空)。
            thumbb = gw.thumb_seg_cache.vid_stats()["thumb"]
            snap = gw.seg_cache.cached_segs_by_vid()  # _vid_counts 用 (clarity 漂移判定)
            vids = qs.get("videoId") or []  # 可选：只查这些 vid 的缓冲明细
            # 枚举范围 = 磁盘已缓存 ∪ 已学到分片列表(seg_urls) ∪ 缓冲状态。覆盖"任何来源的缓存"。
            target = ([str(v) for v in vids] if vids
                      else list(set(list(real.keys()) + list(gw.seg_urls.keys()) + list(bstates.keys()))))

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
                return "cached"  # 磁盘有片但总数未知（如重启后只看过一次还没复看）

            buffer = {}
            for vid in target:
                vid = str(vid)
                r = real.get(vid) or {}
                cached, total, _basis = gw._vid_counts(vid, real, snap)
                d = {"cached": cached, "total": total,
                     "state": _state(vid, cached, total),
                     "bytes": r.get("bytes", 0),
                     "thumbBytes": (thumbb.get(vid) or {}).get("bytes", 0)}
                # error 状态附 reason(用户看到失败知道原因);其它状态没必要带
                if d["state"] == "error":
                    reason = gw._last_buf_error.get(vid)
                    if reason:
                        d["reason"] = reason
                buffer[vid] = d
            tready = sum(1 for s in tstates.values() if s == "ready")
            tgen = [k for k, s in tstates.items() if s == "gen"]
            terr = sum(1 for s in tstates.values() if s == "error")
            tqueued = [k for k in tgen if k not in tactive]
            self._send_json({
                "thumb": {"states": tstates, "ready": tready, "generating": tgen,
                          "working": sorted(tactive),
                          "queued_vids": tqueued,
                          # 由 queued_vids 推数：thumb_q.qsize() 会把已取消/在途的也算进去而高报。
                          "queued": len(tqueued), "errors": terr,
                          "session": tsession,
                          # 缩略图源段在磁盘的总字节: 直接读独立桶 thumb_seg_cache.size(#1,#8),
                          # 物理分离、不再和播放桶 seg_cache.size 混算(消除 #8 双计)。
                          "bytes": gw.thumb_seg_cache.size},
                "buffer": {"perVid": buffer, "bytes": gw.seg_cache.size, "limit": gw.seg_cache.max,
                           "queued": gw.buf_q.qsize(),
                           "working": [k for k, s in bstates.items() if s == "working"],
                           "queued_vids": [k for k, s in bstates.items() if s == "queued"],
                           "states": bstates},
                "live": {"active": gw.pf_active["vid"],
                         "playhead": ({gw.pf_active["vid"]: gw.playhead.get(gw.pf_active["vid"])}
                                      if gw.pf_active["vid"] else {}),
                         "done": pf_done,
                         # 预缓存控制态(G1): {vid: "paused"|"cancelled"}; 缺省(不在此)= running。
                         # web 据此给 prefetch 任务行渲染 pause/resume/cancel 当前态。
                         "control": pf_control,
                         "inFlight": {"live": gw.gate.n[0], "auto": gw.gate.n[1], "manual": gw.gate.n[2]}},
                "ffmpeg": gw.have_ffmpeg, "thumbDir": gw.thumb_dir,
                # 全局后台缓存开关(G3): web 据此渲染"暂停所有后台缓存"toggle 的状态。
                "bgPaused": gw._bg_paused,
                "cacheDir": gw.seg_cache.dir if gw.seg_cache.persist else "",
                "cacheDirOk": gw.seg_cache.dir_ok(),
                # 任务事件日志当前峰值 seq(hint): web 可先判 maxSeq 没涨就跳过拉增量,省一次请求。
                # 单 int 读取 GIL 原子, 不取锁(仅作提示, 真增量由 /api/task_events 按 seq 兜底)。
                "tasks": {"maxSeq": gw._task_seq},
            })

        def _api_task_events(self, qs):
            """任务事件增量拉取: ?since=N → {"epoch": 本 boot, "seq": 当前峰值, "events": [seq>N 升序]}。
            web 用 (epoch, since=上次游标) 拉增量写 TaskHistory: epoch 翻转(重启)则从 0 重拉,
            evt-<epoch>-<seq> 幂等不重复计数; 同 epoch 内按 seq>since 续传(不漏不重, #3)。
            只取 task_lock 快照(与 _emit 同锁), 保证 epoch/cur/events 一致。
            since 语义保持"本 epoch 内的 seq": 老 epoch 的事件仍在 deque 里也一并返回(各自带
            epoch, web 按 id 去重), 这样跨 epoch 切换时旧事件不丢。"""
            try:
                since = int((qs.get("since") or ["0"])[0])
            except (ValueError, TypeError):
                since = 0
            gw = self.gw
            with gw.task_lock:
                epoch = gw._task_epoch
                cur = gw._task_seq
                # deque 天然按 seq 升序 append; 过滤 seq>since(限本 epoch 增量)外,
                # 仍带上 epoch != 本 boot 的老事件(它们的 seq 可能 <=since 但属于上一 epoch,
                # web 按 evt-<epoch>-<seq> 去重不会重复, 跨重启切 epoch 时这批旧行不丢)。
                evs = [e for e in gw.task_events
                       if e["seq"] > since or e.get("epoch") != epoch]
            self._send_json({"epoch": epoch, "seq": cur, "events": evs})

        def _thumb_video(self, d):
            """从 dict 取出生成缩略图需要的字段，返回 (video, m3u8_low, duration) 或 None。"""
            return self._parse_video(d)

        def _api_thumb(self, qs):
            vid = (qs.get("videoId") or [None])[0]
            if not vid:
                self._send_json({"state": "error", "reason": "no videoId"}, 400)
                return
            parsed = {k: (v[0] if v else None) for k, v in qs.items()}
            tv = self._thumb_video(parsed)
            # 单把锁内完成"读状态 + 终态 pop"决策, 杜绝读后/pop 前的并发重插被误 pop(TOCTOU)。
            with self.gw.thumb_lock:
                st = self.gw.thumb_meta.get(vid)
                cur = (st or {}).get("state")
                # ready/gen 短路;error/cancelled 是终态 → pop 让 start_thumbs 不被早 return 挡住。
                if cur in ("error", "cancelled"):
                    self.gw.thumb_meta.pop(vid, None)
                    cur = None
            if cur in ("ready", "gen"):
                self._send_json(st)
                return
            if not tv:
                self._send_json({"state": "error", "reason": "need ids+src"}, 400)
                return
            self._send_json(self.gw.start_thumbs(*tv, tier=1))  # 播放时自动触发 → AUTO

        def _api_thumbs_batch(self):
            try:
                payload = self._read_json()
            except Exception as e:  # noqa: BLE001
                _log.debug("缩略图批量请求体解析失败：%s", e)
                self._send_json({"error": str(e)}, 400)
                return
            if payload is None:
                return  # _read_json 已回 413
            queued = skipped = 0
            # skippedReasons(G4): {vid: 人话中文原因}。
            skipped_reasons = {}
            for d in payload.get("videos") or []:
                tv = self._thumb_video(d)
                if tv:
                    # 拿到完整 video dict + src 就反向镜像;不管 skipped 还是 queued 都镜像。
                    video, m3u8, _ = tv
                    self.gw._remember_video(
                        {**video, "duration": d.get("duration"), "liveId": d.get("liveId")},
                        m3u8,
                    )
                with self.gw.thumb_lock:
                    vid_key = str(d.get("videoId"))
                    st = self.gw.thumb_meta.get(vid_key)
                    cur_state = (st or {}).get("state")
                    # ready/gen 已经在做 → skip 让前端等
                    # error/cancelled 是终态 → 用户点重新生成应该真重启,不再 skip;
                    #   清掉旧的 thumb_meta 让 start_thumbs 不被早 return 挡住
                    if cur_state in ("error", "cancelled"):
                        self.gw.thumb_meta.pop(vid_key, None)
                        cur_state = None
                if cur_state in ("ready", "gen"):
                    skipped += 1
                    skipped_reasons[vid_key] = (
                        "已有缩略图" if cur_state == "ready" else "正在生成中")
                    continue
                if tv:
                    self.gw.start_thumbs(*tv, tier=2)  # 手动批量 → MANUAL
                    queued += 1
                else:
                    skipped += 1
                    skipped_reasons[vid_key] = "参数无效或地址不在白名单"
            self._send_json({"queued": queued, "skipped": skipped,
                             "skippedReasons": skipped_reasons})

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
            # 镜像该 vid 的元数据(脱离 web 自愈 + buf_jobs resume 时 video_headers 可重建)。
            self.gw._remember_video(video, m3u8)
            # 当前在看的这集设为缓存"保护集"：顶到上限淘汰时最后才动它（防被挤出）。
            self.gw.seg_cache.set_protect_vid(vid)
            self.gw._playhead_dirty = True  # 触发 5s 后落盘新 protect_vid
            if self.gw.prefetch:
                self.gw.start_prefetch(vid, m3u8)  # 后台整集预缓存；切走会自动暂停
            self._send_json({"url": proxify(m3u8, video["videoId"]), "m3u8": m3u8})

        def _fetch_upstream(self, target, vid, range_header=None):
            with self.gw.vh_lock:
                hdrs = self.gw.video_headers.get(vid, self.gw.base_headers) if vid else self.gw.base_headers
            # 观看路径的回源 = 最高档 LIVE(0)：压过一切后台缓存。但缩略图生成时 ffmpeg 会
            # loopback 到 /p?vid=t_<vid>; 那是后台缩略图, 绝不能抢观看带宽。命中 t_ 前缀 →
            # 降到 MANUAL(2): 只在观看/自动缓存空闲时用带宽。
            tier = 2 if (isinstance(vid, str) and vid.startswith("t_")) else 0
            return self.gw.pri_fetch(tier, hdrs, target, range_header)

        def _proxy(self, qs):
            if "u" not in qs:
                self._send_bytes(400, b"missing u", "text/plain")
                return
            target = qs["u"][0]
            # 仅允许回源到白名单上游主机（按解析出的 hostname 精确等值，绝不用 URL 字符串 startswith）：
            # m3u8 与 分片/key 两条分支都在此守卫之后，故二者都被保护。
            tp = urllib.parse.urlparse(target)
            if tp.scheme not in ("http", "https") or (tp.hostname or "").lower() not in _ALLOWED_HOSTS:
                self._send_bytes(400, b"forbidden target", "text/plain")
                return
            vid = (qs.get("vid") or [None])[0]

            # 记录播放头：把这次直播分片请求映射到下标，预缓存据此向两边扩散。
            # （密钥/缩略图等不在 pf_segidx 里，pos 为 None，自然不影响。）
            si = self.gw.pf_segidx.get(vid)
            if si is not None:
                pos = si.get(target)
                if pos is not None:
                    self.gw.playhead[vid] = pos
                    self.gw._playhead_dirty = True  # 5s 后由 flush loop 落盘

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
                        self.gw._learn_segments(vid, segs)  # 设 seg_urls + 落盘
                rewritten = rewrite_m3u8(text, target, vid)
                self._send_bytes(200, rewritten.encode("utf-8"),
                                 "application/vnd.apple.mpegurl")
                return

            # 分片 / 密钥：整段缓存，拖动到看过的位置秒开；并支持 Range（Safari 原生拖动）。
            # 缩略图源段(vid=t_xxx, ffmpeg 回环读)走独立桶 thumb_seg_cache, 播放段走 seg_cache,
            # 经 _seg_cache_for 路由(#1,#8): 物理隔离, ffmpeg 大批量读源段绝不挤播放缓存。
            seg_cache = self.gw._seg_cache_for(vid)
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
                    _log.debug("取分片失败：%s", target, exc_info=True)
                    self._send_bytes(502, str(e).encode("utf-8"), "text/plain")
                    return
                ctype = ctype or "application/octet-stream"
                seg_cache.put(ck, (ctype, data))
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
    # 注意: server bind 可能抛 OSError(EADDRINUSE), 抛错后 Python 退出 → atexit hooks
    # 跑。所以 atexit 落盘必须 *在* bind 成功 *之后* 注册, 否则第二个端口冲突实例的
    # atexit 也会跑,可能用刚读到的内存快照覆盖第一个真在跑实例的新数据。
    server = _QuietServer(("127.0.0.1", port), make_handler(gateway))
    gateway.seg_cache.arm_atexit()
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server
