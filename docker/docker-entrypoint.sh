#!/bin/sh
# 容器入口：api 先迁移再启动；worker 直接启动
set -e
ROLE="${1:-api}"

# 弱密钥 fail-fast：绝不带公开默认值启动生产进程
if [ -z "$JWT_SECRET" ] || [ "${#JWT_SECRET}" -lt 16 ] || [ "$JWT_SECRET" = "change-me-to-32-bytes-random-value!" ]; then
  echo "[entrypoint] JWT_SECRET 未设置、过短或为弱默认值，拒绝启动" >&2
  exit 1
fi

if [ "$ROLE" = "api" ]; then
  echo "[entrypoint] applying migrations..."
  ./node_modules/.bin/prisma migrate deploy
  echo "[entrypoint] starting api"
  exec node -r ./scripts/runtime-paths.js dist/apps/api/apps/api/src/main.js
fi

if [ "$ROLE" = "worker" ]; then
  echo "[entrypoint] starting worker"
  exec node -r ./scripts/runtime-paths.js dist/apps/worker/apps/worker/src/main.js
fi

echo "unknown role: $ROLE (use api|worker)" >&2
exit 1
