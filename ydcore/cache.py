"""磁盘分片/密钥缓存：按总字节数 LRU，可持久化（index.json，重启不清）。"""
import atexit
import hashlib
import json
import logging
import os
import shutil
import tempfile
import threading
import time
import urllib.parse
from collections import OrderedDict

_log = logging.getLogger(__name__)

SEG_CACHE_BYTES = 256 * 1024 * 1024  # 分片缓存上限（约 256MB，够前后拖动很大范围）


class DiskLRU:
    """磁盘上的分片/密钥缓存（按总字节数 LRU）。整集预缓存几百 MB 也不吃内存。"""

    def __init__(self, max_bytes, persist_dir=None):
        self.max = max_bytes
        self.meta = OrderedDict()  # key(url,vid) -> (ctype, size, fname)
        self.size = 0
        self.lock = threading.Lock()
        self._io_lock = threading.Lock()   # 串行化 index 落盘
        self._dirty = False
        # 当前在看那集 + 额外保护 vid (例: 正在缓冲中的多集); 淘汰时优先丢别的, 最后才动它
        self._live_vid = None      # 单值: 当前 /api/play 那集 (LIVE 最高优先)
        self._extra_protect = set()  # 集合: 当前 _buffer_one / _prefetch_worker 跑中的 vid
        # vid -> (bucket, key) 拆分器: 默认恒等(全归 real)。gateway 注入 't_' 前缀规则,
        # 让 cache.py 不必知道上层命名约定(缩略图源段如何命名是 gateway 的事)。
        self._ns_split = lambda vid: ("real", vid)
        self.persist = bool(persist_dir)
        if self.persist:
            # 固定目录 + index.json：重启不清缓存。目录由调用方（resolve_cache_dir）按
            # “首次启用才创建、已记录却丢失则报错”的策略管理，这里不再静默 mkdir：
            # 否则外置盘掉线时会在本地盘悄悄重建一个空缓存，几个 G 静默蒸发。
            self.dir = persist_dir
            self.index_path = os.path.join(self.dir, "index.json")
            self.ok = os.path.isdir(self.dir)
            if self.ok:
                self._load_index()
                threading.Thread(target=self._flush_loop, daemon=True).start()
                # 不在这里注册 atexit: 第二个实例端口冲突启动失败时,Python 退出前会跑
                # atexit 把"刚读到的内存快照"写回去,可能覆盖第一个实例的新数据。
                # 改由 start_proxy() server bind 成功后调用 arm_atexit() 注册,
                # 保证只有"真正在跑的"那个实例才落盘。
        else:
            self.dir = tempfile.mkdtemp(prefix="ydcourse_cache_")
            self.index_path = None
            self.ok = True
            atexit.register(self.cleanup)

    def arm_atexit(self):
        """server bind 成功后调用: 注册 atexit 落盘 hook。
        第二个端口冲突的实例到不了这一步, 因此不会触发误覆盖。"""
        if self.persist and self.ok:
            atexit.register(self._save_index)

    # ---- 持久化：index.json 记录 key->(ctype,size,fname) 与 LRU 顺序 ----
    def _load_index(self):
        items = []
        index_loaded_ok = True   # 索引是否可信（损坏时不能清孤儿，避免误删合法文件）
        try:
            with open(self.index_path, "r", encoding="utf-8") as f:
                items = json.load(f) or []
        except FileNotFoundError:
            items = []   # 首次运行：尚无索引，正常
        except Exception:  # noqa: BLE001
            # 损坏文件先备份到 .corrupt-<ts> 再继续, 否则下次 _save_index 覆盖原文件 →
            # 用户的索引永远丢失(13GB 缓存全成孤儿,LRU 也无法识别)。
            try:
                bak = "%s.corrupt-%d" % (self.index_path, int(time.time()))
                os.replace(self.index_path, bak)
                _log.warning("缓存索引损坏, 已隔离到 %s; 按空缓存启动", bak)
            except OSError:
                _log.warning("缓存索引损坏且无法隔离: %s", self.index_path, exc_info=True)
            items = []
            index_loaded_ok = False  # 索引不可信，跳过孤儿清理
        size = 0
        for entry in items:
            try:
                k, v = entry
                key = (k[0], k[1]); ctype, sz, fname = v
            except Exception:  # noqa: BLE001
                _log.debug("跳过损坏的缓存索引条目：%r", entry)
                continue
            if os.path.exists(os.path.join(self.dir, fname)):  # 文件还在才算数
                self.meta[key] = (ctype, sz, fname)
                size += sz
        self.size = size
        # 清掉 index 里没有的孤儿文件（崩溃残留 / 半截 .tmp），避免白占盘。
        # 索引损坏时跳过：meta 为空会把所有合法段文件当孤儿删掉，造成数据丢失。
        if not index_loaded_ok:
            return
        keep = {m[2] for m in self.meta.values()}
        keep.add("index.json")
        # 同目录可能放着 gateway 的其它持久化 JSON(seg_urls.json/buf_state.json/
        # video_metadata.json 等);它们以 .json 结尾, 不是分片缓存的 fname(sha1 无后缀),
        # 一刀切扩展名白名单即可,避免 cache.py 知道 gateway 写了哪些文件。
        try:
            for fn in os.listdir(self.dir):
                if fn in keep:
                    continue
                if fn.endswith(".json") or fn.endswith(".json.tmp"):
                    continue
                try:
                    os.remove(os.path.join(self.dir, fn))
                except OSError:
                    pass
        except OSError:
            pass

    def _save_index(self):
        if not self.persist:
            return
        # 掉盘后不再尝试写盘,避免一直 OSError 刷屏 + 防止用空 meta 覆盖有效索引。
        # dir_ok() 实时探测目录是否仍可写;失败一次就长期标记 ok=False。
        if not self.ok or not self.dir_ok():
            return
        with self.lock:
            if not self._dirty:
                return
            items = [[list(k), [v[0], v[1], v[2]]] for k, v in self.meta.items()]
            self._dirty = False   # 先清，IO 失败时在 except 里恢复
        with self._io_lock:
            tmp = self.index_path + ".tmp"
            try:
                with open(tmp, "w", encoding="utf-8") as f:
                    json.dump(items, f)
                os.replace(tmp, self.index_path)   # 原子替换，避免半截 index
            except Exception as e:  # noqa: BLE001
                _log.warning("缓存索引落盘失败：%s", self.index_path, exc_info=True)
                if isinstance(e, OSError):
                    self.ok = False  # 掉盘 → 标记不可用
                # IO 失败：恢复 dirty，下次 flush 继续重试
                with self.lock:
                    self._dirty = True

    def _flush_loop(self):
        while True:
            time.sleep(8)      # 每 8s 落盘一次（脏了才写）；硬杀最多丢 8s 内新写的几片
            self._save_index()

    def set_protect_vid(self, vid):
        """设当前观看 vid (LIVE 优先级最高), 兼容老调用; 内部塞进 _live_vid 槽。"""
        with self.lock:
            self._live_vid = vid

    def add_protect_vid(self, vid):
        """加额外保护 vid (例: 正在 buffer 中, 不希望被自身淘汰)。可同时存多个。"""
        with self.lock:
            self._extra_protect.add(vid)

    def remove_protect_vid(self, vid):
        """缓冲完成后移除保护。"""
        with self.lock:
            self._extra_protect.discard(vid)

    def set_namespace_splitter(self, fn):
        """注入 vid -> (bucket, display_key) 拆分器; bucket ∈ {'real','thumb'}。
        gateway 用它把 't_'+vid 的缩略图源段归入 thumb 桶,而 cache.py 自身不识别前缀。"""
        self._ns_split = fn

    def extra_protect_vids(self):
        """当前额外保护集的快照(供 gateway 落盘 playhead.json)。
        过滤 t_ 前缀(缩略图源段生成期保护): 这类保护只在 _gen_thumbs 生命周期内有意义,
        生成结束就 remove。若落盘后 kill-9 重启落在生成窗口, 回载的 t_<vid> 永无 worker
        移除 -> 永久僵尸保护慢慢吃掉有效缓存容量。故绝不落盘 t_ 前缀(#5)。"""
        with self.lock:
            return sorted(
                v for v in self._extra_protect
                if not (isinstance(v, str) and v.startswith("t_"))
            )

    def set_extra_protect(self, vids):
        """启动时从 playhead.json 还原额外保护集。整体替换(不并集),
        因为这是重启回载、内存里此前为空。
        回载也过滤 t_ 前缀: 既兜底(万一旧版 playhead.json 已被污染), 也自愈(#5)。"""
        with self.lock:
            self._extra_protect = set(
                str(v) for v in vids if v and not str(v).startswith("t_")
            )

    def _pick_victim(self):
        # 持锁调用。meta 头部=最久未用。优先丢最久未用的"非保护集"分片;
        # 没有非保护项时(全是保护集)才丢最旧的保护集分片。key 形如 (url, vid)。
        # 保护集 = LIVE 看那一集 ∪ 当前正在缓冲的所有 vid。
        protected = set(self._extra_protect)
        if self._live_vid is not None:
            protected.add(self._live_vid)
        if protected:
            for key in self.meta:
                if key[1] not in protected:
                    return key
        return next(iter(self.meta))

    # 兼容老 read: 旧代码读 self.protect_vid 拿"当前 LIVE 那集"
    @property
    def protect_vid(self):
        return self._live_vid

    @staticmethod
    def _fname(key):
        return hashlib.sha1(repr(key).encode("utf-8")).hexdigest()

    def has(self, key):
        with self.lock:
            return key in self.meta

    def get(self, key):
        with self.lock:
            m = self.meta.get(key)
            if not m:
                return None
            self.meta.move_to_end(key)
            path = os.path.join(self.dir, m[2])
            ctype = m[0]
        try:
            with open(path, "rb") as f:
                return (ctype, f.read())
        except OSError:
            return None

    def put(self, key, value):
        ctype, data = value
        n = len(data)
        fn = self._fname(key)
        path = os.path.join(self.dir, fn)
        # 先写临时文件，再原子替换到目标路径，避免写一半时进程崩溃留下截断文件
        try:
            tmp_fd, tmp_path = tempfile.mkstemp(dir=self.dir, suffix=".tmp")
        except OSError as e:
            # 外置盘掉线 / 权限丢失 → mkstemp 都失败。标 ok=False 让上层感知。
            if self.ok:
                _log.warning("缓存目录写入失败,可能掉盘/无权限,标记 cache 暂不可用: %s", e)
            self.ok = False
            return
        try:
            with os.fdopen(tmp_fd, "wb") as f:
                f.write(data)
            os.replace(tmp_path, path)   # 原子落盘
        except Exception as e:  # noqa: BLE001
            try:
                os.remove(tmp_path)
            except OSError:
                pass
            # 持久化失败也算缓存不可用,后续 _save_index 看到 ok=False 会跳过
            if isinstance(e, OSError):
                if self.ok:
                    _log.warning("缓存分片落盘失败,标记 cache 暂不可用: %s", e)
                self.ok = False
            return
        with self.lock:
            if key in self.meta:
                self.size -= self.meta[key][1]
            self.meta[key] = (ctype, n, fn)
            self.size += n
            self.meta.move_to_end(key)
            while self.size > self.max and len(self.meta) > 1:
                victim = self._pick_victim()
                if victim == key:   # 别把刚写入的这片当场淘汰（极端：单片即超限）
                    break
                _, s, f = self.meta.pop(victim)
                self.size -= s
                try:
                    os.remove(os.path.join(self.dir, f))
                except OSError:
                    pass
            self._dirty = True   # 内容/顺序变了，待 _flush_loop 落盘

    def count_vid(self, vid):
        with self.lock:
            return sum(1 for (t, v) in self.meta
                       if v == vid and urllib.parse.urlparse(t).path.endswith((".ts", ".m4s")))

    def vid_stats(self):
        """一次遍历汇总每个 vid 的磁盘占用：真实视频段 vs 缩略图源段。
        归桶规则由 set_namespace_splitter 注入(默认全 real),cache.py 不识别上层前缀。
        segments 只算 .ts/.m4s；bytes 把该 vid 的所有条目(段+密钥)都计入,
        因此 sum(real.bytes)+sum(thumb.bytes) == self.size（与存储总量自洽）。"""
        real, thumb = {}, {}
        with self.lock:
            for (url, vid), (_ctype, size, _fname) in self.meta.items():
                is_seg = urllib.parse.urlparse(url).path.endswith((".ts", ".m4s"))
                bucket, key = self._ns_split(vid)
                target = thumb if bucket == "thumb" else real
                d = target.setdefault(key, {"segments": 0, "bytes": 0})
                d["bytes"] += size
                if is_seg:
                    d["segments"] += 1
        return {"real": real, "thumb": thumb}

    def cached_segs_by_vid(self):
        """{vid: set(seg_url)}，仅 .ts 分片，一次持锁快照。逐片 bitmap 查询用，
        避免对每个 url 单独加锁 has()（一门课几百片 × 几十讲会很碎）。"""
        out = {}
        with self.lock:
            for (url, vid), _meta in self.meta.items():
                if urllib.parse.urlparse(url).path.endswith((".ts", ".m4s")):
                    out.setdefault(vid, set()).add(url)
        return out

    def cleanup(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def dir_ok(self):
        """缓存目录当前是否可用（持久化目录可能被删 / 外置盘掉线）。临时目录恒真。
        每次 /api/status 实时复查，所以会话中途丢盘也能立刻在网页报错。"""
        if not self.persist:
            return True
        return os.path.isdir(self.dir) and os.access(self.dir, os.W_OK)
