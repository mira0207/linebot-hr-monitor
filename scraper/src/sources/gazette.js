import * as cheerio from "cheerio";

const BASE = "https://gazette.nat.gov.tw/egFront/";
// chapter=8 = 衛生勞動篇(衛福部+勞動部混合),用標題前綴過濾出勞動部
const LIST_URL =
  BASE + "advancedSearchResult.do?action=doQuery&chapter=8&log=browseLog&clickfunc=0208";

// 換頁(action=doChangePage)是 session-based,實測會回傳「查詢已逾時」而非資料,
// 且此頁本身固定只回傳約 10 筆,因此暫不做分頁,僅抓第一頁。

export async function fetchGazette() {
  const res = await fetch(LIST_URL, {
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  if (!res.ok) throw new Error(`行政院公報請求失敗: HTTP ${res.status}`);
  const html = await res.text();
  const $ = cheerio.load(html);

  const items = [];
  $(".List .List_Item").each((_, el) => {
    const a = $(el).find("p > a").first();
    const title = a.text().trim();
    if (!title.startsWith("勞動部")) return; // 過濾掉衛福部等非勞動部項目

    const href = a.attr("href");
    const link = href ? new URL(href, LIST_URL).toString() : null;

    const h4Text = $(el).find("h4").first().text().trim();
    const dateMatch = h4Text.match(/\d{4}-\d{2}-\d{2}/);

    items.push({
      source: "行政院公報(勞動部)",
      title,
      link,
      published_at: dateMatch ? dateMatch[0] : null,
      summary: "",
      category: $(el).find(".Tag").first().text().trim(),
    });
  });

  return items;
}
