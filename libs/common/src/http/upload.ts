/**
 * 上传体积上限的唯一来源。
 *
 * 原先三处各写一份：main.ts 的 multipart limits、DocumentsService 的业务校验（硬编码 20MB）、
 * DocumentsController 的报错文案。MAX_UPLOAD_MB 调小之后，只有 multipart 生效，
 * 业务校验仍按 20MB 放行 —— 上限形同虚设（#33）。
 */
const DEFAULT_MB = 20;

export function maxUploadMb(): number {
  const mb = Number(process.env.MAX_UPLOAD_MB || DEFAULT_MB);
  return Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_MB;
}

export function maxUploadBytes(): number {
  return maxUploadMb() * 1024 * 1024;
}
