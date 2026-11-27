/**
 * 上传文件的 MIME ↔ 扩展名唯一映射。
 *
 * 原先 api 的上传校验、存储 key 生成、worker 解析器各自维护一份映射，已经出现分歧
 * （`text/plain` 在一处映射成 .md，在另一处是 .txt），新增类型必然漏改一处（#33）。
 */

export const MIME_EXT: Readonly<Record<string, string>> = {
  'text/markdown': '.md',
  'text/plain': '.txt',
  'application/pdf': '.pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
};

/** 允许入库的扩展名（`.markdown` 是 markdown 的另一种写法） */
export const ALLOWED_EXT: ReadonlySet<string> = new Set(['.md', '.markdown', '.txt', '.pdf', '.docx']);

/**
 * 部分客户端（Windows 资源管理器上传、curl 未指定类型）把 .md 报成 octet-stream，
 * 这类请求交给扩展名判定，因此单独放行。
 */
export const OCTET_STREAM = 'application/octet-stream';

export function isAllowedMime(mime: string): boolean {
  return mime === OCTET_STREAM || mime in MIME_EXT;
}

/** 由 MIME 推扩展名；未知类型返回空串，由调用方回退到文件名的扩展名 */
export function extForMime(mime: string): string {
  return MIME_EXT[mime] ?? '';
}
