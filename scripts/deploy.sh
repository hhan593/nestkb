#!/usr/bin/env bash
# NestKB 2核2G 服务器一键部署脚本（在服务器上以 root 运行）
# 用法：把仓库 clone 到服务器后  bash scripts/deploy.sh
# 可选环境变量：DOMAIN=kb.example.com（配 HTTPS 反代时用）、GHCR_USER、GHCR_PAT（GHCR 包为私有时需要）
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/hhan593/nestkb}"
APP_DIR="${APP_DIR:-/opt/nestkb}"
COMPOSE="docker compose -f docker/docker-compose.prod-2g.yml --env-file /opt/nestkb/.env.prod"
GHCR_IMAGE="ghcr.io/hhan593/nestkb:latest"

log() { printf '\n\033[1;31m[deploy]\033[0m %s\n' "$*"; }

# ── 1. 基础检查 ──
log "检查系统资源"
MEM_KB=$(grep MemTotal /proc/meminfo | awk '{print $2}')
[ "${MEM_KB:-0}" -lt 1700000 ] && log "警告：内存不足 1.7G，容器将无法全部启动" || true
SWAP_KB=$(grep SwapTotal /proc/meminfo | awk '{print $2}')
[ "${SWAP_KB:-0}" -lt 1000000 ] && log "建议添加 swap（fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile）" || true

if ! command -v docker >/dev/null; then
  log "安装 Docker"
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null || { echo "docker compose 插件缺失"; exit 1; }

# ── 2. 拉代码 ──
if [ ! -d "$APP_DIR/.git" ]; then
  log "克隆仓库到 $APP_DIR"
  git clone "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"
git pull --ff-only

# ── 3. 生成 .env.prod（已存在则跳过，保留既有密钥）──
if [ ! -f .env.prod ]; then
  log "生成 .env.prod（JWT_SECRET / POSTGRES_PASSWORD 自动随机；模型 key 可留空先用 mock，之后编辑补上）"
  cat > .env.prod <<ENV
JWT_SECRET=$(openssl rand -hex 32)
POSTGRES_PASSWORD=$(openssl rand -hex 16)
LLM_CHAT_PROVIDER=${LLM_CHAT_PROVIDER:-mock}
LLM_CHAT_BASE_URL=${LLM_CHAT_BASE_URL:-}
LLM_CHAT_API_KEY=${LLM_CHAT_API_KEY:-}
LLM_CHAT_MODEL=${LLM_CHAT_MODEL:-mock-chat}
LLM_CHAT_TEMPERATURE=0.2
LLM_EMBEDDING_PROVIDER=${LLM_EMBEDDING_PROVIDER:-mock}
LLM_EMBEDDING_BASE_URL=${LLM_EMBEDDING_BASE_URL:-}
LLM_EMBEDDING_API_KEY=${LLM_EMBEDDING_API_KEY:-}
LLM_EMBEDDING_MODEL=${LLM_EMBEDDING_MODEL:-mock-embedding}
LLM_RERANK_PROVIDER=${LLM_RERANK_PROVIDER:-mock}
LLM_RERANK_BASE_URL=${LLM_RERANK_BASE_URL:-}
LLM_RERANK_API_KEY=${LLM_RERANK_API_KEY:-}
LLM_RERANK_MODEL=${LLM_RERANK_MODEL:-mock-reranker}
PRICE_JSON=${PRICE_JSON:-{}}
ENV
  chmod 600 .env.prod
  log ".env.prod 已生成 —— 接真实模型：编辑本文件补 LLM_* 三通路 key 与 PRICE_JSON，然后重新执行本脚本"
fi

# ── 4. GHCR 登录（包默认私有，需要 PAT with read:packages）──
if ! docker pull "$GHCR_IMAGE" >/dev/null 2>&1; then
  log "GHCR 拉取失败（包为私有）：输入 GitHub 用户名与 PAT（read:packages 权限）登录一次"
  read -rp "GitHub 用户名: " GHCR_USER
  read -rsp "PAT: " GHCR_PAT; echo
  echo "$GHCR_PAT" | docker login ghcr.io -u "$GHCR_USER" --password-stdin
fi

# ── 5. 拉镜像并启动 ──
log "拉取镜像并启动"
$COMPOSE pull
$COMPOSE up -d

# ── 6. 等 api 就绪后初始化数据 ──
log "等待 api 健康检查通过"
for i in $(seq 1 30); do
  $COMPOSE ps --format json api | grep -q '"Health":"healthy"' && break
  [ "$i" = 30 ] && { echo "api 未就绪，查日志：$COMPOSE logs api"; exit 1; }
  sleep 5
done

log "初始化账号/评测集/语料"
$COMPOSE exec -T api npx ts-node -r tsconfig-paths/register --transpile-only scripts/seed.ts
$COMPOSE exec -T api npx ts-node -r tsconfig-paths/register --transpile-only scripts/seed-docs.ts
$COMPOSE exec -T api npx ts-node -r tsconfig-paths/register --transpile-only scripts/doctor.ts

IP=$(curl -s ifconfig.me || echo 服务器IP)
log "完成！界面：http://${IP}:3000/kb  （账号见 seed 输出，密码 Passw0rd!123，登录后请改密）"
[ -n "${DOMAIN:-}" ] && log "已指定 DOMAIN=$DOMAIN —— 把域名 A 记录指到 $IP 并放行 80/443，反代配置见 README"
