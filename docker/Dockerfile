# NestKB 生产镜像：多阶段构建（web 前端 + api/worker 后端）
# 构建上下文 = 仓库根目录：docker build -f docker/Dockerfile .
FROM node:24-alpine AS base
RUN corepack enable && corepack prepare pnpm@11 --activate
WORKDIR /app

# ── 依赖层：完整安装（含 devDeps，供构建）；以 manifests 为缓存键，依赖变更才重跑 ──
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# 根 postinstall 会跑 prisma generate，schema 必须先就位
COPY prisma ./prisma
RUN pnpm install --frozen-lockfile
# 不用 pnpm fetch + --offline：v10+ 的 fetch 元数据镜像不完整，离线解析必炸 ERR_PNPM_NO_OFFLINE_META

# ── 构建层：prisma generate + web + api/worker ──
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig*.json nest-cli.json ./
COPY prisma ./prisma
COPY libs ./libs
COPY apps ./apps
COPY eval ./eval
RUN npx prisma generate \
 && pnpm build \
 && pnpm build:web

# ── 生产依赖层：仅 dependencies（prisma CLI / tsconfig-paths 已移入 dependencies）+ 客户端生成 ──
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY prisma ./prisma
RUN pnpm install --frozen-lockfile --prod

# ── 运行层：仅产物 + 生产依赖，非 root 运行 ──
FROM node:24-alpine AS runtime
RUN apk add --no-cache tini
WORKDIR /app
ENV NODE_ENV=production

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/scripts ./scripts
COPY docker/docker-entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh \
 && addgroup -S app && adduser -S app -G app \
 && mkdir -p storage/uploads /data/uploads \
 && chown -R app:app /app /data

USER app
EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["./entrypoint.sh", "api"]
