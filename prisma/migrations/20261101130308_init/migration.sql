-- NestKB 自定义：向量与模糊匹配扩展（须先于 document_chunks 的 vector 列）
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- CreateEnum
CREATE TYPE "role" AS ENUM ('member', 'admin');

-- CreateEnum
CREATE TYPE "access_level" AS ENUM ('department', 'company', 'whitelist');

-- CreateEnum
CREATE TYPE "document_status" AS ENUM ('active', 'archived');

-- CreateEnum
CREATE TYPE "subject_type" AS ENUM ('dept', 'user');

-- CreateEnum
CREATE TYPE "effect" AS ENUM ('allow', 'deny');

-- CreateEnum
CREATE TYPE "ingest_stage" AS ENUM ('queued', 'parsing', 'chunking', 'embedding', 'storing', 'ready', 'failed');

-- CreateEnum
CREATE TYPE "message_role" AS ENUM ('user', 'assistant');

-- CreateEnum
CREATE TYPE "message_status" AS ENUM ('completed', 'failed', 'aborted');

-- CreateEnum
CREATE TYPE "query_scene" AS ENUM ('qa', 'debug', 'eval', 'cache_lookup');

-- CreateEnum
CREATE TYPE "usage_scene" AS ENUM ('qa', 'ingest_embed', 'rerank', 'eval', 'summary');

-- CreateEnum
CREATE TYPE "rating" AS ENUM ('up', 'down');

-- CreateEnum
CREATE TYPE "eval_case_type" AS ENUM ('fact', 'table', 'timeliness', 'deny', 'multi_hop');

-- CreateEnum
CREATE TYPE "eval_source" AS ENUM ('manual', 'feedback', 'incident');

-- CreateTable
CREATE TABLE "departments" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "quota_month" DECIMAL(12,2) NOT NULL DEFAULT 50.0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "department_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "role" NOT NULL DEFAULT 'member',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "documents" (
    "id" UUID NOT NULL,
    "department_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "access_level" "access_level" NOT NULL DEFAULT 'department',
    "current_version_id" UUID,
    "status" "document_status" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_versions" (
    "id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "version_no" INTEGER NOT NULL,
    "storage_key" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "effective_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6),
    "checksum" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "document_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dept_permissions" (
    "id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "subject_type" "subject_type" NOT NULL,
    "subject_id" UUID NOT NULL,
    "effect" "effect" NOT NULL DEFAULT 'allow',
    "expires_at" TIMESTAMPTZ(6),
    "granted_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "dept_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_chunks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "document_id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "dept_id" UUID NOT NULL,
    "chunk_no" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "heading_path" TEXT NOT NULL DEFAULT '',
    "embedding" vector(1024) NOT NULL,
    "embedding_model" TEXT NOT NULL,
    "tsv" tsvector,
    "token_count" INTEGER NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "document_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ingestion_jobs" (
    "id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "stage" "ingest_stage" NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "chunk_count" INTEGER,
    "cost_estimated" DECIMAL(10,6),
    "stage_timings" JSONB NOT NULL DEFAULT '{}',
    "started_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ingestion_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "title" TEXT,
    "summary" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "role" "message_role" NOT NULL,
    "content" TEXT NOT NULL,
    "citations" JSONB,
    "retrieval_snapshot" JSONB,
    "usage_id" UUID,
    "latency_ms" INTEGER,
    "status" "message_status" NOT NULL DEFAULT 'completed',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "query_logs" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "dept_id" UUID,
    "query" TEXT NOT NULL,
    "scene" "query_scene" NOT NULL DEFAULT 'qa',
    "access_filter" JSONB NOT NULL,
    "hit_count" INTEGER,
    "vector_top" JSONB,
    "fts_top" JSONB,
    "fused_top" JSONB,
    "reranked_top" JSONB,
    "rerank_degraded" BOOLEAN NOT NULL DEFAULT false,
    "latency_breakdown" JSONB,
    "total_ms" INTEGER,
    "request_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "query_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_records" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "dept_id" UUID NOT NULL,
    "scene" "usage_scene" NOT NULL,
    "provider" TEXT NOT NULL,
    "prompt_tokens" INTEGER NOT NULL DEFAULT 0,
    "completion_tokens" INTEGER NOT NULL DEFAULT 0,
    "cached_tokens" INTEGER NOT NULL DEFAULT 0,
    "cost_estimated" DECIMAL(10,6),
    "request_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "usage_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feedbacks" (
    "id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "rating" "rating" NOT NULL,
    "reasons" TEXT[],
    "comment" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "feedbacks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "eval_cases" (
    "id" UUID NOT NULL,
    "question" TEXT NOT NULL,
    "case_type" "eval_case_type" NOT NULL DEFAULT 'fact',
    "gold_answer" TEXT,
    "gold_chunk_ids" TEXT[],
    "gold_markers" TEXT[],
    "source" "eval_source" NOT NULL DEFAULT 'manual',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "expect_deny" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "eval_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "eval_runs" (
    "id" UUID NOT NULL,
    "dataset_version" TEXT NOT NULL,
    "triggered_by" TEXT NOT NULL,
    "recall_at5" DECIMAL(6,4),
    "fidelity" DECIMAL(6,4),
    "citation_acc" DECIMAL(6,4),
    "relevance" DECIMAL(6,4),
    "avg_cost" DECIMAL(10,6),
    "avg_latency_ms" INTEGER,
    "total_cases" INTEGER NOT NULL,
    "detail" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "eval_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "departments_name_key" ON "departments"("name");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "documents_department_id_status_idx" ON "documents"("department_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "document_versions_document_id_version_no_key" ON "document_versions"("document_id", "version_no");

-- CreateIndex
CREATE INDEX "idx_dperm_lookup" ON "dept_permissions"("subject_type", "subject_id", "document_id");

-- CreateIndex
CREATE UNIQUE INDEX "dept_permissions_document_id_subject_type_subject_id_key" ON "dept_permissions"("document_id", "subject_type", "subject_id");

-- CreateIndex
CREATE INDEX "idx_chunks_perm" ON "document_chunks"("dept_id", "version_id");

-- CreateIndex
CREATE UNIQUE INDEX "document_chunks_version_id_chunk_no_key" ON "document_chunks"("version_id", "chunk_no");

-- CreateIndex
CREATE UNIQUE INDEX "ingestion_jobs_version_id_key" ON "ingestion_jobs"("version_id");

-- CreateIndex
CREATE INDEX "idx_jobs_stage" ON "ingestion_jobs"("stage", "updated_at");

-- CreateIndex
CREATE INDEX "messages_conversation_id_created_at_idx" ON "messages"("conversation_id", "created_at");

-- CreateIndex
CREATE INDEX "query_logs_scene_created_at_idx" ON "query_logs"("scene", "created_at");

-- CreateIndex
CREATE INDEX "query_logs_request_id_idx" ON "query_logs"("request_id");

-- CreateIndex
CREATE INDEX "idx_usage_dept_day" ON "usage_records"("dept_id", "created_at");

-- CreateIndex
CREATE INDEX "usage_records_user_id_created_at_idx" ON "usage_records"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "usage_records_scene_created_at_idx" ON "usage_records"("scene", "created_at");

-- CreateIndex
CREATE INDEX "feedbacks_rating_created_at_idx" ON "feedbacks"("rating", "created_at");

-- CreateIndex
CREATE INDEX "eval_cases_source_active_idx" ON "eval_cases"("source", "active");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_current_version_id_fkey" FOREIGN KEY ("current_version_id") REFERENCES "document_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dept_permissions" ADD CONSTRAINT "dept_permissions_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "document_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingestion_jobs" ADD CONSTRAINT "ingestion_jobs_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingestion_jobs" ADD CONSTRAINT "ingestion_jobs_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "document_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedbacks" ADD CONSTRAINT "feedbacks_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- NestKB 自定义索引：Prisma schema 无法表达的部分
-- HNSW 向量索引（余弦距离，计划书 6.4 参数 m=16 ef_construction=64）
CREATE INDEX IF NOT EXISTS idx_chunks_vec ON document_chunks USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
-- GIN：tsv 全文索引
CREATE INDEX IF NOT EXISTS idx_chunks_tsv ON document_chunks USING gin (tsv);
-- GIN：pg_trgm 模糊匹配兜底（中文分词断层时退化使用）
CREATE INDEX IF NOT EXISTS idx_chunks_trgm ON document_chunks USING gin (content gin_trgm_ops);
-- document_chunks 由 VectorStore 裸 SQL 管理：时间列需要 DB 默认值（Prisma @updatedAt 是客户端生成）
ALTER TABLE document_chunks ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE document_chunks ALTER COLUMN updated_at SET DEFAULT now();
-- 文档级联删除（计划书"删除（级联异步清 chunks）"）：document_versions FK 调整为 CASCADE
ALTER TABLE document_versions DROP CONSTRAINT document_versions_document_id_fkey;
ALTER TABLE document_versions ADD CONSTRAINT document_versions_document_id_fkey FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE ON UPDATE CASCADE;
