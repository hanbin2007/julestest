"""孤儿清理(_load_index)必须跳过 .corrupt-<ts> 取证备份(#16)。

损坏的 index.json / playhead.json 等会被隔离成 `<name>.corrupt-<ts>`(取证留底,
方便事后救数据)。这些文件不以 .json/.json.tmp 结尾, 旧的孤儿清理白名单(只放
keep + .json + .json.tmp)会把它们当孤儿一刀切删掉, 取证备份在下次启动即蒸发。
"""
import os
import tempfile
import unittest

from ydcore.cache import DiskLRU


class OrphanSkipCorruptTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="orphan_corrupt_")

    def _touch(self, name, data=b"x"):
        with open(os.path.join(self.dir, name), "wb") as f:
            f.write(data)

    def test_corrupt_backups_survive_orphan_sweep(self):
        # 模拟之前进程隔离下来的取证备份(cache 的 index + gateway 的各 JSON)。
        self._touch("index.json.corrupt-1748600000", b'{"broken')
        self._touch("playhead.json.corrupt-1748600001", b'{"broken')
        self._touch("seg_urls.json.corrupt-1748600002", b'{"broken')
        # 一个真正的孤儿垃圾(无后缀, 不在 index 里) —— 应被清掉, 作为失败信号的对照。
        self._touch("deadbeefcafe", b"junk-orphan")

        # 构造持久化 DiskLRU(空 index → 走孤儿清理分支); 构造期即触发 _load_index。
        DiskLRU(10 * 1024 * 1024, persist_dir=self.dir)

        # .corrupt-<ts> 取证备份必须全部存活
        self.assertTrue(
            os.path.exists(os.path.join(self.dir, "index.json.corrupt-1748600000")),
            "index.json.corrupt-<ts> 被孤儿清理误删",
        )
        self.assertTrue(
            os.path.exists(os.path.join(self.dir, "playhead.json.corrupt-1748600001")),
            "playhead.json.corrupt-<ts> 被孤儿清理误删",
        )
        self.assertTrue(
            os.path.exists(os.path.join(self.dir, "seg_urls.json.corrupt-1748600002")),
            "seg_urls.json.corrupt-<ts> 被孤儿清理误删",
        )
        # 对照: 普通孤儿仍被清掉(证明清理本身在跑, 不是被整段跳过)
        self.assertFalse(
            os.path.exists(os.path.join(self.dir, "deadbeefcafe")),
            "孤儿清理没有运行(对照文件没被删), 测试本身失效",
        )


if __name__ == "__main__":
    unittest.main()
