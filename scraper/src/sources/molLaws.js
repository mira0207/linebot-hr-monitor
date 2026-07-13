import * as cheerio from "cheerio";
import { fetchAllPages } from "../lib/paginate.js";

// 勞動部勞動法令查詢系統「最新動態」,跟行政院公報內容有重疊但是勞動部自己維護、
// 只收勞動法令,不像行政院公報混雜其他部會
const BASE_URL = "https://laws.mol.gov.tw/";

// 日期欄位是民國年格式(如 115.07.09),轉換成西元 YYYY-MM-DD
function rocDateToIso(rocDate) {
  const match = rocDate.trim().match(/^(\d{2,3})\.(\d{1,2})\.(\d{1,2})$/);
  if (!match) return null;
  const [, roc, month, day] = match;
  const year = Number(roc) + 1911;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

async function fetchPage(page) {
  const url = `${BASE_URL}?page=${page}&_cb=${Date.now()}`; // _cb: 避免固定 URL 吃到舊快取
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`勞動部勞動法令查詢系統請求失敗: HTTP ${res.status} (page ${page})`);
  const html = await res.text();
  const $ = cheerio.load(html);

  const items = [];
  $("table.news-table tr").each((_, el) => {
    const cells = $(el).find("td");
    if (cells.length < 3) return; // 跳過表頭列(沒有 td)

    const a = $(cells[2]).find("a").first();
    const title = a.text().trim();
    if (!title) return;

    const href = a.attr("href");
    const link = href ? new URL(href, BASE_URL).toString() : null;
    const category = $(cells[1]).text().trim();
    const publishedAt = rocDateToIso($(cells[0]).text());

    items.push({
      source: "勞動部勞動法令查詢系統",
      title,
      link,
      published_at: publishedAt,
      summary: "",
      category,
    });
  });

  return items;
}

export async function fetchMolLaws({ pages = 3 } = {}) {
  return fetchAllPages(fetchPage, pages);
}
