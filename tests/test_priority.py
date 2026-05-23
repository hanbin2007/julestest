"""优先级闸门 PriorityGate 的行为测试（计数 / grace / 高档不被低档挡 / fetch 委托）。"""
import time

from ydcore.priority import PriorityGate


def test_higher_priority_never_blocked_by_lower():
    g = PriorityGate()
    g.acquire(2)            # 手动档(2)在途
    t0 = time.time()
    g.acquire(0)            # 观看档(0)不该被低档(2)挡住
    assert time.time() - t0 < 0.1
    g.release(0)
    g.release(2)


def test_acquire_release_counts():
    g = PriorityGate()
    g.acquire(1)
    assert g.n[1] == 1
    g.release(1)
    assert g.n[1] == 0
    assert g.until[1] > 0   # release 后进入 grace


def test_lower_priority_waits_during_higher_grace():
    g = PriorityGate(grace={0: 0.3, 1: 0.0, 2: 0.0})
    g.acquire(0)
    g.release(0)            # 观看档进入 0.3s grace
    t0 = time.time()
    g.acquire(1)           # 自动档应等到 grace 过期才拿到
    waited = time.time() - t0
    g.release(1)
    assert waited >= 0.2    # 受 0.2s 轮询粒度影响，留点裕量


def test_fetch_delegates_to_upstream(monkeypatch):
    calls = {}

    def fake(hdrs, url, range_header=None):
        calls["args"] = (hdrs, url, range_header)
        return (b"DATA", "video/mp2t", 200)

    import ydcore.httpio as httpio
    monkeypatch.setattr(httpio, "upstream_fetch", fake)
    g = PriorityGate()
    data, ctype, status = g.fetch(0, {"H": "1"}, "https://x/seg.ts")
    assert data == b"DATA" and ctype == "video/mp2t" and status == 200
    assert calls["args"] == ({"H": "1"}, "https://x/seg.ts", None)
    assert g.n[0] == 0      # fetch 后计数归零（try/finally 释放）
