"""thumb 持久化独立 ok 闸门(#17): thumb_index/thumb_jobs 落盘只看 thumb_dir 自身健康,
不被【段盘】(seg_cache)掉线连累。

根因: 旧实现 thumb 落盘统一走 _atomic_write_json, 该函数硬闸 self.seg_cache.ok。
段盘(可能是外置盘)掉线 -> seg_cache.ok=False -> 连带把 thumb 写盘也冻住, 哪怕
thumb_dir(默认 ~/.youdao_course/thumbs, 多半在系统盘)完全健康 -> 缩略图状态丢失。

本测试用 _init_persist_min 测试 seam 搭最小骨架: thumb_dir 健康, 但强制 seg_cache.ok=False
(模拟段盘掉线), 断言 thumb 持久化仍然成功落盘。负向信号: 把 thumb 写盘改回硬闸
seg_cache.ok -> 这两个断言变红。
"""
import json
import os
import tempfile
import unittest

from ydcore.gateway import Gateway


class ThumbPersistGateTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="thumbgate_")
        self.gw = Gateway.__new__(Gateway)
        self.gw._init_persist_min(self.dir, ok=True)

    def test_thumb_dir_ok_independent_of_seg_cache_ok(self):
        # thumb_dir 健康探针存在且与 seg_cache.ok 解耦:
        # 段盘掉线(seg_cache.ok=False)时, thumb_dir 自身仍健康 -> 探针为真。
        self.assertTrue(hasattr(self.gw, "_thumb_dir_ok"))
        self.gw.seg_cache.ok = False
        self.assertTrue(self.gw._thumb_dir_ok())
        # thumb_dir 真删掉 -> 探针转假(独立于 seg_cache.ok)。
        import shutil
        shutil.rmtree(self.gw.thumb_dir, ignore_errors=True)
        self.assertFalse(self.gw._thumb_dir_ok())

    def test_thumb_index_writes_even_when_seg_drive_down(self):
        # 段盘掉线: seg_cache.ok=False。thumb_dir 健康。
        self.gw.seg_cache.ok = False
        self.gw.thumb_meta = {"123": {"state": "ready"}, "456": {"state": "gen"}}
        self.gw._save_thumb_index()
        # 索引仍然落盘(没被段盘闸门冻住)。
        self.assertTrue(os.path.isfile(self.gw.thumb_index_path))
        with open(self.gw.thumb_index_path, "r", encoding="utf-8") as f:
            saved = json.load(f)
        self.assertEqual(saved.get("123", {}).get("state"), "ready")
        self.assertEqual(saved.get("456", {}).get("state"), "gen")
        # thumb 写盘失败也绝不能连带把段盘标记成掉盘(各管各的健康)。
        self.assertFalse(self.gw.seg_cache.ok)  # 仍是我们手设的 False, 没被复写成别的

    def test_thumb_jobs_writes_even_when_seg_drive_down(self):
        self.gw.seg_cache.ok = False
        self.gw.thumb_jobs = {"789": ({"videoId": "789"}, "http://h/x.m3u8", 60, 2)}
        self.gw._save_thumb_jobs()
        self.assertTrue(os.path.isfile(self.gw.thumb_jobs_path))
        with open(self.gw.thumb_jobs_path, "r", encoding="utf-8") as f:
            saved = json.load(f)
        self.assertIn("789", saved)
        self.assertEqual(saved["789"][1], "http://h/x.m3u8")

    def test_thumb_persist_skipped_only_when_thumb_dir_itself_down(self):
        # 反过来: thumb_dir 自己掉了(段盘反而健康)-> thumb 写盘跳过, 不留半截文件。
        import shutil
        # 段盘健康
        self.gw.seg_cache.ok = True
        # 先确保索引文件原本不存在
        self.assertFalse(os.path.isfile(self.gw.thumb_index_path))
        shutil.rmtree(self.gw.thumb_dir, ignore_errors=True)
        self.gw.thumb_meta = {"123": {"state": "ready"}}
        self.gw._save_thumb_index()  # thumb_dir 没了 -> 跳过, 不抛
        self.assertFalse(os.path.isfile(self.gw.thumb_index_path))


if __name__ == "__main__":
    unittest.main()
