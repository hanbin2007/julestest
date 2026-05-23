"""磁盘分片/密钥缓存：按总字节数 LRU，可持久化（index.json，重启不清）。"""
import atexit
import hashlib
import json
import os
import shutil
import tempfile
import threading
import time
from collections import OrderedDict

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
        self.protect_vid = None    # 当前在看那集；淘汰时优先丢别的，最后才动它
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
                atexit.register(self._save_index)
        else:
            self.dir = tempfile.mkdtemp(prefix="ydcourse_cache_")
            self.index_path = None
            self.ok = True
            atexit.register(self.cleanup)

    # ---- 持久化：index.json 记录 key->(ctype,size,fname) 与 LRU 顺序 ----
    def _load_index(self):
        items = []
        try:
            with open(self.index_path, "r", encoding="utf-8") as f:
                items = json.load(f) or []
        except Exception:  # noqa: BLE001
            items = []
        size = 0
        for entry in items:
            try:
                k, v = entry
                key = (k[0], k[1]); ctype, sz, fname = v
            except Exception:  # noqa: BLE001
                continue
            if os.path.exists(os.path.join(self.dir, fname)):  # 文件还在才算数
                self.meta[key] = (ctype, sz, fname)
                size += sz
        self.size = size
        # 清掉 index 里没有的孤儿文件（崩溃残留 / 半截 .tmp），避免白占盘
        keep = {m[2] for m in self.meta.values()}
        keep.add("index.json")
        try:
            for fn in os.listdir(self.dir):
                if fn not in keep:
                    try:
                        os.remove(os.path.join(self.dir, fn))
                    except OSError:
                        pass
        except OSError:
            pass

    def _save_index(self):
        if not self.persist:
            return
        with self.lock:
            if not self._dirty:
                return
            items = [[list(k), [v[0], v[1], v[2]]] for k, v in self.meta.items()]
            self._dirty = False
        with self._io_lock:
            tmp = self.index_path + ".tmp"
            try:
                with open(tmp, "w", encoding="utf-8") as f:
                    json.dump(items, f)
                os.replace(tmp, self.index_path)   # 原子替换，避免半截 index
            except Exception:  # noqa: BLE001
                pass

    def _flush_loop(self):
        while True:
            time.sleep(8)      # 每 8s 落盘一次（脏了才写）；硬杀最多丢 8s 内新写的几片
            self._save_index()

    def set_protect_vid(self, vid):
        with self.lock:
            self.protect_vid = vid

    def _pick_victim(self):
        # 持锁调用。meta 头部=最久未用。优先丢最久未用的“非保护集”分片；
        # 没有非保护项时（全是保护集）才丢最旧的保护集分片。key 形如 (url, vid)。
        pv = self.protect_vid
        if pv is not None:
            for key in self.meta:
                if key[1] != pv:
                    return key
        return next(iter(self.meta))

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
        try:
            with open(path, "wb") as f:
                f.write(data)
        except OSError:
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
            return sum(1 for (t, v) in self.meta if v == vid and t.endswith(".ts"))

    def vid_stats(self):
        """一次遍历汇总每个 vid 的磁盘占用：真实视频段 vs 缩略图源段(t_ 前缀)。
        segments 只算 .ts(与 count_vid 同义)；bytes 把该 vid 的所有条目(段+密钥)都计入，
        因此 sum(real.bytes)+sum(thumb.bytes) == self.size（与存储总量自洽）。"""
        real, thumb = {}, {}
        with self.lock:
            for (url, vid), (_ctype, size, _fname) in self.meta.items():
                is_seg = url.endswith(".ts")
                if isinstance(vid, str) and vid.startswith("t_"):
                    d = thumb.setdefault(vid[2:], {"segments": 0, "bytes": 0})
                else:
                    d = real.setdefault(vid, {"segments": 0, "bytes": 0})
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
                if url.endswith(".ts"):
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
