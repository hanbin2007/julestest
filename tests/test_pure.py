"""纯逻辑函数的行为锁定测试（Range 解析 / m3u8 改写 / 头转发 / 请求解析）。"""
import pytest

from ydcore.hls import (
    parse_range, proxify, looks_like_m3u8, parse_segments, rewrite_m3u8,
)
from ydcore.httpio import forward_headers, parse_request


# ---- Range 解析 ----------------------------------------------------------
@pytest.mark.parametrize("hdr,total,expected", [
    (None, 100, None),
    ("", 100, None),
    ("bytes=0-9", 100, (0, 9)),
    ("bytes=10-", 100, (10, 99)),
    ("bytes=-10", 100, (90, 99)),       # 末尾 N 字节
    ("bytes=50-1000", 100, (50, 99)),   # 越界 end 收敛到 total-1
    ("bytes=200-300", 100, None),       # start 超出总长 -> 整段(None)
    ("nonsense", 100, None),
])
def test_parse_range(hdr, total, expected):
    assert parse_range(hdr, total) == expected


# ---- 代理地址改写 --------------------------------------------------------
def test_proxify_basic():
    assert proxify("https://a.com/x/y.ts") == "/p?u=https%3A%2F%2Fa.com%2Fx%2Fy.ts"


def test_proxify_with_vid():
    assert proxify("https://a.com/y.ts", vid=5) == \
        "/p?u=https%3A%2F%2Fa.com%2Fy.ts&vid=5"


# ---- m3u8 识别 -----------------------------------------------------------
@pytest.mark.parametrize("url,ctype,expected", [
    ("https://a/b.m3u8", "", True),
    ("https://a/b.M3U8?x=1", "", True),
    ("https://a/b", "application/vnd.apple.mpegurl", True),
    ("https://a/b.ts", "video/mp2t", False),
    ("https://a/seg", "", False),
])
def test_looks_like_m3u8(url, ctype, expected):
    assert looks_like_m3u8(url, ctype) is expected


# ---- 分片解析 ------------------------------------------------------------
def test_parse_segments_skips_tags_and_resolves_relative():
    body = "#EXTM3U\n#EXTINF:9,\nseg0.ts\n#EXTINF:9,\nseg1.ts\n"
    base = "https://s.youdao.com/a/play.m3u8"
    assert parse_segments(body, base) == [
        "https://s.youdao.com/a/seg0.ts",
        "https://s.youdao.com/a/seg1.ts",
    ]


# ---- m3u8 改写 -----------------------------------------------------------
def test_rewrite_m3u8_segments_and_key():
    body = (
        "#EXTM3U\n"
        '#EXT-X-KEY:METHOD=AES-128,URI="key",IV=0x0\n'
        "#EXTINF:9,\n"
        "seg0.ts\n"
    )
    base = "https://s.youdao.com/a/play.m3u8"
    out = rewrite_m3u8(body, base, vid="7")
    # 分片行 -> 走代理
    assert "/p?u=https%3A%2F%2Fs.youdao.com%2Fa%2Fseg0.ts&vid=7" in out
    # KEY 的 URI -> 走代理
    assert 'URI="/p?u=https%3A%2F%2Fs.youdao.com%2Fa%2Fkey&vid=7"' in out
    # 普通标签原样保留
    assert "#EXTM3U" in out and "#EXTINF:9," in out


# ---- 头转发 --------------------------------------------------------------
def test_forward_headers_drops_hop_by_hop_keeps_auth():
    headers = {
        "Host": "s.youdao.com",
        "Connection": "keep-alive",
        "Cookie": "DICT=1",
        "Url": "https://s.youdao.com/a.m3u8",
        "Accept-Encoding": "gzip",
    }
    out = forward_headers(headers, range_header="bytes=0-9")
    assert "Host" not in out and "Connection" not in out
    assert out["Cookie"] == "DICT=1"
    assert out["Url"] == "https://s.youdao.com/a.m3u8"  # 鉴权关键头保留
    assert out["Accept-Encoding"] == "identity"          # 强制不压缩
    assert out["Range"] == "bytes=0-9"


# ---- 抓包请求解析 --------------------------------------------------------
def test_parse_request_uses_url_header():
    text = (
        "GET /private/a.m3u8 HTTP/1.1\n"
        "Host: stream.youdao.com\n"
        "Url: https://stream.youdao.com/private/a.m3u8\n"
        "Cookie: DICT=1\n"
        "\n"
    )
    url, headers = parse_request(text)
    assert url == "https://stream.youdao.com/private/a.m3u8"
    assert headers["Cookie"] == "DICT=1"


def test_parse_request_falls_back_to_host_and_path():
    text = "GET /private/a.m3u8 HTTP/1.1\nHost: stream.youdao.com\n\n"
    url, _ = parse_request(text)
    assert url == "https://stream.youdao.com/private/a.m3u8"


def test_parse_request_raises_without_request_line():
    with pytest.raises(ValueError):
        parse_request("just some text\nno request line\n")
