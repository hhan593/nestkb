# PRODUCT.md — NestKB 企业知识库 AI 问答助手

## Product

NestKB（Enterprise Knowledge Base）：企业内部知识库 AI 问答系统。员工上传制度/规范文档（MD/PDF/DOCX），系统异步摄取（解析→结构感知分块→向量化），提问时混合检索（向量+关键词+RRF+rerank）并流式回答，回答内嵌 `[n]` 引用编号，每条引用可溯源到文档、版本、章节与原文片段。

**独有机制**：权限过滤做在检索层 SQL（越权文档从不进入候选集），引用溯源是一等功能（chunkId+版本+章节+原文），全链路 token 计量与成本归因（部门月配额闸）。

## Users & Scenes

- **员工（member）**：工作时间在办公桌面浏览器使用。任务：上传部门文档、查看摄取进度、提问并获得带引用的回答、对回答点赞/点踩并选原因。
- **管理员（admin）**：任务 same as member + 成本看板（按部门/用户/天/场景）、检索调试（双路分数/RRF/rerank 对比/分段延迟）、评估回归报告（Recall@5/忠实度/引用准确率）、文档时效与授权治理、队列 DLQ 重放。
- 两个必须能现场演示的场景：①A 部门账号无论怎么问都检索不到 B 部门受限文档；②任意回答能说清"引用了哪份文档的哪一版、哪一段"。

## Platform

Web 桌面优先（员工办公场景，1280+ 宽度为主），窄屏可用即可。

## Stack

- 后端：NestJS 11 + Fastify（SSE）+ Prisma + PostgreSQL/pgvector + BullMQ（已建成，接口为事实来源）
- 前端：**Vite + React + TypeScript**（用户在轻量页/React SPA/不需要 三选项中明确选择 React SPA 工程）
- 前端形态：React SPA，开发期 Vite dev server + 代理；生产期构建产物由 API 进程静态托管（同源，无需 CORS）

## Capabilities (API = truth)

18 个 P0 接口（README 有全表）。关键协议：
- SSE 问答事件序固定：`meta → delta* → citations → usage → done`；error 后流终止；错误码 NO_EVIDENCE / QUOTA_EXCEEDED / RATE_LIMITED / UPSTREAM_ERROR / INJECTION_BLOCKED
- 响应统一包裹 `{ code: 0, data, requestId }`；401 时用 refreshToken 无感刷新
- 引用字段：no/chunkId/documentId/title/versionNo/headingPath/quote(200字)/effectiveAt/possiblyOutdated
- 文档上传 multipart：file+title+accessLevel(department|company|whitelist)+expiresAt？；摄取 stage：queued/parsing/chunking/embedding/storing/ready/failed（failed 带 error 分类）
- 反馈：rating(up/down)+reasons(wrong/no_citation/outdated/not_found/other)+comment

## Constraints

- 全中文界面（与产品/语料一致）
- 演示性质：账号密码登录（seed 四账号），token 存 localStorage
- 计量显示元（CNY），保留 4~6 位小数
- 管理端接口挂 admin 角色；member 访问需隐藏或禁用入口
- 无设计资产/无品牌承诺：绿地界面，视觉世界待建（DESIGN.md 完成后回填）
