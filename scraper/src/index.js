import { loadEnv } from "./lib/loadEnv.js";
loadEnv();

import { fetchGazette } from "./sources/gazette.js";
import { fetchMolFaq } from "./sources/molFaq.js";
import { fetchMolLaws } from "./sources/molLaws.js";
import { fetchMolNews } from "./sources/molNews.js";
import { fetchBlog104 } from "./sources/blog104.js";
import { fetchWorkdj } from "./sources/workdj.js";
import { filterUnseenNotion, markPushedNotion } from "./lib/notionDedupe.js";
import { filterRecent } from "./lib/dateFilter.js";
import { analyzeLaborLawItems } from "./gemini/laborLawAnalysis.js";
import { selectHrDigest } from "./gemini/hrDigestSelection.js";
import { buildDailyFlexMessage } from "./line/buildDailyMessage.js";
import { writeFileSync } from "fs";

// track: "law" = 勞動法令偵探(行政院公報+常見問答+勞動法令查詢系統),"news" = HR 情報站(新聞/雜誌)
const SOURCE_CONFIGS = [
  { fetch: fetchGazette, label: "行政院公報", track: "law" },
  { fetch: fetchMolFaq, label: "勞動部常見問答", track: "law" },
  { fetch: fetchMolLaws, label: "勞動部勞動法令查詢系統", track: "law" },
  { fetch: fetchMolNews, label: "勞動部新聞稿", track: "news" },
  { fetch: fetchBlog104, label: "104職場力", track: "news" },
  { fetch: fetchWorkdj, label: "WORK DJ人力銀行", track: "news" },
];

async function main() {
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

  // 用標題去重,不是用連結:行政院公報跟勞動部勞動法令查詢系統常常登出一模一樣的公告,
  // 標題完全相同但連結不同(不同網站),只用連結去重會抓不到這種跨來源重複
  const uniqueItems = [...new Map(allItems.map((item) => [item.title, item])).values()];
  if (uniqueItems.length < allItems.length) {
    console.log(`(同次執行內去除 ${allItems.length - uniqueItems.length} 筆重複標題)`);
  }

  const recentItems = filterRecent(uniqueItems);
  console.log(`(只保留當日/前日發布的項目:${uniqueItems.length} 筆 → ${recentItems.length} 筆)`);

  // 去重基準是「已推播」,不是「已處理」:這裡只是排除掉 90 天內已經推播過的項目,
  // 不管 Gemini 這次判斷結果如何,都要先送進 Gemini —— 真正決定要不要標記為已推播,
  // 要等 Gemini 判斷/精選完成之後才知道。
  let candidates = recentItems;
  try {
    candidates = await filterUnseenNotion(recentItems);
    console.log(`(排除 90 天內已推播過的項目:${recentItems.length} 筆 → ${candidates.length} 筆)`);
  } catch (err) {
    console.error(`[FAIL] Notion 去重查詢失敗,本次略過去重、視為全部未推播: ${err.message}`);
  }

  const lawItems = candidates.filter((item) => item.track === "law");
  const newsItems = candidates.filter((item) => item.track === "news");

  const toMarkPushed = [];
  let relevantLaw = [];
  let digestNews = [];

  console.log(`\n=== 勞動法令偵探(${lawItems.length} 筆待判斷)===`);
  try {
    const lawAnalysis = await analyzeLaborLawItems(lawItems);
    relevantLaw = lawAnalysis.filter((item) => item.analysis?.relevant);
    console.log(`Gemini 判斷完成,${relevantLaw.length}/${lawAnalysis.length} 筆判定為相關`);
    console.log(JSON.stringify(relevantLaw, null, 2));
    toMarkPushed.push(...relevantLaw);
  } catch (err) {
    console.error(`[FAIL] Gemini 法令判斷失敗,略過此軌道: ${err.message}`);
  }

  console.log(`\n=== HR 情報站(${newsItems.length} 筆候選)===`);
  try {
    digestNews = await selectHrDigest(newsItems, { maxItems: 16 });
    console.log(`Gemini 精選完成,共 ${digestNews.length} 篇(上限 16)`);
    console.log(JSON.stringify(digestNews, null, 2));
    toMarkPushed.push(...digestNews);
  } catch (err) {
    console.error(`[FAIL] Gemini HR 情報站精選失敗,略過此軌道: ${err.message}`);
  }

  // 兩軌合併成單一則 LINE Flex Message(9:00 推播)
  const today = new Date().toISOString().slice(0, 10);
  const flexMessage = buildDailyFlexMessage({ lawItems: relevantLaw, newsItems: digestNews, date: today });
  console.log(`\n=== 9:00 推播內容(LINE Flex Message)===`);
  console.log(JSON.stringify(flexMessage, null, 2));
  writeFileSync("line-message.json", JSON.stringify(flexMessage, null, 2));

  // TODO: 這裡標記「已推播」的時機是 Gemini 判斷/精選完成後,還不是真的 LINE 推播成功後
  // ——LINE Push 節點接上之後,應該把 markPushedNotion 移到推播成功的 callback 裡才準確。
  if (toMarkPushed.length > 0) {
    try {
      await markPushedNotion(toMarkPushed);
      console.log(`\n已寫入 ${toMarkPushed.length} 筆推播紀錄到 Notion`);
    } catch (err) {
      console.error(`[FAIL] Notion 寫入推播紀錄失敗: ${err.message}`);
    }
  }
}

main().catch((err) => {
  console.error("執行失敗:", err);
  process.exit(1);
});
