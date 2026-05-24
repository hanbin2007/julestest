"""磁盘 LRU 缓存的行为锁定测试（命中 / 字节淘汰 / 保护集 / 统计 / 持久化重载）。"""
import logging

from ydcore.cache import DiskLRU as _CLS


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


def test_corrupt_index_logs_warning(tmp_path, caplog):
    # 损坏的 index.json：应记 WARNING 并按空缓存启动，而不是静默吞掉。
    (tmp_path / "index.json").write_text("{not valid json", encoding="utf-8")
    with caplog.at_level(logging.WARNING):
        c = _CLS(1024, persist_dir=str(tmp_path))
    assert c.size == 0
    assert any("缓存索引损坏" in r.message for r in caplog.records)


def test_missing_index_is_silent(tmp_path, caplog):
    # 首次运行（无 index.json）属正常，不该刷 WARNING。
    with caplog.at_level(logging.WARNING):
        _CLS(1024, persist_dir=str(tmp_path))
    assert not any("缓存索引损坏" in r.message for r in caplog.records)


# ---- Bug 1: put() 原子性 ----

def test_put_no_tmp_leftover(tmp_path):
    """put() 成功后不应有 .tmp 文件残留，且可正常 round-trip。"""
    c = _CLS(1024, persist_dir=str(tmp_path))
    key = ("https://a/seg0.ts", "v1")
    c.put(key, _blob(8))
    ctype, data = c.get(key)
    assert data == b"x" * 8
    leftover = [f for f in (tmp_path).iterdir() if f.suffix == ".tmp"]
    assert leftover == [], f"意外的 .tmp 文件残留: {leftover}"


def test_put_failed_write_does_not_update_meta(tmp_path, monkeypatch):
    """os.replace 抛异常时，meta 不应更新（key 不进缓存，无 .tmp 残留）。"""
    import os as _os
    real_replace = _os.replace

    def _fail_replace(src, dst):
        # 只在写段文件时失败（非 index.json），模拟磁盘满
        if dst.endswith(".tmp") or "index" in dst:
            return real_replace(src, dst)
        raise OSError("磁盘满（模拟）")

    c = _CLS(1024, persist_dir=str(tmp_path))
    key = ("https://a/seg_fail.ts", "v1")
    monkeypatch.setattr(_os, "replace", _fail_replace)
    c.put(key, _blob(16))
    monkeypatch.undo()
    assert key not in c.meta, "写失败时 meta 不应记录该 key"
    leftover = list((tmp_path).glob("*.tmp"))
    assert leftover == [], f"写失败后有 .tmp 残留: {leftover}"


# ---- Bug 2: dirty 标志在 IO 失败时恢复 ----

def test_dirty_restored_on_flush_failure(tmp_path, monkeypatch):
    """index 落盘失败时，_dirty 应保持/恢复为 True，下次 flush 能重试。"""
    import os as _os
    real_replace = _os.replace

    c = _CLS(1024, persist_dir=str(tmp_path))
    key = ("https://a/seg0.ts", "v1")
    c.put(key, _blob(4))
    assert c._dirty is True

    # 让 index.json 落盘的 os.replace 失败
    def _fail_index_replace(src, dst):
        if "index" in dst:
            raise OSError("磁盘满（模拟）")
        return real_replace(src, dst)

    monkeypatch.setattr(_os, "replace", _fail_index_replace)
    c._save_index()   # 同步调用，IO 失败
    monkeypatch.undo()
    assert c._dirty is True, "_dirty 在 IO 失败后应恢复为 True"


# ---- Bug 3: 索引损坏时不删合法文件 ----

def test_corrupt_index_preserves_existing_segment_files(tmp_path):
    """index.json 损坏时，已存在的段文件不应被当作孤儿删除。"""
    import hashlib
    # 写一个假的段文件（文件名任意，不需要是真实 sha1）
    seg_file = tmp_path / "deadbeef1234567890abcdef1234567890abcdef"
    seg_file.write_bytes(b"valid segment data")
    # 写损坏的 index.json
    (tmp_path / "index.json").write_text("{invalid json", encoding="utf-8")
    # 构造缓存实例（会触发 _load_index）
    c = _CLS(1024, persist_dir=str(tmp_path))
    assert seg_file.exists(), "索引损坏时不应删除已存在的段文件"
