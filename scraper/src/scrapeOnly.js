// 本地測試用:只跑爬蟲,不經過 Gemini / LINE / Notion,
// 看各來源實際抓到什麼、經過標題去重與日期過濾後剩下什麼。
// 執行:npm run scrape(於 scraper/ 目錄),結果同時印出並寫入 scrape-output.json
import { fetchGazette } from "./sources/gazette.js";
import { fetchMolFaq } from "./sources/molFaq.js";
import { fetchMolLaws } from "./sources/molLaws.js";
import { fetchMolNews } from "./sources/molNews.js";
import { fetchBlog104 } from "./sources/blog104.js";
import { fetchWorkdj } from "./sources/workdj.js";
import { filterRecent } from "./lib/dateFilter.js";
import { writeFileSync } from "fs";

const SOURCE_CONFIGS = [
  { fetch: fetchGazette, label: "行政院公報", track: "law" },
  { fetch: fetchMolFaq, label: "勞動部常見問答", track: "law" },
  { fetch: fetchMolLaws, label: "勞動部勞動法令查詢系統", track: "law" },
  { fetch: fetchMolNews, label: "勞動部新聞稿", track: "news" },
  { fetch: fetchBlog104, label: "104職場力", track: "news" },
  { fetch: fetchWorkdj, label: "WORK DJ人力銀行", track: "news" },
];

const results = await Promise.allSettled(SOURCE_CONFIGS.map((cfg) => cfg.fetch()));

const allItems = [];
results.forEach((result, i) => {
  const { label, track } = SOURCE_CONFIGS[i];
  if (result.status === "fulfilled") {
    console.log(`[OK] ${label}: ${result.value.length} 筆`);
    allItems.push(...result.value.map((item) => ({ ...item, track })));
  } else {
    console.error(`[FAIL] ${label}: ${result.reason.message}`);
  }
});

// 列出所有爬到的原始資料(不去重、不過濾),依來源分組,每筆顯示日期 + 標題
console.log(`\n共爬到 ${allItems.length} 筆,以下為全部原始資料:\n`);

const bySource = new Map();
for (const item of allItems) {
  if (!bySource.has(item.source)) bySource.set(item.source, []);
  bySource.get(item.source).push(item);
}
for (const [source, items] of bySource) {
  console.log(`━━━ ${source}(${items.length} 筆)━━━`);
  for (const item of items) {
    console.log(`  ${item.published_at || "(無日期)"}  ${item.title}`);
  }
  console.log("");
}

// 參考資訊:去重與過濾後的數量(不影響上面的完整列表)
const uniqueItems = [...new Map(allItems.map((item) => [item.title, item])).values()];
const recentItems = filterRecent(uniqueItems);
console.log(`(參考:標題去重後 ${uniqueItems.length} 筆,當日/前日過濾後 ${recentItems.length} 筆會送進 Gemini)`);

writeFileSync(
  "scrape-output.json",
  JSON.stringify({ raw: allItems, unique: uniqueItems, recent: recentItems }, null, 2)
);
console.log(`完整資料(含連結)已寫入 scrape-output.json`);
