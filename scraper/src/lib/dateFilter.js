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

// 以台灣時間判斷「今天」與星期幾。排程 09:00 台灣時間 = 01:00 UTC 剛好同一天,
// 但手動觸發或本地執行的時間不固定,明確換算成 UTC+8 才不會在跨日前後判斷錯星期。
export function taipeiToday() {
  const now = new Date(Date.now() + 8 * 60 * 60 * 1000);
  return { iso: now.toISOString().slice(0, 10), weekday: now.getUTCDay() };
}

// 週六、週日不推播,週一要補上週五~週日的內容:往回看 4 天(五、六、日、一);
// 其他平日維持當日+前日
export function lookbackDays(weekday) {
  return weekday === 1 ? 4 : 2;
}

// item.dateUnknown === true 代表該來源本身就沒有可靠的發布日期(如 WORK DJ HR情報站),
// 不能因為缺日期就一律排除,改為放行、完全依賴 Notion 去重機制避免重複推播。
export function filterRecent(items, days = 2) {
  return items.filter((item) => item.dateUnknown === true || isRecent(item.published_at, days));
}
