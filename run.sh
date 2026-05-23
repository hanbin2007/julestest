#!/usr/bin/env bash
# 一键启动（生产）：Python 解密网关 + Next.js 主后端。
#   网关  -> 127.0.0.1:8808（仅本机；浏览器不直连，Next 服务端调用 + /p,/thumbs rewrite）
#   Next  -> 0.0.0.0:3000（对局域网；应用 API + UI，SQLite 持久化）
# 用法：./run.sh      （首次会自动构建；需要 req.txt 与 web/.env）
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

[ -f req.txt ] || { echo "✗ 缺 req.txt（抓包的 .m3u8 请求原文），放到 $ROOT/req.txt 再启动"; exit 1; }
command -v python3 >/dev/null || { echo "✗ 需要 python3"; exit 1; }
[ -f web/.env ] || { echo "✗ 缺 web/.env（复制 web/.env.example 并填 DATABASE_URL）"; exit 1; }

PORT="${PORT:-3000}"; HOST="${HOST:-0.0.0.0}"

# 1) 解密网关
python3 youdao_course.py serve -r req.txt &
GATE=$!

# 2) Next：迁移 + 首次构建 + 启动
cd web
npx prisma migrate deploy >/dev/null
[ -f .next/BUILD_ID ] || { echo "首次构建中…"; npm run build; }
npx next start -H "$HOST" -p "$PORT" &
NEXT=$!

echo "✓ gateway pid=${GATE}  next pid=${NEXT}"
echo "✓ open http://${HOST}:${PORT}  (LAN: <your-ip>:${PORT})"
trap 'echo; echo "停止…"; kill "$GATE" "$NEXT" 2>/dev/null || true' INT TERM EXIT
wait
