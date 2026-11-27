const CN_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * 本月 1 日 00:00（UTC+8）：配额与用量统计的统一口径。
 *
 * 原实现 `new Date(y, m, 1)` 依赖服务器本地时区 —— 容器（UTC）与国内业务日界线差 8 小时，
 * 同一套配额在本地开发和线上会在不同时刻重置，且两处实现各自为政（#33）。
 */
export function monthStartUtc8(now = new Date()): Date {
  const shifted = new Date(now.getTime() + CN_OFFSET_MS);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), 1) - CN_OFFSET_MS);
}
