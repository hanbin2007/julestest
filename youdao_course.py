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
import logging
import os
import signal
import subprocess
import sys
import time
import urllib.parse

from ydcore.appconfig import resolve_cache_dir
from ydcore.gateway import start_proxy
from ydcore.hls import looks_like_m3u8 as _looks_like_m3u8
from ydcore.httpio import parse_request
from ydcore.util import which as _which
from ydcore.youdao_api import (
    find_video, get_product_videos, list_products, play_headers, resolve_m3u8,
)


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
    # 让 kill(SIGTERM) 也走 KeyboardInterrupt 优雅退出路径，从而触发 index 落盘。
    signal.signal(signal.SIGTERM, signal.default_int_handler)
    cache_dir, cache_dir_ok = resolve_cache_dir(args.cache_dir)
    server = start_proxy(session, args.port, "", session, auto,
                         prefetch, args.cache_mb * 1024 * 1024, cache_dir)
    print("课程网页已启动： http://127.0.0.1:%d" % args.port)
    print("左侧选课、选讲即可播放，支持搜索 / 倍速 / 上下一讲。Ctrl-C 退出。")
    if cache_dir_ok:
        print("缓存持久化目录：%s（重启不清，上限 %d MB，到顶按 LRU 淘汰）"
              % (cache_dir, args.cache_mb))
    else:
        print("⚠ 缓存目录不可用：%s —— 缓存已停用，请在网页「设置」中修正后重启网关。"
              % cache_dir)
    if prefetch:
        print("后台预缓存：已开（以播放头为中心前后双向补片，给观看让路）")
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        # 正常退出 -> atexit 触发 _DiskLRU._save_index 落盘（kill 已被路由到这里）。
        print("\n正在保存缓存索引并退出……")
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


def build_parser():
    p = argparse.ArgumentParser(
        description="把有道听课客户端抓到的加密 HLS 流，变成浏览器/任意播放器能看的视频。")
    sub = p.add_subparsers(dest="cmd", required=True)

    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--request", "-r",
                        help="抓包复制出来的请求原文文件（含 .m3u8 那条）。不传则从 stdin 读。")
    common.add_argument("--port", type=int, default=8808, help="本地代理端口（默认 8808）。")
    common.add_argument("--log-level", default=os.environ.get("YDCOURSE_LOG_LEVEL", "INFO"),
                        help="日志级别 DEBUG/INFO/WARNING/ERROR（默认 INFO；也可用环境变量 "
                             "YDCOURSE_LOG_LEVEL）。DEBUG 会打印逐片预取等细节。")

    lp = sub.add_parser("list", parents=[common],
                        help="列出所有已购课程和视频（只需会话 Cookie）。")
    lp.set_defaults(func=cmd_list)

    sp = sub.add_parser("serve", parents=[common], help="起本地代理 + 网页播放器，浏览器在线看。")
    sp.add_argument("--video", "-V", help="打开时自动播放的 videoId（用 list 查到）。")
    sp.add_argument("--no-prefetch", action="store_true",
                    help="关闭整集后台预缓存（默认开启：边看边下整节课，切走自动暂停）。")
    sp.add_argument("--cache-mb", type=int, default=5120,
                    help="磁盘分片缓存上限 MB（默认 5120≈5G，到顶才按 LRU 淘汰）。")
    sp.add_argument("--cache-dir", default=None,
                    help="缓存持久化目录（一次性覆盖，不写回配置；缺省读 config.json，"
                         "再退回 ~/.youdao_course/cache）。常驻设置请在网页「设置」里改。")
    sp.set_defaults(func=cmd_serve)

    dp = sub.add_parser("download", parents=[common], help="下载并合并成 mp4（需要 ffmpeg）。")
    dp.add_argument("--video", "-V", help="要下载的 videoId（用 list 查到）。")
    dp.add_argument("--url", "-u", help="要下载的 m3u8 地址；不传则用 --video 或原文里那条。")
    dp.add_argument("--output", "-o", default="output.mp4", help="输出文件名（默认 output.mp4）。")
    dp.set_defaults(func=cmd_download)

    pp = sub.add_parser("parse", parents=[common], help="只解析并打印抓到的地址和头（排错用）。")
    pp.set_defaults(func=cmd_parse)

    return p


def _setup_logging(level):
    logging.basicConfig(
        level=getattr(logging, str(level).upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )


def main():
    args = build_parser().parse_args()
    _setup_logging(getattr(args, "log_level", "INFO"))
    args.func(args)


if __name__ == "__main__":
    main()
