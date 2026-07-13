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

// 此站是政府自建主機(124.199.82.82,無 CDN),疑似封鎖海外 IP:
// 本地(台灣 IP)實測從未失敗,GitHub Actions(美國 IP)實測每次都 fetch failed。
// 這裡加上逾時、重試、以及把底層錯誤原因(err.cause)寫進錯誤訊息,
// 讓 CI log 能看出到底是連線被拒、逾時還是 DNS 問題,而不是籠統的 fetch failed。
const RETRIES = 3;
const TIMEOUT_MS = 15000;

async function fetchWithRetry(url) {
  let lastErr;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      if (attempt < RETRIES) await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
  }
  const cause = lastErr?.cause ? `;底層原因: ${lastErr.cause.code || lastErr.cause.message}` : "";
  throw new Error(`勞動部勞動法令查詢系統請求失敗(已重試 ${RETRIES} 次): ${lastErr.message}${cause}`);
}

async function fetchPage(page) {
  const url = `${BASE_URL}?page=${page}&_cb=${Date.now()}`; // _cb: 避免固定 URL 吃到舊快取
  const html = await fetchWithRetry(url);
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
