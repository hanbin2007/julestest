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
import json
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

# 转发给上游时要去掉的逐跳 / 会被自动重设的头。
# 注意：故意保留 "url" —— 解密 key 的接口(live.ydshengxue.com)要求 Url 头始终指向
# m3u8 地址（App 对 m3u8 / ts / key 三种请求都带同一个 Url=<m3u8>），改写它会导致 key 返回失败。
_DROP_HEADERS = {
    "host", "connection", "proxy-connection", "content-length",
    "accept-encoding", "range", "te", "upgrade",
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
<input id="url" value="__DEFAULT_URL__" placeholder="把抓到的 .m3u8 地址粘进来，例如 https://stream.youdao.com/.../xxx.m3u8">
<button onclick="play()">播放</button>
<div class="hint">
  播放器只跟本地代理通信，鉴权头由代理自动补上。支持倍速（右键 / 控制条）和拖动进度。<br>
  列出全部课程：<code>python3 youdao_course.py list -r req.txt</code>，
  再 <code>serve -r req.txt --video &lt;videoId&gt;</code> 换视频，无需重新抓包。<br>
  想存成文件：<code>python3 youdao_course.py download -r req.txt --video &lt;videoId&gt; -o out.mp4</code>
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


def make_handler(headers, default_url=""):
    page = PLAYER_HTML.replace(
        "__DEFAULT_URL__",
        default_url.replace("&", "&amp;").replace('"', "&quot;"))

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
                self._send_bytes(200, page.encode("utf-8"),
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

            fwd = forward_headers(headers, self.headers.get("Range"))
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


def start_proxy(headers, port, default_url=""):
    server = ThreadingHTTPServer(("127.0.0.1", port),
                                 make_handler(headers, default_url))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


# ---------------------------------------------------------------------------
# 课程 / 视频枚举（只要会话 Cookie 就能列出全部课程和视频，不用一个个抓）
# ---------------------------------------------------------------------------
API_PRODUCTS = "https://ai.ydshengxue.com/ai-product/api/app/v2/products/after-sale"
API_PRODUCT_DETAIL = "https://ai.ydshengxue.com/ai-product/api/app/v3/products/after-sale/%s"
API_VIDEO_OUTLINE = ("https://ai.ydshengxue.com/ai-product/api/app/v1/products/"
                     "videos/%s/outline?cardPackageId=%s&cardPackageContentId=%s&productId=%s")

# 调 ydshengxue API 时只需要这几个头；其余按 App 习惯补默认值
_API_HEADER_KEYS = {"cookie", "imei", "keyfrom", "user-agent"}


def api_headers(session):
    out = {}
    for k, v in session.items():
        if k.lower() in _API_HEADER_KEYS:
            out[k] = v
    out.setdefault("User-Agent", "YoudaoCourse/iPhone")
    out.setdefault("Keyfrom", "aicard.1.4.9.ios")
    out["Accept"] = "application/json"
    out["Accept-Encoding"] = "identity"
    return out


def api_get_json(session, url):
    req = urllib.request.Request(url, headers=api_headers(session))
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def list_products(session):
    """返回已购课程列表：[{id, name, ...}]。"""
    d = api_get_json(session, API_PRODUCTS)
    return (d.get("data") or {}).get("allProductList") or []


def _walk_outline(node, pkg_id, product_id, out):
    """递归 outline 树，收集所有视频节点。"""
    if isinstance(node, list):
        for it in node:
            _walk_outline(it, pkg_id, product_id, out)
        return
    if not isinstance(node, dict):
        return
    for v in node.get("videos") or []:
        out.append({
            "videoId": v.get("videoId"),
            "contentId": v.get("id"),
            "cardPackageId": pkg_id,
            "productId": product_id,
            "title": v.get("title"),
            "downloadUrl": v.get("downloadUrl"),
            "locked": not v.get("downloadUrl"),
            "module": (v.get("moduleInfo") or {}).get("title"),
            "examKey": (v.get("examKeyInfo") or {}).get("title"),
        })
    for key in ("subOutlines", "outlines"):
        if node.get(key):
            _walk_outline(node[key], pkg_id, product_id, out)


def get_product_videos(session, product_id):
    """返回某课程下所有视频（含 videoId / contentId / cardPackageId / productId / m3u8）。"""
    d = (api_get_json(session, API_PRODUCT_DETAIL % product_id).get("data") or {})
    out = []
    tab = d.get("videoPackageTab") or {}
    pkgs = tab.get("videoPackages") or []
    for pkg in pkgs:
        _walk_outline(pkg.get("outlines"), pkg.get("videoPackageId"), product_id, out)
    # 直播回放：cardPackageId 复用主视频包（最佳猜测）
    live_pkg = pkgs[0].get("videoPackageId") if pkgs else None
    for live in (d.get("servicePackage") or {}).get("videoLiveTab") or []:
        _walk_outline(live.get("outlines"), live_pkg, product_id, out)
    return out


def find_video(session, video_id):
    """在所有课程里找到指定 videoId 的视频条目。"""
    video_id = int(video_id)
    for prod in list_products(session):
        for v in get_product_videos(session, prod["id"]):
            if v.get("videoId") == video_id:
                v["productName"] = prod.get("name")
                return v
    return None


def resolve_m3u8(session, video, quality="highest"):
    """拿到视频的 m3u8 地址；优先用 outline 接口里清晰度最高的，回退到 downloadUrl。"""
    try:
        url = API_VIDEO_OUTLINE % (video["videoId"], video["cardPackageId"],
                                   video["contentId"], video["productId"])
        infos = (api_get_json(session, url).get("data") or {}).get("videoInfos") or []
        for vi in infos:
            cl = vi.get("clarityInfoList") or []
            if cl:
                cl = sorted(cl, key=lambda c: c.get("type", 0),
                            reverse=(quality == "highest"))
                return cl[0]["url"]
    except Exception:  # noqa: BLE001
        pass
    return video.get("downloadUrl")


def play_headers(session, video, m3u8_url):
    """构造播放该视频所需的全套头（会话头 + 该视频的 Url/Videoid/Cardpackageid...）。"""
    h = dict(session)
    h.setdefault("User-Agent", "YoudaoCourse/iPhone")
    h.setdefault("Referer", "http://live.youdao.com")
    h.setdefault("Keyfrom", "aicard.1.4.9.ios")
    h["Url"] = m3u8_url
    h["Videoid"] = str(video["videoId"])
    h["Cardpackageid"] = str(video["cardPackageId"])
    h["Cardpackagecontentid"] = str(video["contentId"])
    h["Productid"] = str(video["productId"])
    return h


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


def cmd_list(args):
    _, session = load_session(args)
    prods = list_products(session)
    print("共 %d 门课：\n" % len(prods))
    for prod in prods:
        vids = []
        try:
            vids = get_product_videos(session, prod["id"])
        except Exception as e:  # noqa: BLE001
            print("== [%s] %s  (读取失败: %s)" % (prod["id"], prod.get("name"), e))
            continue
        print("== [product %s] %s  —— %d 个视频" %
              (prod["id"], prod.get("name"), len(vids)))
        for v in vids:
            lock = "🔒未解锁" if v["locked"] else "可看"
            print("   video %-7s %-4s %s / %s" %
                  (v["videoId"], lock, v.get("examKey") or "", v.get("title") or ""))
        print()
    print("播放某个：python3 youdao_course.py serve -r %s --video <videoId>"
          % (args.request or "req.txt"))


def _resolve_video(args, session):
    print("正在按 videoId=%s 查找视频……" % args.video)
    v = find_video(session, args.video)
    if not v:
        raise SystemExit("没找到 videoId=%s（确认它在你的已购课程里）。" % args.video)
    if v["locked"]:
        print("注意：该视频在 App 里显示未解锁，可能取不到地址。")
    m3u8 = resolve_m3u8(session, v)
    if not m3u8:
        raise SystemExit("拿不到该视频的 m3u8 地址（可能未解锁）。")
    print("找到：%s / %s" % (v.get("productName"), v.get("title")))
    return play_headers(session, v, m3u8), m3u8


def cmd_serve(args):
    url, headers = load_session(args)
    if getattr(args, "video", None):
        headers, url = _resolve_video(args, headers)
    server = start_proxy(headers, args.port, url)
    print("代理已启动。浏览器打开： http://127.0.0.1:%d" % args.port)
    print("地址已自动填好，点“播放”即可。Ctrl-C 退出。")
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        print("\n已退出。")
        server.shutdown()


def cmd_download(args):
    default_url, headers = load_session(args)
    if getattr(args, "video", None):
        headers, default_url = _resolve_video(args, headers)
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

    lp = sub.add_parser("list", parents=[common],
                        help="列出所有已购课程和视频（只需会话 Cookie）。")
    lp.set_defaults(func=cmd_list)

    sp = sub.add_parser("serve", parents=[common], help="起本地代理 + 网页播放器，浏览器在线看。")
    sp.add_argument("--video", "-V", help="要播放的 videoId（用 list 查到）；不传则放 req.txt 里那条。")
    sp.set_defaults(func=cmd_serve)

    dp = sub.add_parser("download", parents=[common], help="下载并合并成 mp4（需要 ffmpeg）。")
    dp.add_argument("--video", "-V", help="要下载的 videoId（用 list 查到）。")
    dp.add_argument("--url", "-u", help="要下载的 m3u8 地址；不传则用 --video 或原文里那条。")
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
