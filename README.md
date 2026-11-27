# NestKB · 企业知识库 AI 问答助手

> 上传制度文档 → 异步摄取（解析 / 结构感知分块 / 向量化）→ 混合检索（pgvector + FTS + RRF + rerank）→ SSE 流式回答并附 `[n]` 引用 → Token 计量落库 → 反馈与评估闭环。
>
> 权限过滤是检索 SQL 的第一个 `WHERE` 条件：越权文档从不进入候选集，而不是靠 prompt 提醒模型别看。

## 快速开始

前置：Node 24+、pnpm 11+、PostgreSQL 16+（含 `pgvector` / `pg_trgm`）、Redis 7。也可以只装 Docker，用 `docker/docker-compose.dev.yml` 起依赖。

```bash
pnpm install
cp .env.example .env             # 默认 LLM provider = mock，不需要 API key
pnpm migrate                     # 建表 + 扩展 + HNSW/GIN 索引
pnpm seed                        # 两部门四账号 + 评测集
pnpm dev                         # 同时起 api(:3000) + worker + web(:5173)
```

另开一个终端灌入示例语料并自检：

```bash
pnpm seed:docs                   # 6 篇制度文档，等 worker 摄取 ready
pnpm doctor                      # 检查 pg / 扩展 / redis / LLM 三通路 / embedding 维度
```

浏览器打开 <http://localhost:5173>；生产构建由 API 同源托管，入口为 <http://localhost:3000/kb>。

seed 账号（密码统一 `Passw0rd!123`）：

| 账号 | 角色 | 部门 |
| --- | --- | --- |
| `admin@nestkb.local` | admin | — |
| `alice@a-dept.com` | member | 研发部 |
| `bob@b-dept.com` / `carol@b-dept.com` | member | 人事部 |

## 它能做什么

- **员工**：上传 MD/PDF/DOCX、查看摄取进度与版本历史、提问获得带引用的流式回答、点赞点踩并选原因。
- **管理员**：成本看板（部门/用户/天/场景）、检索调试（双路分数 / RRF / rerank / 分段延迟）、评估回归、文档过期与白名单授权、队列重放。
- **三态空召回**：没有可见文档 / 有相似内容但无权限 / 真的没依据 —— 分别给出不同回答，不混为一谈。

## 项目结构

```text
apps/web           React SPA：问答 / 文档管理 / 管理端三页（懒加载）
apps/api           HTTP 进程（Fastify + SSE）：auth / documents / qa / feedback / admin / eval / metering
apps/worker        摄取进程（BullMQ，无 HTTP）：解析 → 分块 → embedding → 入库
libs/llm           chat / embedding / rerank 三通路门面，provider 配置化
libs/vector-store  pgvector + 权限 WHERE + 混合检索 RRF + rerank 超时降级
libs/chunker       结构感知分块：标题栈 → 表格整块 → 超长递归下切
libs/prompts       版本化 prompt / 引用校验 / 注入护栏 / eval judge
libs/contracts     队列 job / SSE 事件 / 共享 DTO / 策略常量（零依赖）
libs/common        zod 环境校验 / TraceId / 统一响应与异常 / Redis
prisma             schema + 迁移 SQL（vector/tsv 列与 HNSW/GIN 索引手工维护）
eval/              评测集版本化 + run-eval 六元组落库
scripts/           seed / seed-docs / doctor / deploy / loadtest
```

视觉规范见 `DESIGN.md`，产品边界见 `PRODUCT.md`。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `pnpm dev` | 启动 api + worker + web（开发模式） |
| `pnpm build` / `pnpm build:web` | 构建后端 / 前端 |
| `pnpm start:api` / `pnpm start:worker` | 运行构建产物 |
| `pnpm migrate` / `pnpm deploy:migrate` | 开发迁移 / 生产迁移 |
| `pnpm seed` / `pnpm seed:docs` | 初始化账号与评测集 / 灌入示例语料 |
| `pnpm doctor` | 环境与模型连通性自检 |
| `pnpm test` / `pnpm test:watch` | 单元测试（110 个用例） |
| `pnpm test:e2e` | E2E（真实 PG + Redis + mock LLM，19 个用例） |
| `pnpm eval` | 评估回归，结果写入 `eval_runs` |

## 配置

### 生产必改

| 变量 | 说明 |
| --- | --- |
| `JWT_SECRET` | 至少 32 字节随机值 |
| `PRICE_JSON` | 元/百万 token 的价格表，成本看板与预算闸的唯一依据 |
| `LLM_CHAT_*` / `LLM_EMBEDDING_*` / `LLM_RERANK_*` | 三个通路真实模型配置 |
| `MAX_UPLOAD_MB` | 默认 20，2G 机器建议 10；multipart 与业务校验共用此值 |
| `LLM_ALLOW_MOCK_IN_PROD` | 默认 `false`，见下方「生产禁桩」 |

### 接入真实模型

```bash
LLM_CHAT_PROVIDER=openai-compat
LLM_CHAT_BASE_URL=https://api.example-llm.com/v1
LLM_CHAT_API_KEY=sk-xxx
LLM_CHAT_MODEL=your-chat-model        # 事实问答建议低温 0.2、支持流式
LLM_EMBEDDING_PROVIDER=openai-compat  # bge-m3(1024 维) 可走 ollama 的 /v1 端点
```

`pnpm doctor` 会打印 embedding 探针维度，**必须与 `EMBEDDING_DIM` 一致**；维度错会导致入库数据不可用。换 embedding 模型需全量重嵌并跑评估对比，再用 `document_chunks.embedding_model` 区分灰度。

### 生产禁桩

`NODE_ENV=production` 下任一 `LLM_*_PROVIDER=mock` 会直接启动失败并指出未配置的通路 —— mock 回答是模板拼接、成本恒为 0，看起来能跑但不代表真实效果。离线演示需显式设 `LLM_ALLOW_MOCK_IN_PROD=true`。

## API 速览

| 域 | 接口 |
| --- | --- |
| 认证 | `POST /auth/login`、`POST /auth/refresh`、`GET /auth/me` |
| 文档 | `POST /documents`（multipart）、`GET /documents`、`GET /documents/:id`、`GET /documents/:id/ingestion`、`POST /documents/:id/versions`、`POST /documents/:id/reingest`、`DELETE /documents/:id` |
| 问答 | `POST /qa/conversations`、`GET /qa/conversations/:id`、`POST /qa/conversations/:id/messages`（SSE）、`POST /messages/:id/feedback` |
| 管理 | `GET /admin/usage/summary`、`GET /admin/retrieval/debug`、`GET /admin/queues`、`POST /admin/eval/runs`、`POST /admin/eval/cases/import`、`POST /admin/documents/:id/expire`、`POST /admin/documents/:id/grants`、`POST /admin/departments/:id/quota` |
| 运维 | `GET /health`（公开） |

SSE 事件顺序固定：`meta → delta* → citations → usage → done`；`error` 之后流终止。常见错误码：`NO_EVIDENCE`（真无依据）、`PERMISSION_FILTERED`（有相似内容但无权限）、`QUOTA_EXCEEDED`（部门月配额耗尽，降级只读检索）、`RATE_LIMITED`、`INJECTION_BLOCKED`、`UPSTREAM_ERROR`（可重试）。响应头 `x-rerank-degraded: true` 表示 rerank 超时降级为 RRF 粗排。

## 验证与评估

```bash
pnpm test        # 单元：编排 / 计量 / 权限矩阵 / SSE 生命周期 / 检索 SQL / 策略常量
pnpm test:e2e    # 全链路：摄取 → 问答 → 越权矩阵 → 拒答 → 注入 → 损坏文档 → 点踩回流
pnpm eval        # Recall@5 / 忠实度 / 引用准确率 / 相关性 / 成本 / 延迟
```

- 评测集 `eval/datasets/eval-set.v1.json` 独立版本化；prompt 迭代期间不要改它（防过拟合）。点踩回流以 `source=feedback` 入池。
- mock provider 下的评估绝对值不代表真实模型基线（mock embedding 是字符 bigram 哈希、mock judge 是词面覆盖率）。**接真实模型后重跑 `pnpm eval` 才是有效基线**。
- CI（`.github/workflows/ci.yml`）：类型检查 → 迁移 → 单测 → E2E（真实 pgvector + Redis service 容器）→ 构建 → 评估回归；main 通过后才构建并推送 GHCR 镜像。

## 部署

**2 核 2G**：`bash scripts/deploy.sh` —— 一键装 Docker、生成 `.env.prod`、登录 GHCR 拉镜像、启动、seed、doctor；上传限 10MB，不在小机器上构建镜像。

**2 核 4G**：

```bash
docker compose -f docker/docker-compose.prod.yml up -d --build
# 内存分配：PG 1g / api 768m / worker 768m（含堆封顶）
```

容器启动后初始化（2G 脚本已自动完成）：

```bash
docker compose -f docker/docker-compose.prod.yml exec api npx ts-node -r tsconfig-paths/register --transpile-only scripts/seed.ts
docker compose -f docker/docker-compose.prod.yml exec api npx ts-node -r tsconfig-paths/register --transpile-only scripts/seed-docs.ts
```

上线自检：`curl http://<host>:3000/health` 返回实际生效的 `providers.{chat,embedding,rerank}`、最近一次迁移与镜像版本；`status=degraded` 且 HTTP 503 表示数据库不可达。容器 healthcheck 也指向该端点，`mockInUse=true` 表示桩模型在用。

压测脚本：`node scripts/loadtest.js --url http://127.0.0.1:5050 --users 50 --duration 20`（多账号轮换 + 真实节奏；预扣配额按设计会串行化单用户并发）。

## 关键设计决定

| 决定 | 原因 |
| --- | --- |
| 权限过滤在检索层 SQL（`accessWhereSql`），不在 prompt 提醒 | RAG 生产失败首位是权限泄漏；越权数据从不进入候选集 |
| 混合检索 + RRF + rerank，超时 800ms 打标降级 | 单路向量在规模下退化；rerank 是增强不是依赖 |
| 引用溯源为一等功能：chunkId + 版本 + 章节 + 原文，校验器剔除幻觉编号 | 用户无法验证出处等于信任崩塌 |
| 摄取幂等键 = versionId（jobId 去重 + hasVersion 双保险），先删后写单事务 | 重复投递零副作用；防新旧版本混检 |
| Redis 预扣 → API usage 唯一计费结算 → 异常路径兜底释放 → 部分结算回冲 | 成本归因不清是 RAG 六大失败之一；预扣键不能被钉住 |
| 评测集独立版本化，prompt/模型变更必跑回归（`eval_runs` 账本） | 上线即冻结、效果缓慢腐烂 |
| 摄取走独立 Worker 进程，不拆微服务 | 队列工程；部署形态保持单体 + worker |

## 更多文档

- [PRODUCT.md](PRODUCT.md) —— 产品定位、用户与能力边界
- [DESIGN.md](DESIGN.md) —— 前端视觉世界与组件语言
- [docs/失败模式与对策.md](docs/失败模式与对策.md) —— RAG 六类失败逐条对应的防御手段
