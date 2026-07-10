import * as cheerio from "cheerio";

// WORK DJ 人力銀行(人力派遣仲介公司)的「HR情報站」分類頁
const LIST_URL = "https://www.workdj.tw/products/index.php?group_id=8738";

// 這個站的列表頁跟文章詳情頁都沒有可靠的發布日期欄位(詳情頁裡唯一出現的日期
// 其實是「相關文章」推薦區塊的圖片 alt 文字,不是本篇文章的日期),所以這裡固定
// published_at 為 null,並標記 dateUnknown,讓 dateFilter 略過「當日/前日」判斷,
// 改完全依賴 Notion 去重機制避免同一篇被重複推播。
export async function fetchWorkdj() {
  const res = await fetch(LIST_URL, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`WORK DJ HR情報站請求失敗: HTTP ${res.status}`);
  const html = await res.text();
  const $ = cheerio.load(html);

  const items = [];
  $("ul.products-list li.item a").each((_, el) => {
    const a = $(el);
    const title = a.find(".name").first().text().trim() || a.attr("title") || "";
    if (!title) return;

    const href = a.attr("href");
    const link = href ? new URL(href, LIST_URL).toString() : null;

    items.push({
      source: "WORK DJ人力銀行-HR情報站",
      title,
      link,
      published_at: null,
      dateUnknown: true,
      summary: "",
      category: "",
    });
  });

  return items;
}
