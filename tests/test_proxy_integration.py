"""端到端代理链路测试：起真实网关，桩掉上游回源，打 /p 与 /api/*。

覆盖 _proxy -> 优先级闸门 -> 上游 -> m3u8 改写 / 分片缓存 / Range 的完整路径。
这是 Gateway 类抽取(#1 阶段二)的安全网：重构前后此测试都须通过。
"""
import json
import socket
import time
import urllib.error
import urllib.parse
import urllib.request

import pytest

import ydcore.gateway as gateway
import ydcore.httpio as httpio
from ydcore.gateway import start_proxy

M3U8 = "https://stream.youdao.com/a/play.m3u8"
SEG0 = "https://stream.youdao.com/a/seg0.ts"
SEG1 = "https://stream.youdao.com/a/seg1.ts"
KEY = "https://stream.youdao.com/a/key"
PLAYLIST = (
    "#EXTM3U\n"
    "#EXT-X-VERSION:3\n"
    '#EXT-X-KEY:METHOD=AES-128,URI="key"\n'
    "#EXTINF:9,\nseg0.ts\n"
    "#EXTINF:9,\nseg1.ts\n"
    "#EXT-X-ENDLIST\n"
)


def _free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


@pytest.fixture
def server(tmp_path, monkeypatch):
    calls = {}

    def fake(headers, target, range_header=None, retries=3):
        calls[target] = calls.get(target, 0) + 1
        if target == M3U8:
            return PLAYLIST.encode(), "application/vnd.apple.mpegurl", 200
        if target == SEG0:
            return b"SEG0DATA", "video/mp2t", 200
        if target == SEG1:
            return b"SEG1DATA", "video/mp2t", 200
        if target == KEY:
            return b"0123456789abcdef", "application/octet-stream", 200
        raise AssertionError("unexpected upstream target: " + target)

    monkeypatch.setattr(httpio, "upstream_fetch", fake)
    monkeypatch.setattr(gateway, "THUMB_DIR", str(tmp_path / "thumbs"))  # 别污染真实缩略图目录
    port = _free_port()
    srv = start_proxy({"Cookie": "x"}, port, session={"Cookie": "x"}, prefetch=False)
    try:
        yield "http://127.0.0.1:%d" % port, calls
    finally:
        srv.shutdown()
        srv.server_close()


def _get(url, headers=None):
    req = urllib.request.Request(url, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status, r.read(), dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, e.read(), dict(e.headers)


def _p(base, url, vid="1"):
    return base + "/p?u=" + urllib.parse.quote(url, safe="") + "&vid=" + vid


def test_index_served(server):
    base, _ = server
    st, body, _ = _get(base + "/")
    assert st == 200 and body[:20].lower().startswith(b"<!doctype html")


def test_m3u8_rewritten_through_proxy(server):
    base, _ = server
    st, body, _ = _get(_p(base, M3U8))
    text = body.decode()
    assert st == 200
    assert "/p?u=" in text and "vid=1" in text
    assert "seg0.ts" in text and "seg1.ts" in text   # 分片行改写成代理地址
    assert 'URI="/p?u=' in text                       # 密钥 URI 也走代理


def test_segment_proxied_and_cached(server):
    base, calls = server
    st1, b1, _ = _get(_p(base, SEG0))
    st2, b2, _ = _get(_p(base, SEG0))
    assert st1 == 200 and b1 == b"SEG0DATA"
    assert b2 == b"SEG0DATA"
    assert calls.get(SEG0) == 1     # 第二次命中磁盘缓存，不再回源


def test_segment_range_request(server):
    base, _ = server
    st, body, hdrs = _get(_p(base, SEG0), {"Range": "bytes=0-3"})
    assert st == 206 and body == b"SEG0"
    assert "bytes 0-3/8" in hdrs.get("Content-Range", "")


def test_proxy_missing_u_is_400(server):
    base, _ = server
    st, _, _ = _get(base + "/p")
    assert st == 400


def test_debug_and_status_endpoints(server):
    base, _ = server
    st, body, _ = _get(base + "/api/_debug")
    assert st == 200
    d = json.loads(body)
    assert "cacheItems" in d and "cacheBytes" in d
    st2, body2, _ = _get(base + "/api/status")
    assert st2 == 200
    s = json.loads(body2)
    assert {"thumb", "buffer", "live", "cacheDir"} <= set(s.keys())


def test_play_returns_proxied_url(server):
    # 显式带 m3u8 参数，跳过 resolve_m3u8（不触网）；prefetch=False 不起预缓存线程。
    base, _ = server
    q = urllib.parse.urlencode({
        "videoId": 42, "contentId": 1, "cardPackageId": 2, "productId": 3,
        "m3u8": M3U8,
    })
    st, body, _ = _get(base + "/api/play?" + q)
    assert st == 200
    d = json.loads(body)
    assert d["m3u8"] == M3U8
    assert d["url"].startswith("/p?u=") and "vid=42" in d["url"]


def test_buffer_batch_then_segments(server):
    base, calls = server
    payload = json.dumps({"videos": [{
        "videoId": 42, "contentId": 1, "cardPackageId": 2, "productId": 3, "src": M3U8,
    }]}).encode()
    req = urllib.request.Request(base + "/api/buffer/batch", data=payload, method="POST")
    with urllib.request.urlopen(req, timeout=5) as r:
        res = json.loads(r.read())
    assert res["queued"] == 1

    # 缓冲是后台 worker，轮询直到整集 2 片落缓存（桩上游即时返回，通常 <0.5s）
    deadline = time.time() + 5
    seg = {}
    while time.time() < deadline:
        st, body, _ = _get(base + "/api/buffer/segments?vid=42")
        seg = json.loads(body)["segments"].get("42") or {}
        if seg.get("cached") == 2:
            break
        time.sleep(0.05)
    assert seg.get("total") == 2 and seg.get("cached") == 2
    assert seg.get("buckets") is not None
    assert calls.get(SEG0) == 1 and calls.get(SEG1) == 1   # 每片只回源一次
