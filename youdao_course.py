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
import atexit
import concurrent.futures
import hashlib
import json
import os
import queue
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


SEG_CACHE_BYTES = 256 * 1024 * 1024  # 分片缓存上限（约 256MB，够前后拖动很大范围）
_RANGE_RE = re.compile(r"bytes=(\d*)-(\d*)")


def _parse_range(range_header, total):
    """解析单段 Range；返回 (start, end) 闭区间，或 None 表示整段。"""
    if not range_header:
        return None
    m = _RANGE_RE.search(range_header)
    if not m:
        return None
    s, e = m.group(1), m.group(2)
    if s == "":
        if e == "":
            return None
        length = min(int(e), total)
        return (total - length, total - 1)
    start = int(s)
    end = int(e) if e else total - 1
    end = min(end, total - 1)
    if start > end or start >= total:
        return None
    return (start, end)


class _DiskLRU:
    """磁盘上的分片/密钥缓存（按总字节数 LRU）。整集预缓存几百 MB 也不吃内存。"""

    def __init__(self, max_bytes):
        self.max = max_bytes
        self.dir = tempfile.mkdtemp(prefix="ydcourse_cache_")
        self.meta = OrderedDict()  # key -> (ctype, size, fname)
        self.size = 0
        self.lock = threading.Lock()
        atexit.register(self.cleanup)

    @staticmethod
    def _fname(key):
        return hashlib.sha1(repr(key).encode("utf-8")).hexdigest()

    def has(self, key):
        with self.lock:
            return key in self.meta

    def get(self, key):
        with self.lock:
            m = self.meta.get(key)
            if not m:
                return None
            self.meta.move_to_end(key)
            path = os.path.join(self.dir, m[2])
            ctype = m[0]
        try:
            with open(path, "rb") as f:
                return (ctype, f.read())
        except OSError:
            return None

    def put(self, key, value):
        ctype, data = value
        n = len(data)
        fn = self._fname(key)
        path = os.path.join(self.dir, fn)
        try:
            with open(path, "wb") as f:
                f.write(data)
        except OSError:
            return
        with self.lock:
            if key in self.meta:
                self.size -= self.meta[key][1]
            self.meta[key] = (ctype, n, fn)
            self.size += n
            self.meta.move_to_end(key)
            while self.size > self.max and len(self.meta) > 1:
                _, (_, s, f) = self.meta.popitem(last=False)
                self.size -= s
                try:
                    os.remove(os.path.join(self.dir, f))
                except OSError:
                    pass

    def count_vid(self, vid):
        with self.lock:
            return sum(1 for (t, v) in self.meta if v == vid and t.endswith(".ts"))

    def cleanup(self):
        shutil.rmtree(self.dir, ignore_errors=True)


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


def _proxify(abs_url, vid=None):
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
                    return 'URI="%s"' % _proxify(abs_u, vid)
                raw = _URI_ATTR_RE.sub(_sub, raw)
            out_lines.append(raw)
        else:
            abs_u = urllib.parse.urljoin(base_url, line)
            out_lines.append(_proxify(abs_u, vid))
    return "\n".join(out_lines) + "\n"


def _looks_like_m3u8(url, content_type):
    if content_type and "mpegurl" in content_type.lower():
        return True
    path = urllib.parse.urlparse(url).path.lower()
    return path.endswith(".m3u8") or path.endswith(".m3u")


APP_HTML = r"""<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>课程</title>
<style>
:root{
  --bg:#0e1116; --panel:#151a22; --panel2:#1b212b; --line:#262d39;
  --txt:#e6e9ef; --mut:#8b94a3; --accent:#4f8cff; --accent2:#6ea2ff;
  --ok:#3ecf8e; --lock:#5a6473; --shadow:0 6px 24px rgba(0,0,0,.35);
}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--txt);
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",system-ui,sans-serif;
  -webkit-font-smoothing:antialiased}
.app{display:grid;grid-template-columns:340px 1fr;height:100vh;overflow:hidden}
/* sidebar */
.side{background:var(--panel);border-right:1px solid var(--line);display:flex;flex-direction:column;min-width:0}
.side-head{padding:16px 16px 10px;border-bottom:1px solid var(--line)}
.brand{font-size:15px;font-weight:700;letter-spacing:.3px;display:flex;align-items:center;gap:8px}
.brand .dot{width:9px;height:9px;border-radius:50%;background:var(--accent);box-shadow:0 0 10px var(--accent)}
.brand .cnt{margin-left:auto;font-size:12px;color:var(--mut);font-weight:500}
.search{margin-top:10px;position:relative}
.search input{width:100%;padding:9px 12px 9px 32px;border-radius:10px;border:1px solid var(--line);
  background:var(--panel2);color:var(--txt);font-size:13px;outline:none}
.search input:focus{border-color:var(--accent)}
.search svg{position:absolute;left:10px;top:9px;color:var(--mut)}
.list{flex:1;overflow-y:auto;padding:8px}
.list::-webkit-scrollbar{width:9px}
.list::-webkit-scrollbar-thumb{background:#2b3340;border-radius:8px;border:2px solid var(--panel)}
.course{margin-bottom:4px;border-radius:10px}
.course>.row{display:flex;align-items:center;gap:8px;padding:10px 10px;cursor:pointer;border-radius:10px;
  font-size:13.5px;font-weight:600;color:var(--txt);user-select:none}
.course>.row:hover{background:var(--panel2)}
.course .chev{transition:transform .18s;color:var(--mut);flex:0 0 auto}
.course.open .chev{transform:rotate(90deg)}
.course .ctitle{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.badge{font-size:11px;color:var(--mut);background:var(--panel2);padding:2px 7px;border-radius:20px;flex:0 0 auto}
.kids{display:none;padding:2px 0 6px 6px}
.course.open>.kids{display:block}
.grp{margin:2px 0}
.grp>.ghead{display:flex;align-items:center;gap:6px;padding:6px 8px;cursor:pointer;border-radius:8px;
  font-size:12px;color:var(--mut);font-weight:600;user-select:none}
.grp>.ghead:hover{color:var(--txt)}
.grp .chev{transition:transform .18s;flex:0 0 auto}
.grp.open>.ghead .chev{transform:rotate(90deg)}
.grp>.gkids{display:none;padding-left:10px;border-left:1px solid var(--line);margin-left:11px}
.grp.open>.gkids{display:block}
.vid{display:flex;align-items:center;gap:9px;padding:8px 10px;margin:1px 0;border-radius:8px;cursor:pointer;
  font-size:13px;color:#cfd6e0;line-height:1.35}
.vid:hover{background:var(--panel2)}
.vid.active{background:linear-gradient(90deg,rgba(79,140,255,.18),rgba(79,140,255,.04));
  color:#fff;box-shadow:inset 3px 0 0 var(--accent)}
.vid .ic{flex:0 0 auto;color:var(--accent2)}
.vid.active .ic{color:var(--accent)}
.vid .vt{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.vid .dur{flex:0 0 auto;font-size:11px;color:var(--mut);font-variant-numeric:tabular-nums}
.vid.locked{color:var(--lock);cursor:not-allowed}
.vid.locked .ic{color:var(--lock)}
.loading,.empty{padding:14px 10px;color:var(--mut);font-size:12px}
.spin{display:inline-block;width:13px;height:13px;border:2px solid var(--line);border-top-color:var(--accent);
  border-radius:50%;animation:sp .7s linear infinite;vertical-align:-2px;margin-right:7px}
@keyframes sp{to{transform:rotate(360deg)}}
/* main */
.main{display:flex;flex-direction:column;min-width:0;background:var(--bg)}
.topbar{display:flex;align-items:center;gap:10px;padding:12px 18px;border-bottom:1px solid var(--line)}
.hamb{display:none;background:none;border:none;color:var(--txt);cursor:pointer;padding:4px}
.crumb{font-size:12px;color:var(--mut);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.crumb b{color:var(--txt);font-weight:600}
.stage{flex:1;overflow-y:auto;padding:18px;display:flex;flex-direction:column;align-items:center}
.player-wrap{width:100%;max-width:1100px}
.artwrap{position:relative;width:100%;aspect-ratio:16/9;background:#000;border-radius:14px;overflow:hidden;
  box-shadow:var(--shadow)}
#art{width:100%;height:100%}
.artwrap .art-video-player{border-radius:14px}
.placeholder{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;
  color:var(--mut);gap:10px;text-align:center;padding:20px;z-index:2;background:#000}
.placeholder svg{opacity:.5}
.meta{max-width:1100px;width:100%;margin-top:16px}
.vtitle{font-size:19px;font-weight:700;line-height:1.4}
.vsub{margin-top:6px;color:var(--mut);font-size:13px}
.actions{display:flex;gap:10px;margin-top:14px;flex-wrap:wrap}
.btn{display:inline-flex;align-items:center;gap:7px;padding:9px 15px;border-radius:10px;border:1px solid var(--line);
  background:var(--panel2);color:var(--txt);font-size:13px;cursor:pointer;transition:.15s}
.btn:hover:not(:disabled){border-color:var(--accent);color:#fff}
.btn:disabled{opacity:.4;cursor:not-allowed}
.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}
.btn.primary:hover{background:var(--accent2)}
.toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%) translateY(20px);opacity:0;
  background:#222b38;color:#fff;padding:10px 16px;border-radius:10px;font-size:13px;box-shadow:var(--shadow);
  transition:.25s;pointer-events:none;z-index:50;border:1px solid var(--line)}
.toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
.iconbtn{background:none;border:none;color:var(--mut);cursor:pointer;padding:5px;border-radius:8px;display:flex}
.iconbtn:hover{color:var(--txt);background:var(--panel2)}
.iconbtn.on{color:var(--accent)}
/* settings */
.settings{display:none;flex:1;overflow-y:auto;padding:24px 18px}
.app.settings-on .stage{display:none}
.app.settings-on .settings{display:block}
.set-wrap{max-width:760px;margin:0 auto}
.set-h{font-size:20px;font-weight:700;margin:0 0 6px}
.set-sub{color:var(--mut);font-size:13px;line-height:1.7;margin:0 0 18px}
.set-sub code{color:var(--accent2)}
.set-card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:18px;margin-bottom:16px}
.set-h3{font-size:14px;font-weight:700;margin:0 0 14px}
.set-row{display:flex;align-items:center;gap:12px;margin-bottom:14px}
.set-label{font-size:13px;color:var(--mut);width:48px;flex:0 0 auto}
.set-select{flex:1;padding:9px 12px;border-radius:10px;border:1px solid var(--line);background:var(--panel2);
  color:var(--txt);font-size:13px;outline:none}
.set-select:focus{border-color:var(--accent)}
.set-actions{display:flex;gap:10px;margin-bottom:16px;flex-wrap:wrap}
.set-prog-row{display:flex;align-items:center;gap:10px;margin-top:8px}
.set-prog-row .pl{width:42px;flex:0 0 auto;font-size:12px;color:var(--mut)}
.prog{flex:1;height:9px;background:var(--panel2);border-radius:6px;overflow:hidden}
.prog-bar{height:100%;width:0;background:linear-gradient(90deg,var(--accent),var(--accent2));
  border-radius:6px;transition:width .4s}
.prog-bar.buf{background:linear-gradient(90deg,#3ecf8e,#5fe0a6)}
.prog-text{flex:0 0 auto;min-width:170px;text-align:right;font-size:12px;color:var(--mut);font-variant-numeric:tabular-nums}
.tablewrap{max-height:420px;overflow:auto;border:1px solid var(--line);border-radius:10px}
.dtable{width:100%;border-collapse:collapse;font-size:13px}
.dtable thead th{position:sticky;top:0;background:var(--panel2);color:var(--mut);font-weight:600;
  text-align:left;padding:9px 12px;font-size:12px;border-bottom:1px solid var(--line);white-space:nowrap}
.dtable td{padding:9px 12px;border-bottom:1px solid var(--line);vertical-align:middle}
.dtable tr:last-child td{border-bottom:none}
.dtable tbody tr:hover{background:var(--panel2)}
.dtable .nm{max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dtable .num{font-variant-numeric:tabular-nums;color:var(--mut);white-space:nowrap}
.dtable .empty{color:var(--mut);padding:16px}
.chip{display:inline-flex;align-items:center;gap:5px;padding:2px 9px;border-radius:20px;font-size:11.5px;
  background:var(--panel2);color:var(--mut);white-space:nowrap}
.chip.ok{background:rgba(62,207,142,.16);color:#5fe0a6}
.chip.run{background:rgba(79,140,255,.16);color:var(--accent2)}
.chip.err{background:rgba(255,90,90,.16);color:#ff8a8a}
.cell-bar{display:inline-block;width:60px;height:6px;background:var(--panel2);border-radius:4px;overflow:hidden;
  vertical-align:middle;margin-right:7px}
.cell-bar i{display:block;height:100%;width:0;background:var(--ok);border-radius:4px}
.tbtn{padding:3px 9px;border-radius:7px;border:1px solid var(--line);background:var(--panel2);color:var(--txt);
  font-size:11.5px;cursor:pointer}
.tbtn:hover{border-color:var(--accent);color:#fff}
.set-kv{display:flex;justify-content:space-between;padding:7px 0;font-size:13px;border-bottom:1px solid var(--line)}
.set-kv:last-child{border-bottom:none}
.set-kv span{color:var(--mut)}
.set-kv b{font-weight:600}
.scrim{display:none}
@media(max-width:860px){
  .app{grid-template-columns:1fr}
  .side{position:fixed;z-index:40;top:0;bottom:0;left:0;width:86%;max-width:360px;
    transform:translateX(-100%);transition:transform .25s;box-shadow:var(--shadow)}
  .app.drawer .side{transform:none}
  .hamb{display:inline-flex}
  .scrim{display:block;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:39;opacity:0;pointer-events:none;
    transition:.25s}
  .app.drawer .scrim{opacity:1;pointer-events:auto}
  .stage{padding:12px}
  .vtitle{font-size:17px}
}
</style>
</head>
<body>
<div class="app" id="app">
  <aside class="side" id="side">
    <div class="side-head">
      <div class="brand"><span class="dot"></span>我的课程<span class="cnt" id="cnt"></span></div>
      <div class="search">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
        <input id="q" placeholder="搜索讲次 / 课程…" autocomplete="off">
      </div>
    </div>
    <div class="list" id="list"><div class="loading"><span class="spin"></span>加载课程…</div></div>
  </aside>
  <div class="scrim" id="scrim"></div>
  <main class="main">
    <div class="topbar">
      <button class="hamb" id="hamb" aria-label="menu"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M3 12h18M3 18h18"/></svg></button>
      <div class="crumb" id="crumb">选择左侧任意一讲开始</div>
      <button class="iconbtn" id="gear" title="设置"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button>
    </div>
    <div class="stage" id="stage">
      <div class="player-wrap">
        <div class="artwrap">
          <div id="art"></div>
          <div class="placeholder" id="ph">
            <svg width="46" height="46" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="m10 8 6 4-6 4V8z"/><rect x="3" y="4" width="18" height="16" rx="3"/></svg>
            <div>从左侧选择一讲开始播放</div>
          </div>
        </div>
        <div class="meta">
          <div class="vtitle" id="vtitle">—</div>
          <div class="vsub" id="vsub"></div>
          <div class="actions">
            <button class="btn" id="prev" disabled>← 上一讲</button>
            <button class="btn primary" id="next" disabled>下一讲 →</button>
            <button class="btn" id="dl">复制下载命令</button>
          </div>
        </div>
      </div>
    </div>
    <div class="settings" id="settings">
      <div class="set-wrap">
        <h2 class="set-h">预生成 &amp; 缓冲</h2>
        <p class="set-sub">提前生成拖动缩略图、把整集缓冲到服务端，看课更顺。缩略图持久保存（<code id="set-dir">~/.youdao_course/thumbs</code>）；整集缓冲走磁盘缓存（LRU，受上限约束，优先缓冲将看的课）。</p>
        <div class="set-card">
          <div class="set-row">
            <label class="set-label">范围</label>
            <select id="set-scope" class="set-select"></select>
          </div>
          <div class="set-actions">
            <button class="btn primary" id="set-gen">生成缩略图</button>
            <button class="btn" id="set-buf">缓冲整集</button>
            <button class="btn" id="set-refresh">刷新</button>
          </div>
          <div class="set-prog-row"><span class="pl">缩略图</span><div class="prog"><div class="prog-bar" id="tb-bar"></div></div><span class="prog-text" id="tb-text">—</span></div>
          <div class="set-prog-row"><span class="pl">缓冲</span><div class="prog"><div class="prog-bar buf" id="bf-bar"></div></div><span class="prog-text" id="bf-text">—</span></div>
        </div>
        <div class="set-card">
          <h3 class="set-h3">明细</h3>
          <div class="tablewrap"><table class="dtable"><thead id="dthead"></thead><tbody id="dtbody"><tr><td class="empty">加载中…</td></tr></tbody></table></div>
        </div>
        <div class="set-card">
          <h3 class="set-h3">信息</h3>
          <div class="set-kv"><span>缩略图目录</span><b id="set-cdir">—</b></div>
          <div class="set-kv"><span>缩略图占用</span><b id="set-csize">—</b></div>
          <div class="set-kv"><span>缓冲缓存</span><b id="set-bsize">—</b></div>
          <div class="set-kv"><span>ffmpeg</span><b id="set-ffmpeg">—</b></div>
        </div>
      </div>
    </div>
  </main>
</div>
<div class="toast" id="toast"></div>
<script src="/hls.js"></script>
<script src="/artplayer.js"></script>
<script>
const AUTO = __AUTO__;
const $ = s => document.querySelector(s);
const el = (t,c)=>{const e=document.createElement(t);if(c)e.className=c;return e;};
const fmtDur = s => { s=parseInt(s||0); if(!s)return''; const m=Math.floor(s/60),x=s%60; return m+':'+String(x).padStart(2,'0'); };
const esc = s => (s||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
let courses=[], byId={}, curList=[], activeVid=null, hls=null;

function toast(m){const t=$('#toast');t.textContent=m;t.classList.add('show');clearTimeout(t._t);t._t=setTimeout(()=>t.classList.remove('show'),2200);}
function closeDrawer(){$('#app').classList.remove('drawer');}

async function api(u){const r=await fetch(u);if(!r.ok)throw new Error('HTTP '+r.status);return r.json();}

async function init(){
  try{ const d=await api('/api/courses'); courses=d.courses||[]; }
  catch(e){ $('#list').innerHTML='<div class="empty">加载课程失败：'+esc(e.message)+'<br>会话可能过期，请重新抓一条请求覆盖 req.txt。</div>'; return; }
  $('#cnt').textContent=courses.length+' 门';
  const list=$('#list'); list.innerHTML='';
  courses.forEach(c=>{ byId[c.id]=c; list.appendChild(courseEl(c)); });
  if(AUTO && AUTO.productId){ openCourse(AUTO.productId, AUTO.videoId); }
}

function courseEl(c){
  const wrap=el('div','course'); wrap.dataset.pid=c.id;
  const row=el('div','row');
  row.innerHTML='<svg class="chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m9 6 6 6-6 6"/></svg>'
    +'<span class="ctitle">'+esc(c.name)+'</span><span class="badge">'+(c.cardType||'课程')+'</span>';
  const kids=el('div','kids'); kids.innerHTML='';
  row.onclick=()=>toggleCourse(wrap,kids,c.id);
  wrap.appendChild(row); wrap.appendChild(kids);
  return wrap;
}

async function toggleCourse(wrap,kids,pid){
  if(wrap.classList.contains('open')){ wrap.classList.remove('open'); return; }
  wrap.classList.add('open');
  if(kids.dataset.loaded) return;
  kids.innerHTML='<div class="loading"><span class="spin"></span>加载讲次…</div>';
  try{
    const d=await api('/api/course?productId='+encodeURIComponent(pid));
    kids.dataset.loaded='1';
    renderVideos(kids, d.videos||[], pid);
  }catch(e){ kids.innerHTML='<div class="empty">加载失败：'+esc(e.message)+'</div>'; }
}

function renderVideos(kids, vids, pid){
  byId[pid]._vids=vids;
  if(!vids.length){ kids.innerHTML='<div class="empty">这门课暂无视频</div>'; return; }
  kids.innerHTML='';
  // 按 module → topic → examKey 分组，保持顺序
  const tree=[], idx={}, rootVids=[];
  vids.forEach(v=>{
    const path=[v.module,v.topic,v.examKey].filter(x=>x);
    if(!path.length){ rootVids.push(v); return; }
    let level=tree, key='', node=null;
    path.forEach(p=>{ key+='|'+p;
      if(!idx[key]){ node={name:p,kids:[],vids:[]}; idx[key]=node; level.push(node); }
      node=idx[key]; level=node.kids; });
    node.vids.push(v);
  });
  rootVids.forEach(v=>kids.appendChild(vidEl(v,pid)));
  tree.forEach(n=>kids.appendChild(groupEl(n,pid)));
}

function groupEl(n,pid){
  const g=el('div','grp open');
  const h=el('div','ghead');
  h.innerHTML='<svg class="chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m9 6 6 6-6 6"/></svg><span>'+esc(n.name)+'</span>';
  const gk=el('div','gkids');
  n.kids.forEach(c=>gk.appendChild(groupEl(c,pid)));
  n.vids.forEach(v=>gk.appendChild(vidEl(v,pid)));
  h.onclick=()=>g.classList.toggle('open');
  g.appendChild(h); g.appendChild(gk); return g;
}

function vidEl(v,pid){
  const d=el('div','vid'+(v.locked?' locked':'')); d.dataset.vid=v.videoId;
  const ic=v.locked
    ? '<svg class="ic" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>'
    : '<svg class="ic" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
  d.innerHTML=ic+'<span class="vt">'+esc(v.title||('视频'+v.videoId))+'</span><span class="dur">'+fmtDur(v.duration)+'</span>';
  if(!v.locked) d.onclick=()=>play(v,pid);
  return d;
}

async function openCourse(pid, vid){
  const wrap=document.querySelector('.course[data-pid="'+pid+'"]'); if(!wrap)return;
  const kids=wrap.querySelector('.kids');
  await toggleCourse(wrap,kids,pid);
  wrap.scrollIntoView({block:'nearest'});
  if(vid){ const v=(byId[pid]._vids||[]).find(x=>x.videoId==vid); if(v)play(v,pid); }
}

async function play(v,pid){
  curList=(byId[pid]._vids||[]).filter(x=>!x.locked);
  activeVid=v.videoId;
  document.querySelectorAll('.vid.active').forEach(e=>e.classList.remove('active'));
  const node=document.querySelector('.vid[data-vid="'+v.videoId+'"]'); if(node)node.classList.add('active');
  $('#crumb').innerHTML='<b>'+esc(byId[pid].name)+'</b>'+[v.module,v.topic,v.examKey].filter(x=>x).map(x=>' › '+esc(x)).join('');
  $('#vtitle').textContent=v.title||('视频 '+v.videoId);
  $('#vsub').textContent=[v.examKey,fmtDur(v.duration)&&('时长 '+fmtDur(v.duration))].filter(x=>x).join(' · ');
  $('#ph').style.display='none';
  updNav(); closeDrawer(); localStorage.setItem('last',JSON.stringify({pid,vid:v.videoId}));
  $('#dl').onclick=()=>{const c='python3 youdao_course.py download -r req.txt --video '+v.videoId+' -o "'+(v.title||v.videoId)+'.mp4"';navigator.clipboard&&navigator.clipboard.writeText(c);toast('下载命令已复制');};
  try{
    const m3u8=pickM3u8(v);
    if(!m3u8){ toast('该讲暂无可播放地址（可能未解锁）'); return; }
    const r=await api('/api/play?videoId='+v.videoId+'&contentId='+v.contentId
      +'&cardPackageId='+v.cardPackageId+'&productId='+v.productId
      +'&m3u8='+encodeURIComponent(m3u8));
    curVideo=v; mountArt(r.url, v);
  }catch(e){ toast('取流失败：'+e.message); }
}

function pickM3u8(v){
  const c=(v.clarity||[]).filter(x=>x&&x.url).sort((a,b)=>(b.type||0)-(a.type||0));
  return c.length?c[0].url:(v.downloadUrl||null);
}

// ---- Artplayer 播放器 + 服务端缩略图（拖动预览）----
let art=null, curUrl=null, curVideo=null;
const thumbState={};

// 拖动时大画面实时跟手：拖动中暂停、按指针位置追帧、松手续播。
// 缓冲区内的位置 seek 是即时的，所以看起来就是画面随手滑动。
const _scrub={on:false,want:null,busy:false,prog:null,wasPlaying:false};
function _scrubTime(e){
  const p=_scrub.prog; if(!p||!art)return 0;
  const r=p.getBoundingClientRect();
  const n=Math.min(Math.max(e.clientX-r.left,0),p.clientWidth);  // 用 clientWidth，与 Artplayer 一致
  return n/p.clientWidth*(art.video.duration||0);
}
function _scrubChase(t){
  if(!art)return; _scrub.want=t; if(_scrub.busy)return; _scrub.busy=true;
  const v=art.video;
  const done=()=>{ v.removeEventListener('seeked',done); _scrub.busy=false;
    if(_scrub.want!=null && Math.abs(_scrub.want-t)>0.05){ const n=_scrub.want; _scrub.want=null; _scrubChase(n); }
    else _scrub.want=null; };
  v.addEventListener('seeked',done);
  try{ v.currentTime=t; }catch(_){ _scrub.busy=false; }
}
window.addEventListener('pointermove',e=>{ if(_scrub.on)_scrubChase(_scrubTime(e)); });
window.addEventListener('pointerup',()=>{ if(!_scrub.on)return; _scrub.on=false;
  if(_scrub.wasPlaying&&art)art.video.play().catch(()=>{}); });
function enableLiveScrub(a){
  const root=a.template&&a.template.$player; if(!root)return;
  const prog=root.querySelector('.art-control-progress-inner')
    ||root.querySelector('.art-control-progress');
  if(!prog)return; _scrub.prog=prog;
  prog.addEventListener('pointerdown',e=>{ if(!art)return;
    _scrub.on=true; _scrub.wasPlaying=!art.video.paused;
    if(_scrub.wasPlaying)art.video.pause(); _scrubChase(_scrubTime(e)); });
}

function hlsAttach(video,url){
  if(window.Hls&&Hls.isSupported()){
    const h=new Hls({
      maxBufferLength:120, maxMaxBufferLength:300, backBufferLength:180,
      maxBufferSize:200*1000*1000, maxBufferHole:0.5, startFragPrefetch:true,
      testBandwidth:false, fragLoadingMaxRetry:8, nudgeMaxRetry:10, lowLatencyMode:false
    });
    h.loadSource(url); h.attachMedia(video);
    h.on(Hls.Events.ERROR,(e,d)=>{ if(!d.fatal)return;
      if(d.type===Hls.ErrorTypes.NETWORK_ERROR)h.startLoad();
      else if(d.type===Hls.ErrorTypes.MEDIA_ERROR)h.recoverMediaError();
      else toast('播放错误，可能未解锁或会话过期'); });
    return h;
  } else if(video.canPlayType('application/vnd.apple.mpegurl')){ video.src=url; }
  return null;
}

function mountArt(url, v, startTime){
  $('#ph').style.display='none';
  curUrl=url;
  const opt={
    container:'#art', url:url, type:'m3u8', autoplay:true, theme:'#4f8cff',
    volume:1, playbackRate:true, setting:true, fullscreen:true, fullscreenWeb:true,
    pip:true, miniProgressBar:true, fastForward:true, autoOrientation:true,
    playsInline:true, hotkey:true, lock:true,
    customType:{ m3u8:(video,u,a)=>{ if(a._hls)try{a._hls.destroy();}catch(_){}; a._hls=hlsAttach(video,u); } },
  };
  const tb=thumbState[v.videoId];
  if(tb && tb.state==='ready') opt.thumbnails={url:tb.url,number:tb.number,column:tb.column,width:tb.width,height:tb.height};
  if(art){ try{ if(art._hls)art._hls.destroy(); art.destroy(true); }catch(_){}; art=null; }
  art=new Artplayer(opt);
  art.on('video:ended',()=>{ const b=$('#next'); if(b&&!b.disabled)b.click(); });
  art.once('ready',()=>{ enableLiveScrub(art); if(startTime){ try{art.currentTime=startTime;}catch(_){} } });
  ensureThumbs(v);
}

function pickLow(v){
  const c=(v.clarity||[]).filter(x=>x&&x.url).sort((a,b)=>(a.type||0)-(b.type||0));
  return c.length?c[0].url:'';
}
async function ensureThumbs(v){
  const cur=thumbState[v.videoId];
  if(cur && cur.state==='ready'){ applyThumbs(v.videoId); return; }
  const low=pickLow(v); if(!low) return;
  const q='videoId='+v.videoId+'&contentId='+v.contentId+'&cardPackageId='+v.cardPackageId
    +'&productId='+v.productId+'&duration='+(v.duration||0)+'&src='+encodeURIComponent(low);
  for(let i=0;i<90;i++){
    if(activeVid!==v.videoId) return;     // 切走了就不再等它的缩略图
    let r; try{ r=await api('/api/thumb?'+q); }catch(e){ return; }
    thumbState[v.videoId]=r;
    if(r.state==='ready'){ applyThumbs(v.videoId); return; }
    if(r.state==='error'){ return; }
    await new Promise(z=>setTimeout(z,2000));
  }
}

function applyThumbs(vid){
  const tb=thumbState[vid];
  if(!tb || tb.state!=='ready' || activeVid!==vid || !art) return;
  if(art.option.thumbnails && art.option.thumbnails.url) return;  // 已有
  // 当前实例没带缩略图：带着进度无缝重建一次（之后再看这节就直接带上了）
  const t=art.currentTime||0; mountArt(curUrl, curVideo, t);
}

function updNav(){
  const i=curList.findIndex(x=>x.videoId===activeVid);
  $('#prev').disabled=!(i>0); $('#next').disabled=!(i>=0&&i<curList.length-1);
  $('#prev').onclick=()=>{ if(i>0)play(curList[i-1],curList[i-1].productId); };
  $('#next').onclick=()=>{ if(i<curList.length-1)play(curList[i+1],curList[i+1].productId); };
}
// search filter
$('#q').addEventListener('input',e=>{
  const q=e.target.value.trim().toLowerCase();
  document.querySelectorAll('.course').forEach(c=>{
    const name=(byId[c.dataset.pid]||{}).name||'';
    let any=!q||name.toLowerCase().includes(q);
    c.querySelectorAll('.vid').forEach(v=>{
      const t=v.querySelector('.vt').textContent.toLowerCase();
      const hit=!q||t.includes(q)||name.toLowerCase().includes(q);
      v.style.display=hit?'':'none'; if(hit)any=true;
    });
    c.style.display=any?'':'none';
    c.querySelectorAll('.grp').forEach(g=>{
      const vis=[...g.querySelectorAll('.vid')].some(v=>v.style.display!=='none');
      g.style.display=vis?'':'none';
    });
    if(q&&any)c.classList.add('open');
  });
});
$('#hamb').onclick=()=>$('#app').classList.toggle('drawer');
$('#scrim').onclick=closeDrawer;

// ---- 设置页：缩略图 + 整集缓冲，批量 + 明细表格 ----
let setVideos={}, setLoaded=false, statusCache={thumb:{states:{}},buffer:{perVid:{}}}, pollTimer=null;
function fmtBytes(n){ n=n||0; if(n<1024)return n+' B'; if(n<1048576)return (n/1024|0)+' KB';
  if(n<1073741824)return (n/1048576).toFixed(1)+' MB'; return (n/1073741824).toFixed(2)+' GB'; }
function scopeVids(){
  const scope=$('#set-scope').value;
  if(scope==='all'){ let a=[]; courses.forEach(c=>{ a=a.concat(setVideos[c.id]||[]); }); return a; }
  return setVideos[scope]||[];
}
function tState(id){ return (statusCache.thumb.states||{})[String(id)]; }
function bInfo(id){ return (statusCache.buffer.perVid||{})[String(id)]||{}; }
function isBuffered(v){ const b=bInfo(v.videoId); return b.state==='done' || (b.total && b.cached>=b.total); }

async function ensureCourseLoaded(pid){
  if(pid==='all' || setVideos[pid]) return;
  try{ if(!byId[pid]._vids){ const d=await api('/api/course?productId='+pid); byId[pid]._vids=d.videos||[]; } }
  catch(e){ byId[pid]._vids=byId[pid]._vids||[]; }
  setVideos[pid]=(byId[pid]._vids||[]).filter(v=>!v.locked && pickLow(v));
}
async function loadAllCourseVideos(){
  if(setLoaded){ return; }
  for(const c of courses){
    try{ if(!byId[c.id]._vids){ const d=await api('/api/course?productId='+c.id); byId[c.id]._vids=d.videos||[]; } }
    catch(e){ byId[c.id]._vids=byId[c.id]._vids||[]; }
    setVideos[c.id]=(byId[c.id]._vids||[]).filter(v=>!v.locked && pickLow(v));
    renderTable();
  }
  setLoaded=true; pollOnce();
}

function thumbChip(id){
  const s=tState(id);
  if(s==='ready')return '<span class="chip ok">✓ 已生成</span>';
  if(s==='gen')return '<span class="chip run">⏳ 生成中</span>';
  if(s==='error')return '<span class="chip err">✗ 失败</span>';
  return '<span class="chip">—</span>';
}
function bufCell(v){
  const b=bInfo(v.videoId);
  if(b.state==='working')return '<span class="chip run">⏳ 缓冲中</span>';
  if(b.state==='error')return '<span class="chip err">✗ 失败</span>';
  if(b.total){ const pct=Math.round(b.cached/b.total*100);
    return '<span class="cell-bar"><i style="width:'+pct+'%"></i></span><span class="num">'+b.cached+'/'+b.total+'</span>'; }
  if(b.cached)return '<span class="num">'+b.cached+' 段</span>';
  return '<span class="chip">—</span>';
}

function renderTable(){
  const head=$('#dthead'), body=$('#dtbody'); if(!head||!body)return;
  const scope=$('#set-scope').value;
  if(scope==='all'){
    head.innerHTML='<tr><th>课程</th><th>视频</th><th>缩略图</th><th>缓冲</th></tr>';
    body.innerHTML = courses.map(c=>{
      const vs=setVideos[c.id]; if(!vs)return '<tr><td class="nm">'+esc(c.name)+'</td><td class="num">…</td><td class="num">…</td><td class="num">…</td></tr>';
      const tready=vs.filter(v=>tState(v.videoId)==='ready').length;
      const bdone=vs.filter(v=>isBuffered(v)).length;
      return '<tr><td class="nm">'+esc(c.name)+'</td><td class="num">'+vs.length+'</td>'
        +'<td class="num">'+tready+'/'+vs.length+'</td><td class="num">'+bdone+'/'+vs.length+'</td></tr>';
    }).join('') || '<tr><td class="empty">加载中…</td></tr>';
  } else {
    head.innerHTML='<tr><th>讲次</th><th>时长</th><th>缩略图</th><th>缓冲</th><th>操作</th></tr>';
    const vs=setVideos[scope];
    if(!vs){ body.innerHTML='<tr><td class="empty">加载中…</td></tr>'; return; }
    body.innerHTML = vs.map(v=>(
      '<tr data-vid="'+v.videoId+'"><td class="nm" title="'+esc(v.title||'')+'">'+esc(v.title||('视频'+v.videoId))+'</td>'
      +'<td class="num">'+(fmtDur(v.duration)||'—')+'</td>'
      +'<td>'+thumbChip(v.videoId)+'</td><td>'+bufCell(v)+'</td>'
      +'<td><button class="tbtn" data-act="thumb" data-vid="'+v.videoId+'">缩略图</button> '
      +'<button class="tbtn" data-act="buf" data-vid="'+v.videoId+'">缓冲</button></td></tr>'
    )).join('') || '<tr><td class="empty">这门课没有可处理的视频</td></tr>';
  }
}

async function pollOnce(){
  let s; try{ s=await api('/api/status'); }catch(e){ return; }
  statusCache=s;
  $('#set-cdir').textContent=s.thumbDir||'—'; $('#set-dir').textContent=s.thumbDir||'~/.youdao_course/thumbs';
  $('#set-ffmpeg').textContent=s.ffmpeg?'可用':'未安装（无法生成，brew install ffmpeg）';
  const tb=s.thumb||{}, bf=s.buffer||{};
  // 缩略图占用：用 buffer.bytes? 不，单独：sum sprite via /api/thumbs/status? 这里用缓冲缓存显示
  $('#set-bsize').textContent=fmtBytes(bf.bytes)+' / '+fmtBytes(bf.limit);
  const vs=scopeVids();
  const tReady=vs.filter(v=>tState(v.videoId)==='ready').length;
  const bDone=vs.filter(v=>isBuffered(v)).length;
  const tot=vs.length;
  $('#tb-bar').style.width=(tot?tReady/tot*100:0)+'%';
  $('#bf-bar').style.width=(tot?bDone/tot*100:0)+'%';
  $('#tb-text').textContent= tot?(tReady+'/'+tot+'　生成中 '+tb.generating.length+'　队列 '+tb.queued):'—';
  $('#bf-text').textContent= tot?(bDone+'/'+tot+'　缓冲中 '+(bf.working||[]).length+'　队列 '+bf.queued):'—';
  // 缩略图占用大小另查一次（轻量）
  try{ const ts=await api('/api/thumbs/status'); $('#set-csize').textContent=fmtBytes(ts.bytes); }catch(e){}
  renderTable();
  clearTimeout(pollTimer); pollTimer=null;
  if((tb.queued||0)+(tb.generating||[]).length+(bf.queued||0)+(bf.working||[]).length>0)
    pollTimer=setTimeout(pollOnce,1500);
}

async function postBatch(url,vids,mk){
  if(!vids.length){ toast('该范围没有可处理的视频'); return; }
  try{
    const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({videos:vids.map(mk)})}).then(x=>x.json());
    toast('已加入队列 '+r.queued+'（跳过 '+r.skipped+'）');
  }catch(e){ toast('提交失败：'+e.message); }
  pollOnce();
}
async function genThumbs(){ await loadAllCourseVideos();
  postBatch('/api/thumbs/batch', scopeVids(), v=>({videoId:v.videoId,contentId:v.contentId,
    cardPackageId:v.cardPackageId,productId:v.productId,duration:v.duration,src:pickLow(v)})); }
async function bufCourse(){ await loadAllCourseVideos();
  postBatch('/api/buffer/batch', scopeVids(), v=>({videoId:v.videoId,contentId:v.contentId,
    cardPackageId:v.cardPackageId,productId:v.productId,src:pickM3u8(v)})); }

function vById(id){ for(const c of courses){ const v=(setVideos[c.id]||[]).find(x=>String(x.videoId)===String(id)); if(v)return v; } return null; }
$('#dtbody').addEventListener('click',e=>{
  const btn=e.target.closest('.tbtn'); if(!btn)return;
  const v=vById(btn.dataset.vid); if(!v)return;
  if(btn.dataset.act==='thumb') postBatch('/api/thumbs/batch',[v],x=>({videoId:x.videoId,contentId:x.contentId,cardPackageId:x.cardPackageId,productId:x.productId,duration:x.duration,src:pickLow(x)}));
  else postBatch('/api/buffer/batch',[v],x=>({videoId:x.videoId,contentId:x.contentId,cardPackageId:x.cardPackageId,productId:x.productId,src:pickM3u8(x)}));
});

function openSettings(){
  const sel=$('#set-scope');
  if(sel.dataset.n!==String(courses.length)){
    sel.innerHTML='<option value="all">全部课程（'+courses.length+'）</option>'
      +courses.map(c=>'<option value="'+c.id+'">'+esc(c.name)+'</option>').join('');
    sel.dataset.n=String(courses.length);
  }
  pollOnce(); loadAllCourseVideos();
}
$('#gear').onclick=()=>{ const on=$('#app').classList.toggle('settings-on');
  $('#gear').classList.toggle('on',on); if(on)openSettings(); };
$('#set-scope').onchange=async()=>{ await ensureCourseLoaded($('#set-scope').value); renderTable(); pollOnce(); };
$('#set-gen').onclick=genThumbs;
$('#set-buf').onclick=bufCourse;
$('#set-refresh').onclick=pollOnce;

init();
</script>
</body>
</html>
"""


_ASSET_CDN = {
    "hls.js": "https://cdn.jsdelivr.net/npm/hls.js@1.5.13/dist/hls.min.js",
    "artplayer.js": "https://cdn.jsdelivr.net/npm/artplayer@5.1.7/dist/artplayer.js",
}
_ASSET_CACHE = {}


def asset_bytes(name):
    """本地代理自带前端依赖（hls.js / artplayer.js），首次从 CDN 取一次并缓存。"""
    if name not in _ASSET_CACHE:
        try:
            req = urllib.request.Request(_ASSET_CDN[name],
                                         headers={"User-Agent": "youdao_course"})
            with urllib.request.urlopen(req, timeout=30) as r:
                _ASSET_CACHE[name] = r.read()
        except Exception:  # noqa: BLE001
            _ASSET_CACHE[name] = b""
    return _ASSET_CACHE[name]


# 缩略图雪碧图参数
THUMB_INTERVAL = 10   # 每 10 秒一帧
THUMB_W = 160
THUMB_H = 90
THUMB_COLS = 10
# 缩略图持久化目录（生成后不删，跨会话复用）
THUMB_DIR = os.path.join(os.path.expanduser("~"), ".youdao_course", "thumbs")
THUMB_WORKERS = 3


def make_handler(base_headers, default_url="", session=None, auto=None,
                 prefetch=True, cache_bytes=SEG_CACHE_BYTES, port=8808):
    session = session if session is not None else base_headers
    page = APP_HTML.replace("__AUTO__", json.dumps(auto) if auto else "null")
    video_headers = {}
    vh_lock = threading.Lock()
    seg_cache = _DiskLRU(cache_bytes)

    # 缩略图雪碧图：服务端用 ffmpeg 生成（复用已缓存分片），供 Artplayer 拖动预览。
    # 持久化到 ~/.youdao_course/thumbs，生成后不删，跨会话复用。
    thumb_dir = THUMB_DIR
    os.makedirs(thumb_dir, exist_ok=True)
    thumb_index_path = os.path.join(thumb_dir, "index.json")
    thumb_meta = {}  # vid -> {"state": "gen"/"ready"/"error", ...}
    thumb_lock = threading.Lock()
    thumb_q = queue.Queue()
    have_ffmpeg = _which("ffmpeg") is not None
    try:
        with open(thumb_index_path, "r", encoding="utf-8") as f:
            for vid, m in (json.load(f) or {}).items():
                if os.path.exists(os.path.join(thumb_dir, "%s.jpg" % vid)):
                    thumb_meta[vid] = m
    except Exception:  # noqa: BLE001
        pass

    def _save_index():
        with thumb_lock:
            snap = {k: v for k, v in thumb_meta.items() if v.get("state") == "ready"}
        try:
            with open(thumb_index_path, "w", encoding="utf-8") as f:
                json.dump(snap, f)
        except Exception:  # noqa: BLE001
            pass

    def _thumb_worker():
        while True:
            vid, m3u8, duration = thumb_q.get()
            try:
                _gen_thumbs(vid, m3u8, duration)
            except Exception as e:  # noqa: BLE001
                with thumb_lock:
                    thumb_meta[vid] = {"state": "error", "reason": str(e)}
            finally:
                thumb_q.task_done()

    def _gen_thumbs(vid, m3u8, duration):
        if duration <= 0:
            duration = 600
        number = max(1, int(duration // THUMB_INTERVAL))
        rows = (number + THUMB_COLS - 1) // THUMB_COLS
        out = os.path.join(thumb_dir, "%s.jpg" % vid)
        tvid = "t_" + vid  # 缩略图用低清流自己的 Url 头（key 按清晰度绑定）
        with vh_lock:
            th = dict(video_headers.get(tvid) or {})
        if not th:
            with thumb_lock:
                thumb_meta[vid] = {"state": "error", "reason": "no headers"}
            return
        # 先并行把低清分片+密钥灌进缓存，ffmpeg 再顺序读缓存就很快
        try:
            pl, _, _ = upstream_fetch(th, m3u8)
            text = pl.decode("utf-8", "replace")
            urls = [urllib.parse.urljoin(m3u8, ln.strip())
                    for ln in text.splitlines() if ln.strip() and not ln.startswith("#")]
            for ln in text.splitlines():
                if ln.startswith("#EXT-X-KEY") and 'URI="' in ln:
                    urls.insert(0, urllib.parse.urljoin(m3u8, re.search(r'URI="([^"]+)"', ln).group(1)))

            def _grab(u):
                if seg_cache.has((u, tvid)):
                    return
                try:
                    d, c, _ = upstream_fetch(th, u)
                    seg_cache.put((u, tvid), (c or "video/mp2t", d))
                except Exception:  # noqa: BLE001
                    pass
            with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:
                list(ex.map(_grab, urls))
        except Exception:  # noqa: BLE001
            pass
        proxied = "http://127.0.0.1:%d/p?u=%s&vid=%s" % (
            port, urllib.parse.quote(m3u8, safe=""), tvid)
        vf = ("fps=1/%d,scale=%d:%d:force_original_aspect_ratio=increase,"
              "crop=%d:%d,tile=%dx%d" % (THUMB_INTERVAL, THUMB_W, THUMB_H,
                                         THUMB_W, THUMB_H, THUMB_COLS, rows))
        # -skip_frame nokey：只解关键帧，配合 fps 过滤器既保持均匀间隔又大幅加速
        cmd = ["ffmpeg", "-y", "-nostdin", "-skip_frame", "nokey", "-i", proxied,
               "-an", "-vf", vf, "-frames:v", "1", "-q:v", "6", out, "-loglevel", "error"]
        rc = subprocess.call(cmd)
        if rc == 0 and os.path.exists(out):
            with thumb_lock:
                thumb_meta[vid] = {"state": "ready", "url": "/thumbs/%s.jpg" % vid,
                                   "number": number, "column": THUMB_COLS,
                                   "width": THUMB_W, "height": THUMB_H}
            _save_index()
        else:
            with thumb_lock:
                thumb_meta[vid] = {"state": "error", "reason": "ffmpeg rc=%d" % rc}

    def start_thumbs(video, m3u8, duration):
        """video: {videoId,contentId,cardPackageId,productId}; m3u8: 低清地址。"""
        vid = str(video["videoId"])
        if not have_ffmpeg:
            return {"state": "error", "reason": "no ffmpeg"}
        with thumb_lock:
            st = thumb_meta.get(vid)
            if st and st["state"] in ("ready", "gen"):
                return st
            thumb_meta[vid] = {"state": "gen"}
        with vh_lock:
            video_headers["t_" + vid] = play_headers(session, video, m3u8)
        thumb_q.put((vid, m3u8, duration))
        return {"state": "gen"}

    for _ in range(max(1, THUMB_WORKERS)):
        threading.Thread(target=_thumb_worker, daemon=True).start()

    # 整集缓冲（把整节课分片下到服务端磁盘缓存）：批量预缓冲 + 状态
    seg_total = {}        # vid -> 总分片数（已知时）
    buf_state = {}        # vid -> "queued"/"working"/"done"/"error"
    buf_lock = threading.Lock()
    buf_q = queue.Queue()

    def _buffer_one(video, m3u8):
        vid = str(video["videoId"])
        th = play_headers(session, video, m3u8)
        with vh_lock:
            video_headers[vid] = th
        pl, _, _ = upstream_fetch(th, m3u8)
        text = pl.decode("utf-8", "replace")
        segs = [urllib.parse.urljoin(m3u8, ln.strip())
                for ln in text.splitlines() if ln.strip() and not ln.startswith("#")]
        seg_total[vid] = len(segs)
        urls = list(segs)
        for ln in text.splitlines():
            if ln.startswith("#EXT-X-KEY") and 'URI="' in ln:
                urls.insert(0, urllib.parse.urljoin(m3u8, re.search(r'URI="([^"]+)"', ln).group(1)))

        def _grab(u):
            if seg_cache.has((u, vid)):
                return
            try:
                d, c, _ = upstream_fetch(th, u)
                seg_cache.put((u, vid), (c or "video/mp2t", d))
            except Exception:  # noqa: BLE001
                pass
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:
            list(ex.map(_grab, urls))

    def _buffer_worker():
        while True:
            video, m3u8 = buf_q.get()
            vid = str(video["videoId"])
            with buf_lock:
                buf_state[vid] = "working"
            try:
                _buffer_one(video, m3u8)
                with buf_lock:
                    buf_state[vid] = "done"
            except Exception:  # noqa: BLE001
                with buf_lock:
                    buf_state[vid] = "error"
            finally:
                buf_q.task_done()

    def start_buffer(video, m3u8):
        vid = str(video["videoId"])
        with buf_lock:
            if buf_state.get(vid) in ("queued", "working"):
                return
            buf_state[vid] = "queued"
        buf_q.put((video, m3u8))

    for _ in range(2):
        threading.Thread(target=_buffer_worker, daemon=True).start()

    # 整集后台预缓存：边看边把整节课下到磁盘缓存；切走的那节自动暂停
    pf_lock = threading.Lock()
    pf_active = {"vid": None}
    pf_threads = {}  # vid -> (thread, stop_event)

    def _prefetch_worker(vid, m3u8, stop):
        hdrs = video_headers.get(vid)
        if not hdrs:
            return
        try:
            data, _, _ = upstream_fetch(hdrs, m3u8)
        except Exception:  # noqa: BLE001
            return
        text = data.decode("utf-8", "replace")
        # 先把密钥缓存好
        for line in text.splitlines():
            if line.startswith("#EXT-X-KEY") and 'URI="' in line:
                kabs = urllib.parse.urljoin(m3u8, re.search(r'URI="([^"]+)"', line).group(1))
                if not seg_cache.has((kabs, vid)):
                    try:
                        kd, kc, _ = upstream_fetch(hdrs, kabs)
                        seg_cache.put((kabs, vid), (kc or "application/octet-stream", kd))
                    except Exception:  # noqa: BLE001
                        pass
        segs = [urllib.parse.urljoin(m3u8, ln.strip())
                for ln in text.splitlines() if ln.strip() and not ln.startswith("#")]
        seg_total[vid] = len(segs)
        for s in segs:
            if stop.is_set() or pf_active["vid"] != vid:
                return  # 被切走 -> 暂停（已缓存的保留，回来可续）
            if seg_cache.has((s, vid)):
                continue
            try:
                d, c, _ = upstream_fetch(hdrs, s)
                seg_cache.put((s, vid), (c or "video/mp2t", d))
            except Exception:  # noqa: BLE001
                pass

    def start_prefetch(vid, m3u8):
        with pf_lock:
            pf_active["vid"] = vid
            for ovid, (_, ev) in pf_threads.items():
                if ovid != vid:
                    ev.set()  # 暂停其它正在下的
            cur = pf_threads.get(vid)
            if cur and cur[0].is_alive():
                return
            ev = threading.Event()
            t = threading.Thread(target=_prefetch_worker, args=(vid, m3u8, ev), daemon=True)
            pf_threads[vid] = (t, ev)
            t.start()

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

        def _send_json(self, obj, status=200):
            self._send_bytes(status, json.dumps(obj, ensure_ascii=False).encode("utf-8"),
                             "application/json; charset=utf-8")

        def do_GET(self):
            parsed = urllib.parse.urlparse(self.path)
            path = parsed.path
            qs = urllib.parse.parse_qs(parsed.query)
            if path in ("/", "/index.html"):
                self._send_bytes(200, page.encode("utf-8"), "text/html; charset=utf-8")
            elif path in ("/hls.js", "/artplayer.js"):
                js = asset_bytes(path.lstrip("/"))
                self._send_bytes(200 if js else 502, js or b"// asset unavailable",
                                 "application/javascript; charset=utf-8")
            elif path == "/api/courses":
                self._api_courses()
            elif path == "/api/course":
                self._api_course(qs)
            elif path == "/api/play":
                self._api_play(qs)
            elif path == "/api/thumb":
                self._api_thumb(qs)
            elif path == "/api/thumbs/status":
                self._api_thumbs_status()
            elif path == "/api/status":
                self._api_status(qs)
            elif path.startswith("/thumbs/"):
                self._serve_thumb(path)
            elif path == "/p":
                self._proxy(qs)
            elif path == "/api/_debug":
                self._send_json({"active": pf_active["vid"],
                                 "cacheItems": len(seg_cache.meta),
                                 "cacheBytes": seg_cache.size})
            else:
                self._send_bytes(404, b"not found", "text/plain")

        def do_POST(self):
            parsed = urllib.parse.urlparse(self.path)
            if parsed.path == "/api/thumbs/batch":
                self._api_thumbs_batch()
            elif parsed.path == "/api/buffer/batch":
                self._api_buffer_batch()
            else:
                self._send_bytes(404, b"not found", "text/plain")

        def _read_json(self):
            length = int(self.headers.get("Content-Length") or 0)
            return json.loads(self.rfile.read(length).decode("utf-8"))

        def _buffer_video(self, d):
            """缓冲用：高清地址 src。返回 (video, m3u8) 或 None。"""
            try:
                video = {"videoId": int(d["videoId"]), "contentId": int(d["contentId"]),
                         "cardPackageId": int(d["cardPackageId"]), "productId": int(d["productId"])}
            except (KeyError, ValueError, TypeError):
                return None
            src = d.get("src") or ""
            if not (isinstance(src, str) and src.startswith("https://stream.youdao.com")):
                return None
            return video, src

        def _api_buffer_batch(self):
            try:
                payload = self._read_json()
            except Exception as e:  # noqa: BLE001
                self._send_json({"error": str(e)}, 400)
                return
            queued = skipped = 0
            for d in payload.get("videos") or []:
                bv = self._buffer_video(d)
                vid = str(d.get("videoId"))
                if not bv or buf_state.get(vid) in ("queued", "working", "done"):
                    skipped += 1
                    continue
                start_buffer(*bv)
                queued += 1
            self._send_json({"queued": queued, "skipped": skipped})

        def _api_status(self, qs):
            with thumb_lock:
                tstates = {k: v.get("state") for k, v in thumb_meta.items()}
            vids = qs.get("videoId") or []  # 可选：只查这些 vid 的缓冲明细
            buffer = {}
            for vid in (vids if vids else list(set(list(seg_total.keys()) + list(buf_state.keys())))):
                vid = str(vid)
                buffer[vid] = {"cached": seg_cache.count_vid(vid),
                               "total": seg_total.get(vid),
                               "state": buf_state.get(vid)}
            tready = sum(1 for s in tstates.values() if s == "ready")
            tgen = [k for k, s in tstates.items() if s == "gen"]
            terr = sum(1 for s in tstates.values() if s == "error")
            self._send_json({
                "thumb": {"states": tstates, "ready": tready, "generating": tgen,
                          "queued": thumb_q.qsize(), "errors": terr},
                "buffer": {"perVid": buffer, "bytes": seg_cache.size, "limit": seg_cache.max,
                           "queued": buf_q.qsize(),
                           "working": [k for k, s in buf_state.items() if s == "working"]},
                "ffmpeg": have_ffmpeg, "thumbDir": thumb_dir,
            })

        def _thumb_video(self, d):
            """从 dict 取出生成缩略图需要的字段，返回 (video, m3u8_low, duration) 或 None。"""
            try:
                video = {"videoId": int(d["videoId"]), "contentId": int(d["contentId"]),
                         "cardPackageId": int(d["cardPackageId"]), "productId": int(d["productId"])}
            except (KeyError, ValueError, TypeError):
                return None
            src = d.get("src") or ""
            if not (isinstance(src, str) and src.startswith("https://stream.youdao.com")):
                return None
            try:
                duration = int(float(d.get("duration") or 0))
            except (ValueError, TypeError):
                duration = 0
            return video, src, duration

        def _api_thumb(self, qs):
            vid = (qs.get("videoId") or [None])[0]
            if not vid:
                self._send_json({"state": "error", "reason": "no videoId"}, 400)
                return
            with thumb_lock:
                st = thumb_meta.get(vid)
            if st and st["state"] in ("ready", "gen", "error"):
                self._send_json(st)
                return
            parsed = {k: (v[0] if v else None) for k, v in qs.items()}
            tv = self._thumb_video(parsed)
            if not tv:
                self._send_json({"state": "error", "reason": "need ids+src"}, 400)
                return
            self._send_json(start_thumbs(*tv))

        def _api_thumbs_batch(self):
            try:
                length = int(self.headers.get("Content-Length") or 0)
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
            except Exception as e:  # noqa: BLE001
                self._send_json({"error": str(e)}, 400)
                return
            queued = skipped = 0
            for d in payload.get("videos") or []:
                with thumb_lock:
                    st = thumb_meta.get(str(d.get("videoId")))
                if st and st["state"] in ("ready", "gen"):
                    skipped += 1
                    continue
                tv = self._thumb_video(d)
                if tv:
                    start_thumbs(*tv)
                    queued += 1
                else:
                    skipped += 1
            self._send_json({"queued": queued, "skipped": skipped})

        def _api_thumbs_status(self):
            with thumb_lock:
                states = {k: v.get("state") for k, v in thumb_meta.items()}
            ready = [k for k, s in states.items() if s == "ready"]
            generating = [k for k, s in states.items() if s == "gen"]
            errored = [k for k, s in states.items() if s == "error"]
            nbytes = 0
            try:
                for n in os.listdir(thumb_dir):
                    if n.endswith(".jpg"):
                        nbytes += os.path.getsize(os.path.join(thumb_dir, n))
            except OSError:
                pass
            self._send_json({
                "states": states, "readyCount": len(ready),
                "generating": generating, "queued": thumb_q.qsize(),
                "errorCount": len(errored), "ffmpeg": have_ffmpeg,
                "dir": thumb_dir, "bytes": nbytes,
            })

        def _serve_thumb(self, path):
            name = os.path.basename(path)
            fpath = os.path.join(thumb_dir, name)
            if not os.path.isfile(fpath):
                self._send_bytes(404, b"not found", "text/plain")
                return
            with open(fpath, "rb") as f:
                self._send_bytes(200, f.read(), "image/jpeg",
                                 {"Cache-Control": "max-age=3600"})

        def _api_courses(self):
            try:
                prods = list_products(session)
            except Exception as e:  # noqa: BLE001
                self._send_json({"error": str(e)}, 502)
                return
            courses = [{
                "id": p.get("id"), "name": p.get("name"),
                "cardType": p.get("cardType"),
                "authors": [a.get("name") if isinstance(a, dict) else a
                            for a in (p.get("authors") or [])],
            } for p in prods]
            self._send_json({"courses": courses})

        def _api_course(self, qs):
            pid = (qs.get("productId") or [None])[0]
            if not pid:
                self._send_json({"error": "missing productId"}, 400)
                return
            try:
                self._send_json({"videos": get_product_videos(session, pid)})
            except Exception as e:  # noqa: BLE001
                self._send_json({"error": str(e)}, 502)

        def _api_play(self, qs):
            try:
                video = {
                    "videoId": int(qs["videoId"][0]),
                    "contentId": int(qs["contentId"][0]),
                    "cardPackageId": int(qs["cardPackageId"][0]),
                    "productId": int(qs["productId"][0]),
                }
            except (KeyError, ValueError):
                self._send_json({"error": "bad params"}, 400)
                return
            m3u8 = (qs.get("m3u8") or [None])[0] or resolve_m3u8(session, video)
            if not m3u8:
                self._send_json({"error": "no m3u8 (locked?)"}, 502)
                return
            vid = str(video["videoId"])
            hdrs = play_headers(session, video, m3u8)
            with vh_lock:
                video_headers[vid] = hdrs
            if prefetch:
                start_prefetch(vid, m3u8)  # 后台整集预缓存；切走会自动暂停
            self._send_json({"url": _proxify(m3u8, video["videoId"]), "m3u8": m3u8})

        def _fetch_upstream(self, target, vid, range_header=None):
            with vh_lock:
                hdrs = video_headers.get(vid, base_headers) if vid else base_headers
            return upstream_fetch(hdrs, target, range_header)

        def _proxy(self, qs):
            if "u" not in qs:
                self._send_bytes(400, b"missing u", "text/plain")
                return
            target = qs["u"][0]
            vid = (qs.get("vid") or [None])[0]

            # m3u8 播放列表：不缓存，取来改写
            if _looks_like_m3u8(target, ""):
                try:
                    data, _, _ = self._fetch_upstream(target, vid)
                except Exception as e:  # noqa: BLE001
                    self._send_bytes(502, str(e).encode("utf-8"), "text/plain")
                    return
                rewritten = rewrite_m3u8(data.decode("utf-8", "replace"), target, vid)
                self._send_bytes(200, rewritten.encode("utf-8"),
                                 "application/vnd.apple.mpegurl")
                return

            # 分片 / 密钥：整段缓存，拖动到看过的位置秒开；并支持 Range（Safari 原生拖动）
            ck = (target, vid)
            cached = seg_cache.get(ck)
            if cached is None:
                try:
                    data, ctype, _ = self._fetch_upstream(target, vid)
                except urllib.error.HTTPError as e:
                    self._send_bytes(e.code, e.read() or b"",
                                     e.headers.get("Content-Type", "text/plain"))
                    return
                except Exception as e:  # noqa: BLE001
                    self._send_bytes(502, str(e).encode("utf-8"), "text/plain")
                    return
                ctype = ctype or "application/octet-stream"
                seg_cache.put(ck, (ctype, data))
            else:
                ctype, data = cached

            self._serve_blob(data, ctype, self.headers.get("Range"))

        def _serve_blob(self, data, ctype, range_header):
            total = len(data)
            rng = _parse_range(range_header, total)
            if rng is None:
                self._send_bytes(200, data, ctype, {"Accept-Ranges": "bytes"})
                return
            start, end = rng
            self._send_bytes(206, data[start:end + 1], ctype, {
                "Accept-Ranges": "bytes",
                "Content-Range": "bytes %d-%d/%d" % (start, end, total),
            })

    return Handler


class _QuietServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def handle_error(self, request, client_address):
        # 播放器/ffmpeg 提前断开连接很正常，不刷栈
        if sys.exc_info()[0] in (ConnectionResetError, BrokenPipeError):
            return
        super().handle_error(request, client_address)


def start_proxy(headers, port, default_url="", session=None, auto=None,
                prefetch=True, cache_bytes=SEG_CACHE_BYTES):
    server = _QuietServer(("127.0.0.1", port),
                          make_handler(headers, default_url, session, auto,
                                       prefetch, cache_bytes, port))
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


def api_get_json(session, url, retries=3):
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=api_headers(session))
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:  # noqa: BLE001  (上游偶发抖动，退避重试)
            last = e
            time.sleep(0.6 * (attempt + 1))
    raise last


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
            "cardPackageId": v.get("cardPackageId") or pkg_id,
            "productId": v.get("productId") or product_id,
            "title": v.get("title"),
            "downloadUrl": v.get("downloadUrl"),
            "clarity": v.get("clarityInfoList") or [],
            "locked": not v.get("downloadUrl"),
            "module": (v.get("moduleInfo") or {}).get("title"),
            "topic": (v.get("topicInfo") or {}).get("title"),
            "examKey": (v.get("examKeyInfo") or {}).get("title"),
            "duration": v.get("duration"),
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


def _pick_clarity(clist, quality="highest"):
    clist = [c for c in (clist or []) if c.get("url")]
    if not clist:
        return None
    clist = sorted(clist, key=lambda c: c.get("type", 0),
                   reverse=(quality == "highest"))
    return clist[0]["url"]


def resolve_m3u8(session, video, quality="highest"):
    """拿到视频的 m3u8 地址；优先用树里自带的 clarityInfoList，再回退 downloadUrl / outline 接口。"""
    url = _pick_clarity(video.get("clarity"), quality)
    if url:
        return url
    if video.get("downloadUrl"):
        return video["downloadUrl"]
    try:
        api = API_VIDEO_OUTLINE % (video["videoId"], video["cardPackageId"],
                                   video["contentId"], video["productId"])
        infos = (api_get_json(session, api).get("data") or {}).get("videoInfos") or []
        for vi in infos:
            url = _pick_clarity(vi.get("clarityInfoList"), quality)
            if url:
                return url
    except Exception:  # noqa: BLE001
        pass
    return None


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
    _, session = load_session(args)
    auto = None
    if getattr(args, "video", None):
        print("正在定位 videoId=%s 以便自动播放……" % args.video)
        v = find_video(session, args.video)
        if v:
            auto = {"productId": v["productId"], "videoId": v["videoId"]}
        else:
            print("没找到该 videoId，将正常打开课程列表。")
    prefetch = not args.no_prefetch
    server = start_proxy(session, args.port, "", session, auto,
                         prefetch, args.cache_mb * 1024 * 1024)
    print("课程网页已启动： http://127.0.0.1:%d" % args.port)
    print("左侧选课、选讲即可播放，支持搜索 / 倍速 / 上下一讲。Ctrl-C 退出。")
    if prefetch:
        print("整集预缓存：已开（边看边下整节课，切走自动暂停；缓存上限 %d MB）" % args.cache_mb)
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
    sp.add_argument("--video", "-V", help="打开时自动播放的 videoId（用 list 查到）。")
    sp.add_argument("--no-prefetch", action="store_true",
                    help="关闭整集后台预缓存（默认开启：边看边下整节课，切走自动暂停）。")
    sp.add_argument("--cache-mb", type=int, default=3072,
                    help="磁盘分片缓存上限 MB（默认 3072）。")
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
