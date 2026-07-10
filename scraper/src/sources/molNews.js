import * as cheerio from "cheerio";
import { fetchAllPages } from "../lib/paginate.js";

const BASE_URL = "https://www.mol.gov.tw/1607/1632/1633/";

async function fetchPage(page) {
  const url = `${BASE_URL}?Page=${page}&PageSize=10`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`勞動部新聞稿請求失敗: HTTP ${res.status} (page ${page})`);
  const html = await res.text();
  const $ = cheerio.load(html);

  const items = [];
  $(".item_listblock .item_list2").each((_, el) => {
    const a = $(el).find("h3 a").first();
    const title = a.text().trim();
    if (!title) return;

    const href = a.attr("href");
    const link = href ? new URL(href, BASE_URL).toString() : null;

    const dataText = $(el).find(".data").text();
    const dateMatch = dataText.match(/發布日期：(\d{4}-\d{2}-\d{2})/);

    items.push({
      source: "勞動部新聞稿",
      title,
      link,
      published_at: dateMatch ? dateMatch[1] : null,
      summary: "",
      category: "",
    });
  });

  return items;
}

export async function fetchMolNews({ pages = 3 } = {}) {
  return fetchAllPages(fetchPage, pages);
}
