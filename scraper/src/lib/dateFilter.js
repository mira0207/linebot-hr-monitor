// 只保留「當日或前日」發布的項目,避免每次都重新處理舊資料(尤其常見問答這類靜態內容)。
// 沒有可辨識日期的項目視為無法確認新舊,直接排除。
export function isRecent(dateStr, days = 2) {
  if (!dateStr) return false;
  const date = new Date(dateStr);
  if (Number.isNaN(date.getTime())) return false;

  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - (days - 1));

  return date >= cutoff;
}

// item.dateUnknown === true 代表該來源本身就沒有可靠的發布日期(如 WORK DJ HR情報站),
// 不能因為缺日期就一律排除,改為放行、完全依賴 Notion 去重機制避免重複推播。
export function filterRecent(items, days = 2) {
  return items.filter((item) => item.dateUnknown === true || isRecent(item.published_at, days));
}
