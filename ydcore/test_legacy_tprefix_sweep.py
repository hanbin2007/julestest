"""mustFix-1 旧 t_ 缩略图源段清扫(升级回归):

旧版本把缩略图源段(t_<vid>)和播放段一起灌进同一个 256MB 播放桶 seg_cache, 并落进
index.json。re-architecture 后缩略图源段改进独立小桶 thumb_seg_cache, 生成完在
thumb_seg_cache 上 drop_vid 释放 —— 但【旧 index.json 里残留的 t_ 键】回载进播放桶
seg_cache 后, 永远没有 worker 去 drop 它们(drop 只发生在 thumb_seg_cache), 永久占用
播放桶容量(生产 ~3.3GB), 还把真正的播放段挤出去。

治本: DiskLRU._load_index 载完后, 按注入的 namespace splitter 判定 bucket=='thumb'
的键一律丢弃(扣 size + 删盘上文件)。cache.py 不硬编码 't_' 字面量, 只信 splitter
(命名约定是 gateway 的事)。

失败信号: 不清扫 -> 启动后 seg_cache.meta 仍含 t_ 键、其字节计入 self.size -> 红。
"""
import json
import os
import shutil
import tempfile
import unittest

from ydcore.cache import DiskLRU
from ydcore.gateway import Gateway


def _t_split(vid):
    """与 gateway 注入的拆分器同构: t_ 前缀归 thumb 桶(去前缀), 其余归 real。"""
    if isinstance(vid, str) and vid.startswith("t_"):
        return ("thumb", vid[2:])
    return ("real", vid)


class LegacyTPrefixSweepTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="legacyt_")

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def _seed_legacy_index(self):
        """模拟旧版盘上 index.json: 既有真实播放段(real_vid)又有 t_ 缩略图源段。
        手工写真实分片文件 + index.json, 让 _load_index 回载时两类都"文件还在"。"""
        # 真实播放段 A: 2 片, 各 1000 字节
        # 缩略图源段 t_A: 3 片, 各 2000 字节(旧版混进同桶)
        entries = []
        for url, vid, sz in [
            ("http://h/a1.ts", "A", 1000),
            ("http://h/a2.ts", "A", 1000),
            ("http://h/t_a1.ts", "t_A", 2000),
            ("http://h/t_a2.ts", "t_A", 2000),
            ("http://h/t_a3.ts", "t_A", 2000),
        ]:
            key = (url, vid)
            fname = DiskLRU._fname(key)
            with open(os.path.join(self.dir, fname), "wb") as f:
                f.write(b"x" * sz)
            entries.append([list(key), ["video/mp2t", sz, fname]])
        with open(os.path.join(self.dir, "index.json"), "w", encoding="utf-8") as f:
            json.dump(entries, f)

    def test_t_prefix_swept_on_load(self):
        self._seed_legacy_index()
        lru = DiskLRU(256 * 1024 * 1024, persist_dir=self.dir)
        lru.set_namespace_splitter(_t_split)
        # 关键: re-arch 后才注入 splitter, 但清扫必须发生。构造时 _load_index 已跑,
        # 所以提供一个显式的迁移入口让 gateway 在注入 splitter 后调用。
        lru.sweep_thumb_bucket()

        # 播放段 A 完整保留
        a_keys = [k for k in lru.meta if k[1] == "A"]
        self.assertEqual(len(a_keys), 2, "真实播放段不应被清扫")
        # t_A 缩略图源段一片不剩
        t_keys = [k for k in lru.meta if k[1] == "t_A"]
        self.assertEqual(len(t_keys), 0, "旧 t_ 缩略图源段必须被清扫, 实余 %r" % t_keys)
        # size 只剩 A 的 2*1000, 不含 t_A 的 3*2000
        self.assertEqual(lru.size, 2000, "t_ 字节必须扣出 size, 实得 %d" % lru.size)

    def test_t_prefix_files_deleted_from_disk(self):
        self._seed_legacy_index()
        lru = DiskLRU(256 * 1024 * 1024, persist_dir=self.dir)
        lru.set_namespace_splitter(_t_split)
        # 记下 t_A 的盘文件
        t_files = [DiskLRU._fname((u, v))
                   for u, v in [("http://h/t_a1.ts", "t_A"),
                                ("http://h/t_a2.ts", "t_A"),
                                ("http://h/t_a3.ts", "t_A")]]
        lru.sweep_thumb_bucket()
        for fn in t_files:
            self.assertFalse(os.path.exists(os.path.join(self.dir, fn)),
                             "t_ 源段盘文件应被删除: %s" % fn)

    def test_gateway_init_seam_sweeps_legacy_t_keys(self):
        """端到端: gateway 构造(_init_persist_min seam 与生产 __init__ 同构)后,
        播放桶 seg_cache 不含旧 t_ 键、其字节不计入 size。

        失败信号: 去掉 __init__/_init_persist_min 里的 sweep_thumb_bucket() ->
        seg_cache 仍含 t_A、size 含 t_A 的 6000 字节 -> 红。"""
        self._seed_legacy_index()
        gw = Gateway.__new__(Gateway)
        gw._init_persist_min(self.dir, ok=True)
        seg = gw.seg_cache
        self.assertEqual([k for k in seg.meta if k[1] == "t_A"], [],
                         "gateway 构造后播放桶不应含旧 t_ 缩略图源段")
        self.assertEqual(len([k for k in seg.meta if k[1] == "A"]), 2,
                         "真实播放段应保留")
        self.assertEqual(seg.size, 2000,
                         "t_ 字节不应计入播放桶 size, 实得 %d" % seg.size)

    def test_sweep_noop_without_thumb_keys(self):
        """没有 t_ 键时清扫是 no-op, 不动真实段。"""
        entries = []
        for url, vid, sz in [("http://h/a1.ts", "A", 1000)]:
            key = (url, vid)
            fname = DiskLRU._fname(key)
            with open(os.path.join(self.dir, fname), "wb") as f:
                f.write(b"x" * sz)
            entries.append([list(key), ["video/mp2t", sz, fname]])
        with open(os.path.join(self.dir, "index.json"), "w", encoding="utf-8") as f:
            json.dump(entries, f)
        lru = DiskLRU(256 * 1024 * 1024, persist_dir=self.dir)
        lru.set_namespace_splitter(_t_split)
        removed = lru.sweep_thumb_bucket()
        self.assertEqual(removed, 0)
        self.assertEqual(lru.size, 1000)
        self.assertEqual(len([k for k in lru.meta if k[1] == "A"]), 1)


if __name__ == "__main__":
    unittest.main()
