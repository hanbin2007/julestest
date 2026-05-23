"""上游回源与抓包请求解析（纯网络/解析工具，无全局状态）。

forward_headers / upstream_fetch 负责带鉴权头转发到 stream.youdao.com；
parse_request 从抓包原文里解析出 (url, headers)。
"""
import re
import time
import urllib.error
import urllib.parse
import urllib.request

# 转发给上游时要去掉的逐跳 / 会被自动重设的头。
# 注意：故意保留 "url" —— 解密 key 的接口(live.ydshengxue.com)要求 Url 头始终指向
# m3u8 地址（App 对 m3u8 / ts / key 三种请求都带同一个 Url=<m3u8>），改写它会导致 key 返回失败。
_DROP_HEADERS = {
    "host", "connection", "proxy-connection", "content-length",
    "accept-encoding", "range", "te", "upgrade",
}

_REQUEST_LINE_RE = re.compile(r"^(GET|POST|HEAD|PUT|DELETE|OPTIONS)\s+(\S+)\s+HTTP/", re.I)


def forward_headers(headers, range_header=None):
    """构造转发给上游的头：原样保留鉴权 / 自定义头（含 Url），去掉逐跳头。"""
    out = {}
    for key, val in headers.items():
        if key.lower() in _DROP_HEADERS:
            continue
        out[key] = val
    out["Accept-Encoding"] = "identity"
    if range_header:
        out["Range"] = range_header
    return out


def upstream_fetch(headers, target, range_header=None, retries=3):
    """带重试地从上游取一个资源，返回 (data, content_type, status)。"""
    fwd = forward_headers(headers, range_header)
    last = None
    for attempt in range(retries):
        req = urllib.request.Request(target, headers=fwd, method="GET")
        try:
            resp = urllib.request.urlopen(req, timeout=60)
            with resp:
                return resp.read(), resp.headers.get("Content-Type", ""), resp.status
        except urllib.error.HTTPError as e:
            if e.code not in (500, 502, 503, 504):
                raise
            last = e
        except urllib.error.URLError as e:
            last = e
        time.sleep(0.4 * (attempt + 1))
    raise last


def parse_request(text):
    """从抓包复制出来的原文里解析出 (url, headers)。"""
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")

    start = None
    for i, line in enumerate(lines):
        if _REQUEST_LINE_RE.match(line.strip()):
            start = i
            break
    if start is None:
        raise ValueError("没找到请求行（形如 'GET /path HTTP/1.1'）。请确认粘贴的是请求原文。")

    m = _REQUEST_LINE_RE.match(lines[start].strip())
    path = m.group(2)

    headers = {}
    for line in lines[start + 1:]:
        if line.strip() == "":
            break
        if ":" not in line:
            continue
        key, _, val = line.partition(":")
        headers[key.strip()] = val.strip()

    url = headers.get("Url") or headers.get("URL")
    if not url or not url.lower().startswith("http"):
        host = headers.get("Host")
        if not host:
            raise ValueError("缺少 Host 头，无法拼出完整地址。")
        url = "https://%s%s" % (host, path)

    return url, headers
