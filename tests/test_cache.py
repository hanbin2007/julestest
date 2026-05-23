"""磁盘 LRU 缓存的行为锁定测试（命中 / 字节淘汰 / 保护集 / 统计 / 持久化重载）。

重构(#1)会把 _DiskLRU 搬到 ydcore.cache.DiskLRU；这里通过 _CLS 间接引用，
搬动那一步只需改 _CLS 的来源。
"""
import importlib

yc = importlib.import_module("youdao_course")
_CLS = getattr(yc, "_DiskLRU")


def _blob(n, ctype="video/mp2t"):
    return (ctype, b"x" * n)


def test_put_get_has(tmp_path):
    c = _CLS(1024, persist_dir=str(tmp_path))
    key = ("https://a/seg0.ts", "v1")
    assert c.has(key) is False
    c.put(key, _blob(4))
    assert c.has(key) is True
    ctype, data = c.get(key)
    assert ctype == "video/mp2t" and data == b"xxxx"


def test_lru_evicts_oldest_by_bytes(tmp_path):
    c = _CLS(10, persist_dir=str(tmp_path))
    a = ("https://a/0.ts", "v1")
    b = ("https://a/1.ts", "v1")
    d = ("https://a/2.ts", "v1")
    c.put(a, _blob(4)); c.put(b, _blob(4)); c.put(d, _blob(4))  # 12 > 10
    assert c.has(a) is False     # 最久未用被淘汰
    assert c.has(b) is True and c.has(d) is True


def test_get_refreshes_recency(tmp_path):
    c = _CLS(10, persist_dir=str(tmp_path))
    a = ("https://a/0.ts", "v1")
    b = ("https://a/1.ts", "v1")
    d = ("https://a/2.ts", "v1")
    c.put(a, _blob(4)); c.put(b, _blob(4))
    c.get(a)                      # a 变为最近使用
    c.put(d, _blob(4))            # 触发淘汰 -> 该淘汰 b（现最久未用）
    assert c.has(a) is True and c.has(b) is False and c.has(d) is True


def test_protect_vid_evicts_others_first(tmp_path):
    c = _CLS(8, persist_dir=str(tmp_path))
    u1 = ("https://a/0.ts", "v1")
    u2 = ("https://a/1.ts", "v2")
    c.put(u1, _blob(4)); c.put(u2, _blob(4))
    c.set_protect_vid("v2")
    c.put(("https://a/2.ts", "v1"), _blob(4))   # 超限 -> 优先丢非保护集
    assert c.has(u1) is False     # 非保护集先丢
    assert c.has(u2) is True      # 保护集留到最后


def test_count_and_stats(tmp_path):
    c = _CLS(10_000, persist_dir=str(tmp_path))
    c.put(("https://a/0.ts", "v1"), _blob(10))
    c.put(("https://a/1.ts", "v1"), _blob(10))
    c.put(("https://a/key", "v1"), _blob(5, "application/octet-stream"))  # 非 .ts
    c.put(("https://a/0.ts", "t_v1"), _blob(7))   # 缩略图源段
    assert c.count_vid("v1") == 2                  # 只数 .ts
    stats = c.vid_stats()
    assert stats["real"]["v1"]["segments"] == 2
    assert stats["real"]["v1"]["bytes"] == 25      # 段+密钥都计入字节
    assert stats["thumb"]["v1"]["segments"] == 1
    snap = c.cached_segs_by_vid()
    assert snap["v1"] == {"https://a/0.ts", "https://a/1.ts"}  # 只含 .ts


def test_persistence_reload(tmp_path):
    key = ("https://a/0.ts", "v1")
    c1 = _CLS(1024, persist_dir=str(tmp_path))
    c1.put(key, _blob(8))
    c1._save_index()                               # 落盘 index.json
    c2 = _CLS(1024, persist_dir=str(tmp_path))     # 新实例从磁盘恢复
    assert c2.has(key) is True
    assert c2.get(key)[1] == b"xxxxxxxx"


def test_dir_ok(tmp_path):
    c = _CLS(1024, persist_dir=str(tmp_path))
    assert c.dir_ok() is True
