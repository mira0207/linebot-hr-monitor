import * as cheerio from "cheerio";
import { fetchAllPages } from "../lib/paginate.js";

const BASE_URL = "https://www.mol.gov.tw/1607/28690/2282/nodeListSearch";

async function fetchPage(page) {
  const url = `${BASE_URL}?Page=${page}&PageSize=10`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`勞動部常見問答請求失敗: HTTP ${res.status} (page ${page})`);
  const html = await res.text();
  const $ = cheerio.load(html);

  const items = [];
  $(".table_list table tbody tr").each((_, el) => {
    const cells = $(el).find("td");
    const a = $(cells[1]).find("a").first();
    const title = a.text().trim();
    if (!title) return;

    const href = a.attr("href");
    const link = href ? new URL(href, BASE_URL).toString() : null;
    const category = $(cells[2]).text().trim();
    const publishedAt = $(cells[4]).text().trim();

    items.push({
      source: "勞動部常見問答",
      title,
      link,
      published_at: publishedAt || null,
      summary: "",
      category,
    });
  });

  return items;
}

export async function fetchMolFaq({ pages = 3 } = {}) {
  return fetchAllPages(fetchPage, pages);
}
