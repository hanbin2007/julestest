#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
youdao_course.py
================
把有道听课客户端抓到的加密 HLS 流，变成可以在浏览器 / 任意播放器里看的视频。

原理
----
有道的课程是 AES-128 加密的 HLS（一个 .m3u8 播放列表 + 一堆 .ts 分片，路径里带
"/encrypt/"）。stream.youdao.com 只在请求带上那一串鉴权头时才返回内容：
    Cookie / Imei / Productid / Videoid / Cardpackageid / Cardpackagecontentid /
    Keyfrom / Referer / User-Agent ...
普通浏览器请求因为缺这些头会被拒。

本脚本起一个本地代理：浏览器里的 hls.js / Safari，或者 ffmpeg，只跟本地代理打交道；
代理负责补齐这些头、把 m3u8 里的分片/密钥地址改写成走代理、再转发上游响应。
解密用的 key 也通过代理拿（带头），所以 hls.js / ffmpeg 能正常解密。

用法
----
1) 在抓包工具里复制那条 .m3u8 请求的“原文/raw”，存成 req.txt
2) 浏览器在线看：
       python3 youdao_course.py serve --request req.txt
   打开 http://127.0.0.1:8808 ，把 m3u8 地址粘进去就能放（支持倍速 / 拖进度）。
3) 下载成 mp4（需要本机有 ffmpeg：brew install ffmpeg）：
       python3 youdao_course.py download --request req.txt \
           --url 'https://stream.youdao.com/.../xxx.m3u8' -o 课程.mp4
   不传 --url 时会用 req.txt 里那条请求自己的地址。

说明：仅用于观看你自己已购买 / 有权访问的课程，请遵守平台条款。会话(Cookie 等)会过期，
过期后重新抓一条请求覆盖 req.txt 即可。
"""

import argparse
import os
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# 转发给上游时要去掉的逐跳 / 会被自动重设的头
_DROP_HEADERS = {
    "host", "connection", "proxy-connection", "content-length",
    "accept-encoding", "range", "te", "upgrade", "url",
}

_REQUEST_LINE_RE = re.compile(r"^(GET|POST|HEAD|PUT|DELETE|OPTIONS)\s+(\S+)\s+HTTP/", re.I)
_URI_ATTR_RE = re.compile(r'URI="([^"]+)"')


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


def forward_headers(headers, target, range_header=None):
    """构造转发给上游的头：保留鉴权 / 自定义头，去掉逐跳头。"""
    out = {}
    had_url_header = False
    for key, val in headers.items():
        low = key.lower()
        if low == "url":
            had_url_header = True
            continue
        if low in _DROP_HEADERS:
            continue
        out[key] = val
    out["Accept-Encoding"] = "identity"
    if had_url_header:
        out["Url"] = target
    if range_header:
        out["Range"] = range_header
    return out


def _proxify(abs_url):
    return "/p?u=" + urllib.parse.quote(abs_url, safe="")


def rewrite_m3u8(body_text, base_url):
    """把 m3u8 里的分片 / 子播放列表 / 密钥地址改写成走本地代理。"""
    out_lines = []
    for raw in body_text.splitlines():
        line = raw.strip()
        if line == "":
            out_lines.append(raw)
        elif line.startswith("#"):
            if "URI=" in raw:
                def _sub(m):
                    abs_u = urllib.parse.urljoin(base_url, m.group(1))
                    return 'URI="%s"' % _proxify(abs_u)
                raw = _URI_ATTR_RE.sub(_sub, raw)
            out_lines.append(raw)
        else:
            abs_u = urllib.parse.urljoin(base_url, line)
            out_lines.append(_proxify(abs_u))
    return "\n".join(out_lines) + "\n"


def _looks_like_m3u8(url, content_type):
    if content_type and "mpegurl" in content_type.lower():
        return True
    path = urllib.parse.urlparse(url).path.lower()
    return path.endswith(".m3u8") or path.endswith(".m3u")


PLAYER_HTML = """<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>有道课程播放器</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 960px;
         margin: 24px auto; padding: 0 16px; background:#111; color:#eee; }
  h1 { font-size: 18px; }
  input { width: 100%; box-sizing: border-box; padding: 10px; font-size: 14px;
          border-radius: 8px; border: 1px solid #444; background:#1c1c1c; color:#eee; }
  button { margin-top: 10px; padding: 10px 18px; font-size: 14px; border-radius: 8px;
           border: none; background:#2d6cdf; color:#fff; cursor: pointer; }
  video { width: 100%; margin-top: 16px; background:#000; border-radius: 8px; }
  .hint { color:#888; font-size: 12px; margin-top: 6px; line-height: 1.6; }
  code { color:#9cf; }
</style>
</head>
<body>
<h1>有道课程播放器（本地代理）</h1>
<input id="url" placeholder="把抓到的 .m3u8 地址粘进来，例如 https://stream.youdao.com/.../xxx.m3u8">
<button onclick="play()">播放</button>
<div class="hint">
  播放器只跟本地代理通信，鉴权头由代理自动补上。支持倍速（右键 / 控制条）和拖动进度。<br>
  想存成文件：终端运行 <code>python3 youdao_course.py download --request req.txt --url &lt;地址&gt; -o out.mp4</code>
</div>
<video id="v" controls playsinline></video>
<script src="https://cdn.jsdelivr.net/npm/hls.js@1"></script>
<script>
function play() {
  var raw = document.getElementById('url').value.trim();
  if (!raw) return;
  var proxied = '/p?u=' + encodeURIComponent(raw);
  var v = document.getElementById('v');
  if (window.Hls && Hls.isSupported()) {
    if (window._hls) { window._hls.destroy(); }
    var hls = new Hls();
    window._hls = hls;
    hls.loadSource(proxied);
    hls.attachMedia(v);
    hls.on(Hls.Events.MANIFEST_PARSED, function(){ v.play(); });
    hls.on(Hls.Events.ERROR, function(e, d){ if (d.fatal) console.error('HLS error', d); });
  } else {
    // Safari 原生支持 HLS（含 AES 解密）
    v.src = proxied;
    v.play();
  }
}
</script>
</body>
</html>
"""


def make_handler(headers):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):
            sys.stderr.write("[proxy] " + (fmt % args) + "\n")

        def _send_bytes(self, status, body, content_type, extra=None):
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Access-Control-Allow-Origin", "*")
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            parsed = urllib.parse.urlparse(self.path)
            if parsed.path == "/" or parsed.path == "/index.html":
                self._send_bytes(200, PLAYER_HTML.encode("utf-8"),
                                 "text/html; charset=utf-8")
                return
            if parsed.path != "/p":
                self._send_bytes(404, b"not found", "text/plain")
                return

            qs = urllib.parse.parse_qs(parsed.query)
            if "u" not in qs:
                self._send_bytes(400, b"missing u param", "text/plain")
                return
            target = qs["u"][0]

            fwd = forward_headers(headers, target, self.headers.get("Range"))
            req = urllib.request.Request(target, headers=fwd, method="GET")
            try:
                resp = urllib.request.urlopen(req, timeout=60)
            except urllib.error.HTTPError as e:
                body = e.read()
                self._send_bytes(e.code, body or b"",
                                 e.headers.get("Content-Type", "text/plain"))
                return
            except Exception as e:  # noqa: BLE001
                self._send_bytes(502, str(e).encode("utf-8"), "text/plain")
                return

            with resp:
                ctype = resp.headers.get("Content-Type", "")
                data = resp.read()
                status = resp.status

            if _looks_like_m3u8(target, ctype):
                rewritten = rewrite_m3u8(data.decode("utf-8", "replace"), target)
                self._send_bytes(200, rewritten.encode("utf-8"),
                                 "application/vnd.apple.mpegurl")
                return

            extra = {"Accept-Ranges": "bytes"}
            self._send_bytes(status, data, ctype or "application/octet-stream", extra)

    return Handler


def start_proxy(headers, port):
    server = ThreadingHTTPServer(("127.0.0.1", port), make_handler(headers))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


def load_session(args):
    if args.request:
        with open(args.request, "r", encoding="utf-8", errors="replace") as f:
            text = f.read()
    elif not sys.stdin.isatty():
        text = sys.stdin.read()
    else:
        raise SystemExit("请用 --request <文件> 指定抓包原文，或从标准输入管道传入。")
    url, headers = parse_request(text)
    return url, headers


def cmd_parse(args):
    url, headers = load_session(args)
    print("URL :", url)
    print("Headers:")
    for k, v in headers.items():
        if k.lower() == "cookie" and len(v) > 60:
            v = v[:57] + "..."
        print("  %s: %s" % (k, v))


def cmd_serve(args):
    _, headers = load_session(args)
    server = start_proxy(headers, args.port)
    print("代理已启动。浏览器打开： http://127.0.0.1:%d" % args.port)
    print("把 m3u8 地址粘进页面即可播放。Ctrl-C 退出。")
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        print("\n已退出。")
        server.shutdown()


def cmd_download(args):
    default_url, headers = load_session(args)
    m3u8_url = args.url or default_url
    if not _looks_like_m3u8(m3u8_url, ""):
        print("警告：地址看起来不是 .m3u8，可能下不到完整视频：", m3u8_url)

    if not _which("ffmpeg"):
        raise SystemExit("没找到 ffmpeg，请先安装：brew install ffmpeg")

    server = start_proxy(headers, args.port)
    proxied = "http://127.0.0.1:%d/p?u=%s" % (
        args.port, urllib.parse.quote(m3u8_url, safe=""))

    out = args.output
    cmd = ["ffmpeg", "-y", "-i", proxied, "-c", "copy",
           "-bsf:a", "aac_adtstoasc", out]
    print("运行：", " ".join(cmd))
    rc = subprocess.call(cmd)
    if rc != 0:
        print("直接 copy 失败，改用重新编码再试一次……")
        rc = subprocess.call(["ffmpeg", "-y", "-i", proxied, out])
    server.shutdown()
    if rc == 0:
        print("完成：", os.path.abspath(out))
    else:
        raise SystemExit("ffmpeg 失败，请检查会话是否过期（重新抓包）或地址是否正确。")


def _which(name):
    for d in os.environ.get("PATH", "").split(os.pathsep):
        p = os.path.join(d, name)
        if os.path.isfile(p) and os.access(p, os.X_OK):
            return p
    return None


def build_parser():
    p = argparse.ArgumentParser(
        description="把有道听课客户端抓到的加密 HLS 流，变成浏览器/任意播放器能看的视频。")
    sub = p.add_subparsers(dest="cmd", required=True)

    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--request", "-r",
                        help="抓包复制出来的请求原文文件（含 .m3u8 那条）。不传则从 stdin 读。")
    common.add_argument("--port", type=int, default=8808, help="本地代理端口（默认 8808）。")

    sp = sub.add_parser("serve", parents=[common], help="起本地代理 + 网页播放器，浏览器在线看。")
    sp.set_defaults(func=cmd_serve)

    dp = sub.add_parser("download", parents=[common], help="下载并合并成 mp4（需要 ffmpeg）。")
    dp.add_argument("--url", "-u", help="要下载的 m3u8 地址；不传则用原文里那条请求的地址。")
    dp.add_argument("--output", "-o", default="output.mp4", help="输出文件名（默认 output.mp4）。")
    dp.set_defaults(func=cmd_download)

    pp = sub.add_parser("parse", parents=[common], help="只解析并打印抓到的地址和头（排错用）。")
    pp.set_defaults(func=cmd_parse)

    return p


def main():
    args = build_parser().parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
