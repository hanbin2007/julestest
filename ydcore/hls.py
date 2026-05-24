"""HLS / m3u8 相关的纯文本处理：Range 解析、代理地址改写、分片列表解析。

无任何 I/O 或全局状态，便于单测。被 gateway 的 HTTP 处理与预缓存逻辑复用。
"""
import re
import urllib.parse

_RANGE_RE = re.compile(r"bytes=(\d*)-(\d*)")
_URI_ATTR_RE = re.compile(r'URI="([^"]+)"')


class UnsatisfiableRange(ValueError):
    """Range 头语法正确但超出实体范围（RFC 7233 §4.4），应响应 416。"""


def parse_range(range_header, total):
    """解析单段 Range；返回 (start, end) 闭区间，或 None 表示无 Range 头（整段 200）。
    若 Range 语法合法但不可满足（start >= total 或 suffix-length=0），抛 UnsatisfiableRange。"""
    if not range_header:
        return None
    m = _RANGE_RE.search(range_header)
    if not m:
        return None
    s, e = m.group(1), m.group(2)
    if s == "":
        if e == "":
            return None
        length = int(e)
        if length <= 0:
            # bytes=-0 ：suffix-length=0 不可满足
            raise UnsatisfiableRange("suffix-length=0")
        length = min(length, total)
        return (total - length, total - 1)
    start = int(s)
    end = int(e) if e else total - 1
    end = min(end, total - 1)
    if start > end or start >= total:
        raise UnsatisfiableRange("start=%d >= total=%d" % (start, total))
    return (start, end)


def proxify(abs_url, vid=None):
    """把绝对地址改写成走本地代理 /p?u=...（可带 vid 以选对鉴权头）。"""
    s = "/p?u=" + urllib.parse.quote(abs_url, safe="")
    if vid:
        s += "&vid=" + urllib.parse.quote(str(vid), safe="")
    return s


def rewrite_m3u8(body_text, base_url, vid=None):
    """把 m3u8 里的分片 / 子播放列表 / 密钥地址改写成走本地代理（带上 vid 以便选对鉴权头）。"""
    out_lines = []
    for raw in body_text.splitlines():
        line = raw.strip()
        if line == "":
            out_lines.append(raw)
        elif line.startswith("#"):
            if "URI=" in raw:
                def _sub(m):
                    abs_u = urllib.parse.urljoin(base_url, m.group(1))
                    return 'URI="%s"' % proxify(abs_u, vid)
                raw = _URI_ATTR_RE.sub(_sub, raw)
            out_lines.append(raw)
        else:
            abs_u = urllib.parse.urljoin(base_url, line)
            out_lines.append(proxify(abs_u, vid))
    return "\n".join(out_lines) + "\n"


def looks_like_m3u8(url, content_type):
    if content_type and "mpegurl" in content_type.lower():
        return True
    path = urllib.parse.urlparse(url).path.lower()
    return path.endswith(".m3u8") or path.endswith(".m3u")


def parse_segments(body_text, base_url):
    """从 m3u8 文本里按播放顺序解析出分片绝对地址（跳过注释/标签行）。
    用的 urljoin 与缓存 key、rewrite_m3u8 完全一致，故据此查 seg_cache 即得逐片缓存 bitmap。"""
    return [urllib.parse.urljoin(base_url, ln.strip())
            for ln in body_text.splitlines() if ln.strip() and not ln.startswith("#")]
