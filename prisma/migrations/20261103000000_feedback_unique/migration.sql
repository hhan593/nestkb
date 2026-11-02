-- 反馈去重（code review #17）：同一用户对同一消息只保留一条反馈
-- 先清理历史重复行（保留每组最新一条），再建唯一索引，避免存量数据导致迁移失败
DELETE FROM "feedbacks" f
  USING "feedbacks" g
  WHERE f."message_id" = g."message_id"
    AND f."user_id" = g."user_id"
    AND (f."created_at" < g."created_at"
      OR (f."created_at" = g."created_at" AND f."id" < g."id"));

-- CreateIndex
CREATE UNIQUE INDEX "feedbacks_message_id_user_id_key" ON "feedbacks"("message_id", "user_id");
