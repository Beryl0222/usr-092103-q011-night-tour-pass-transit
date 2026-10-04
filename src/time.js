/** 时间工具：内部一律用毫秒计算，对外展示统一为北京时间（+08:00）。 */

const OFFSET_MS = 8 * 60 * 60 * 1000;

export function toMs(iso) {
  return Date.parse(iso);
}

export function fmt(ms) {
  return new Date(ms + OFFSET_MS).toISOString().slice(0, 19) + "+08:00";
}

export function addMinutesMs(ms, minutes) {
  return ms + minutes * 60 * 1000;
}

/** 从 +08:00 的 ISO 字符串取小时（用于夜间项目判定）。 */
export function hourOf(iso) {
  return Number(iso.slice(11, 13));
}

/** 从 +08:00 的 ISO 字符串取日期（用于天气预警按日匹配）。 */
export function dateOf(iso) {
  return iso.slice(0, 10);
}
