# NestKB —— 企业知识库 AI 问答助手（RAG 全链路工程化）

基于《计划书三：企业知识库 AI 问答助手（NestKB）》的完整实现。

**一句话成品形态**：员工上传文档 → 异步摄取（解析/结构感知分块/向量化）→ 混合检索（pgvector + FTS + RRF + rerank）→ SSE 流式回答带 `[1][2]` 引用 → Token 计量落库 → 反馈与评估闭环。权限按部门/文档隔离，**权限过滤是检索层 SQL 的第一个 WHERE 条件**。

## 前端界面（React SPA）

`apps/web`：Vite + React 19 + TypeScript。登录 → 知识库问答（SSE 流式 + 引用卡展开 + 点赞点踩）→ 文档管理（上传/摄取进度轮询/版本历史/时效标记）→ 管理端（成本看板/检索调试/评估回归，member 不可见）。

```bash
pnpm dev          # 同时起 api + worker + web（web 在 :5173，API 代理已配好）
pnpm build:web    # 构建产物 apps/web/dist
```

生产形态：构建产物由 **API 进程同源托管**（`/assets/*` 动态通配 + `@Get('*')` SPA 兜底路由，客户端路由挂 `/kb` 前缀避让 API 路径空间），浏览器打开 `http://localhost:3000/kb` 即是完整界面。浏览器实测通过：流式回答、引用定位、越权隐藏、过期标记、配额条实时变化、会话删除、授权管理。

视觉世界：公文文牍的现代转译（冷纸面 + 墨色 + 朱砂红仅用于引用与主操作），详见 `DESIGN.md`。

## 快速开始

```bash
# 0) 依赖：Node 24+ / pnpm 11+；本地或 docker 提供 PostgreSQL(16+，装 pgvector) 与 Redis 7
brew install pgvector            # 或 docker compose -f docker/docker-compose.dev.yml --profile pg up -d
createdb nestkb && psql -d nestkb -c 'CREATE EXTENSION vector; CREATE EXTENSION pg_trgm;'

# 1) 安装与配置
pnpm install
cp .env.example .env             # 本地默认 LLM_*_PROVIDER=mock，无需 API key 即可跑通全链路

# 2) 建库 + 种子 + 自检
pnpm migrate                     # prisma migrate dev（迁移含 vector/pg_trgm 扩展与 HNSW/GIN 索引）
pnpm seed                        # 两部门四账号 + 12 条评测集
pnpm doctor                      # 连通性自检：pg/扩展/redis/LLM 三通路/embedding 维度校验

# 3) 起服务（api :3000 + 摄取 worker，两个进程）
pnpm dev

# 4) 语料入库（6 篇制度文档，含表格/时效/白名单样例）
pnpm seed:docs                   # 等 worker 摄取 ready

# 5) 冒烟
curl -s -X POST localhost:3000/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"alice@a-dept.com","password":"Passw0rd!123"}'
# 用 accessToken：POST /qa/conversations → POST /qa/conversations/:id/messages（SSE）
```

**账号**（seed 生成，密码统一 `Passw0rd!123`）：`alice@a-dept.com`（研发部）、`admin@nestkb.local`（管理员）、`bob@b-dept.com` / `carol@b-dept.com`（人事部）。

## 接真实模型

`.env` 中三个通路全部配置化（业务代码不出现模型名）：

```bash
LLM_CHAT_PROVIDER=openai-compat
LLM_CHAT_BASE_URL=https://api.example-llm.com/v1
LLM_CHAT_API_KEY=sk-xxx
LLM_CHAT_MODEL=your-chat-model          # 事实问答建议低温 0.2、支持流式
LLM_EMBEDDING_PROVIDER=openai-compat    # bge-m3(1024 维) 可走 ollama 的 /v1 端点
...
PRICE_JSON={"model":{"input":2,"output":8},...}   # 元/百万 token，成本看板与预算闸唯一依据
```

`pnpm doctor` 会打印 embedding 探针维度，**必须与 `EMBEDDING_DIM` 一致**（不一致立即报错——维度错了入库就是废数据）。换 embedding 模型 = 新维度 = 全量重嵌 + 评估对比后切换（`document_chunks.embedding_model` 列区分灰度）。

## 架构

```
apps/web        React SPA：问答（SSE+引用）/ 文档管理 / 成本看板 / 检索调试 / 评估回归
apps/api        HTTP 进程（Fastify + SSE）：auth / documents / qa / feedback / admin / eval / metering + SPA 托管
apps/worker     摄取进程（BullMQ Worker，无 HTTP）：解析(md/pdf/docx) → 分块 → embedding → 入库
libs/llm        LlmModule 门面：chat / embedding / rerank 三通路，provider 配置化，业务不直连 SDK
libs/vector-store  VectorStore（pgvector）+ 权限 WHERE + 混合检索 RRF + rerank 超时降级
libs/chunker    结构感知分块：标题栈 → 表格整块 → 超长递归下切带重叠
libs/prompts    版本化 prompt 资产：RAG prompt / 引用校验器 / 注入护栏 / eval judge
libs/contracts  队列 job / SSE 事件 / 共享 DTO（零依赖）
libs/common     zod 环境校验 / TraceId(ALS) / 统一响应与异常 / Redis
prisma          全量 DDL（snake_case 对齐计划书 6.x；vector/tsv 列与 HNSW/GIN 索引在迁移 SQL 手工维护）
eval/           评测集版本化 + run-eval（Recall@5 / 忠实度 / 引用准确率 / 相关性 / 成本 / 延迟 六元组落库）
```

## 核心设计决定（与调研证据对照）

| 决定 | 证据 |
|---|---|
| 权限过滤做在检索层 SQL（`accessWhereSql`），不在 prompt 提醒 | RAG 生产失败首位：权限泄漏。越权数据从未进入候选集 |
| 混合检索 + RRF + rerank（超时 800ms 降级打标） | 单路向量在规模下退化；rerank 是增强不是依赖 |
| 引用溯源一等功能：`chunkId+versionNo+quote+headingPath`，引用校验器剔除幻觉编号 | 用户无法验证出处 = 信任崩塌 |
| 摄取幂等键 = versionId（jobId 去重 + hasVersion 双保险）、先删后写单事务 | 重复投递零副作用；防新旧版本混检 |
| usage 预扣（Redis NX+TTL）→ 结算（API usage 唯一计费依据）→ 部分结算回冲 | 成本归因不清是 RAG 六大失败之一 |
| 评测集独立版本化，prompt/模型变更必跑回归（eval_runs 账本） | "上线即冻结、效果缓慢腐烂" |
| 摄取走独立 Worker 进程（不拆微服务） | 队列工程；部署形态单体 + worker |

## API 一览（18 个 P0 接口）

```
POST /auth/login | /auth/refresh        GET /auth/me
POST /documents（multipart ≤20MB）      GET /documents | /documents/:id | /documents/:id/ingestion
DELETE /documents/:id                   POST /documents/:id/versions | /documents/:id/reingest(admin)
POST /qa/conversations                  POST /qa/conversations/:id/messages（SSE 流式问答）
GET  /qa/conversations/:id              POST /messages/:id/feedback（点赞点踩+原因标签）
GET  /admin/usage/summary?dim=dept|user|day|scene    GET /admin/retrieval/debug?q=
GET  /admin/queues（bull-board，admin）  POST /admin/eval/runs | /admin/eval/cases/import
POST /admin/documents/:id/expire | /admin/departments/:id/quota | /admin/documents/:id/grants
```

SSE 事件顺序固定：`meta → delta* → citations → usage → done`（error 之后流终止）。失败分支：`NO_EVIDENCE`（真没有依据）/ `QUOTA_EXCEEDED`（部门月配额耗尽，降级只读检索）/ `UPSTREAM_ERROR`（可重试）。响应头 `x-rerank-degraded: true` 表示 rerank 超时降级为 RRF 粗排。

## 治理与运维

- **文档治理**（admin）：标记过期（到期不可召回）、白名单授权（部门级/用户级，带过期时间，default deny）、调整部门月预算、失败摄取重放
- **评测用例池**：三来源（人工/点踩回流/失败专项）可视化管理 + JSON 批量导入
- **压测**：`node scripts/loadtest.js --url http://127.0.0.1:5050 --users 50 --duration 20` —— 多账号轮换 + 真实节奏（预扣配额按设计将单用户并发串行化），E4 门槛：错误率 <1%（实测 50 并发 0% 错误、P95≈150ms）
- **资料侧消毒**：检索命中的 chunk 进入 LLM 上下文前由注入护栏净化（间接注入指令不进模型），citations 仍展示原文供人工核对（T13）
- **CI**：GitHub Actions（`.github/workflows/ci.yml`）—— 类型检查 → 迁移 → 单测 → E2E（真实 pgvector+Redis service 容器）→ 构建 → 评估回归
- **生产部署**：
  - **2核2G**：`bash scripts/deploy.sh`（一键：装 Docker / 生成 .env.prod / 登录 GHCR 拉镜像 / 启动 / seed / doctor——镜像由 CI 推 GHCR，不在小机器上构建；上传限 10MB）
  - **2核4G**：`docker compose -f docker/docker-compose.prod.yml up -d --build`（内存分配 PG 1g / api 768m / worker 768m 含堆封顶）
  - 两者都需要容器后初始化：`exec api npx ts-node -r tsconfig-paths/register --transpile-only scripts/seed.ts` 与 `seed-docs.ts`（2G 脚本已自动做）
- **服务器初始化 runbook**：
  ```bash
  # 服务器上（装好 Docker 后）
  git clone https://github.com/hhan593/nestkb && cd nestkb
  # 按需配置真实模型 key：直接写 docker-compose.prod.yml 的 environment 或导出环境变量
  docker compose -f docker/docker-compose.prod.yml up -d --build
  # 初始化账号/评测集/语料（容器内有 ts-node，脚本已打进镜像）
  docker compose -f docker/docker-compose.prod.yml exec api npx ts-node -r tsconfig-paths/register --transpile-only scripts/seed.ts
  docker compose -f docker/docker-compose.prod.yml exec api npx ts-node -r tsconfig-paths/register --transpile-only scripts/seed-docs.ts
  # 自检
  docker compose -f docker/docker-compose.prod.yml exec api npx ts-node -r tsconfig-paths/register --transpile-only scripts/doctor.ts
  ```
  生产必改：`JWT_SECRET`、`PRICE_JSON`、三个 `LLM_*` 通路的 key（建议用 env 文件而非写死在 compose 里）。

## 测试与评估

```bash
pnpm test        # 单元测试（chunker 四类输入 / RRF / 引用校验 / 权限 WHERE / 价格表 / env 校验）
pnpm test:e2e    # 全链路 E2E（真实 PG+Redis+mock LLM）：摄取→问答→越权矩阵→拒答→注入→损坏文档→点踩回流
pnpm eval        # 评估回归：Recall@5 / 忠实度 / 引用准确率 / 相关性 / 成本 / 延迟，落 eval_runs
```

- E2E 12 条覆盖计划书 11.2 的 T01/T03/T05/T11/T13 与 F2 引用溯源。
- 评测集 `eval/datasets/eval-set.v1.json` 独立版本化；**prompt 迭代期间不许改它**（防过拟合）。点踩回流用例以 `source=feedback` 入池。
- mock provider 下的评估绝对值不代表真实模型基线（mock embedding 是字符 bigram 哈希、mock judge 是词面覆盖率），**接真实模型后重跑 `pnpm eval` 才是有效基线**；基线目标：Recall@5 ≥0.85 / 忠实度 ≥0.80 / 引用准确率 ≥0.90 / 相关性 ≥0.75 / 单次成本 ≤0.05 元 / P95 检索 ≤800ms。

## 生产运行

```bash
pnpm build                    # nest build api + worker（tsc）
pnpm start:api                # node -r ./scripts/runtime-paths.js dist/apps/api/apps/api/src/main.js
pnpm start:worker             # 同上，worker 入口
```

- 优雅停机：SIGTERM → BullMQ worker 等当前 job 完成 → Prisma/Redis 关闭（已验证）。
- 方案 B（Qdrant + MySQL + MinIO）：`docker compose --profile qdrant`，`VectorStore` 已接口化，切换只影响 `libs/vector-store` 实现类（`qdrantAccessFilter` 已备）。


## 文档

- [docs/失败模式与对策.md](docs/失败模式与对策.md) —— 对照调研二 §3.2 六类失败逐条标注防御手段（共同设计原则第 2 条）
- 计划书原文：`nest_study/docs/nest/projects/计划书三-企业知识库AI助手RAG.md`
