# julestest — 有道课程播放器

局域网自用的有道课程播放器：解密有道加密 HLS，浏览器/手机/平板在线看，
进度·笔记·缓存等状态全部服务端保管、跨设备共享。

## 架构（两进程）

```
浏览器 ──/api/*──────────────▶ Next.js 主后端 (Node, :3000)  ──┐
       └─/p,/thumbs (rewrite)──▶ Python 网关 (:8808) ◀─内部调用─┘
```

- **Next.js 主后端（`web/`）**：App Router route handlers + Prisma/SQLite。拥有全部应用状态——
  课程目录（从网关同步后入库，**不再每次打有道**）、观看进度、时间戳笔记、偏好、缓存/缩略图状态。
  浏览器只跟它同源通信。DB 在 `~/.youdao_course/app.db`。
- **Python 网关（`youdao_course.py`）**：保留“有道网络 + 解密”层——会话(`req.txt`)、原始有道读
  （课程/视频/m3u8 解析）、HLS 解密代理 `/p` + AES key、分片磁盘缓存（三档优先级 + 持久化）、
  ffmpeg 缩略图。仅监听 `127.0.0.1`。媒体字节经 Next 的 rewrite 透传（支持 Range/206）。

状态/缓存均落在 `~/.youdao_course/`（`app.db`、`cache/`、`thumbs/`），重启不丢。

## 运行

前置：Node ≥ 22、Python 3、`ffmpeg`（缩略图/下载用）、抓包得到的 `req.txt` 放在仓库根。

```bash
cd web && cp .env.example .env   # 填 DATABASE_URL（默认 ~/.youdao_course/app.db），首次
cd web && npm install            # 首次
./run.sh                         # 一键起网关 + Next（首次自动构建）
```

打开 `http://<本机IP>:3000`。会话过期（`req.txt` 失效）时，重抓一条覆盖 `req.txt`，
页面顶部「刷新目录」即可。

开发模式：`python3 youdao_course.py serve -r req.txt` 与 `cd web && npm run dev` 分别起。

## 仓库

- `youdao_course.py` — Python 解密网关（含三档缓存优先级、持久化缓存、缩略图）。
- `web/` — Next.js 主后端 + UI（route handlers、Prisma schema/migrations、组件）。
- `run.sh` — 一键启动两进程。

仅用于观看你自己已购买/有权访问的课程，请遵守平台条款。
