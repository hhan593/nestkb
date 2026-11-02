#!/bin/sh
# 容器入口：api 先迁移再启动；worker 直接启动
set -e
ROLE="${1:-api}"

if [ "$ROLE" = "api" ]; then
  echo "[entrypoint] applying migrations..."
  npx prisma migrate deploy
  echo "[entrypoint] starting api"
  exec node -r ./scripts/runtime-paths.js dist/apps/api/apps/api/src/main.js
fi

if [ "$ROLE" = "worker" ]; then
  echo "[entrypoint] starting worker"
  exec node -r ./scripts/runtime-paths.js dist/apps/worker/apps/worker/src/main.js
fi

echo "unknown role: $ROLE (use api|worker)" >&2
exit 1
