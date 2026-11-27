-- #32 重摄取按 document_id 整批删除：
--   DELETE FROM document_chunks WHERE document_id = $1
-- 该语句跑在 advisory lock 事务内，缺索引时对最大的表做全表扫描，重摄取期间并发写入一起被拖住。
CREATE INDEX IF NOT EXISTS "idx_chunks_document" ON "document_chunks"("document_id");
