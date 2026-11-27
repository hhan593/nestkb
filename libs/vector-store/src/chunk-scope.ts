/**
 * 「可检索块」范围 SQL —— 权限 + 当前版本 + 有效期 三件套的唯一组装处。
 *
 * 抽出的原因（#24）：searchVectors / searchFts / contrastExists 原先各自手写同语义 WHERE，
 * 对照查询漏掉 `d.current_version_id = v.id` 与 `c.embedding_model = $` 后，两条 SQL 不再等价，
 * 「库里有没有相近内容」被误判成「有」，于是命中 0 条时对有权用户误报「没有访问权限」。
 * 范围条件只允许从这里产出，避免第三处再漂移。
 */
import { accessWhereSql, AccessScope } from './access-filter';

/**
 * @param startParam 权限参数起始占位号（权限组占 startParam .. 含 2 个参数，admin 时为 0 个）
 * @returns sql 为可直接拼进 WHERE 的括号片段（引用 c / d / v 三个别名）；params 为按序参数
 */
export function chunkScopeSql(scope: AccessScope, startParam: number): { sql: string; params: string[] } {
  // 文档层（d.department_id）与块层（c.dept_id）各判一次：前者挡越权文档，后者挡住 ACL 变更后残留的块
  const wv = accessWhereSql(scope, startParam, 'd.department_id');
  const wc = accessWhereSql(scope, startParam + wv.params.length, 'c.dept_id');
  return {
    params: [...wv.params, ...wc.params],
    sql: `(c.version_id IN (
              SELECT v.id
                FROM document_versions v
                JOIN documents d ON d.id = v.document_id
               WHERE d.status = 'active'
                 AND d.current_version_id = v.id
                 AND (v.expires_at IS NULL OR v.expires_at > now())
                 AND ${wv.sql})
        AND (v.expires_at IS NULL OR v.expires_at > now())
        AND ${wc.sql})`,
  };
}
