#!/usr/bin/env bash
# 一键启动（生产）：Python 解密网关 + Next.js 主后端。
#   网关  -> 127.0.0.1:8808（仅本机；浏览器不直连，Next 服务端调用 + /p,/thumbs rewrite）
#   Next  -> 0.0.0.0:3000（对局域网；应用 API + UI，SQLite 持久化）
# 用法：./run.sh      （首次会自动构建；需要 req.txt 与 web/.env）
#
# 监督模式：任一子进程退出就单独把它拉起来，直到收到 INT/TERM 才整体停。
# 关键：网关挂掉时 web 不再被连带杀掉——页面仍可访问并显示「网关离线」(HealthBar +
# courses/status 的 DB 回退)，且网关 ~2-4s 自动重启自愈。停止：kill -TERM 本 run.sh 进程。
set -uo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

[ -f req.txt ] || { echo "✗ 缺 req.txt（抓包的 .m3u8 请求原文），放到 $ROOT/req.txt 再启动"; exit 1; }
command -v python3 >/dev/null || { echo "✗ 需要 python3"; exit 1; }
[ -f web/.env ] || { echo "✗ 缺 web/.env（复制 web/.env.example 并填 DATABASE_URL）"; exit 1; }

PORT="${PORT:-3000}"; HOST="${HOST:-0.0.0.0}"
GATE=""; NEXT=""; STOP=0

start_gate() { python3 youdao_course.py serve -r req.txt & GATE=$!; echo "✓ gateway pid=${GATE}"; }
start_next() { ( cd web && exec npx next start -H "$HOST" -p "$PORT" ) & NEXT=$!; echo "✓ next pid=${NEXT}"; }

# 一次性：迁移 + 必要时构建（子进程自动重启时不重复构建）。
( cd web && npx prisma migrate deploy >/dev/null )
if [ ! -f web/.next/BUILD_ID ] || [ -n "$(cd web && find src prisma package.json next.config.ts -newer .next/BUILD_ID 2>/dev/null | head -n1)" ]; then
  [ -f web/.next/BUILD_ID ] && echo "源码有更新，重新构建中…" || echo "首次构建中…"
  ( cd web && npm run build )
fi

start_gate
start_next
echo "✓ open http://${HOST}:${PORT}  (LAN: <your-ip>:${PORT})"

# 收到停止信号：标记 STOP 并杀两个子进程；监督循环随即退出，不再重启。
trap 'STOP=1; echo; echo "停止…"; kill "$GATE" "$NEXT" 2>/dev/null || true' INT TERM

# 监督循环（bash 3.2 没有 wait -n，用轮询）。
while [ "$STOP" = "0" ]; do
  if ! kill -0 "$GATE" 2>/dev/null && [ "$STOP" = "0" ]; then
    echo "⚠ 网关退出，2s 后自动重启（web 不受影响，期间显示「网关离线」）…"
    sleep 2
    [ "$STOP" = "0" ] && start_gate
  fi
  if ! kill -0 "$NEXT" 2>/dev/null && [ "$STOP" = "0" ]; then
    echo "⚠ next 退出，自动重启…"
    [ "$STOP" = "0" ] && start_next
  fi
  sleep 2
done

kill "$GATE" "$NEXT" 2>/dev/null || true
wait 2>/dev/null || true
