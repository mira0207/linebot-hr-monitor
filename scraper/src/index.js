import { loadEnv } from "./lib/loadEnv.js";
loadEnv();

import { fetchGazette } from "./sources/gazette.js";
import { fetchMolFaq } from "./sources/molFaq.js";
import { fetchMolLaws } from "./sources/molLaws.js";
import { fetchMolNews } from "./sources/molNews.js";
import { fetchBlog104 } from "./sources/blog104.js";
import { fetchWorkdj } from "./sources/workdj.js";
import { filterUnseenNotion, markPushedNotion, hasPushRecordTodayNotion, purgePushRecordsBefore } from "./lib/notionDedupe.js";
import { filterRecent, taipeiToday, lookbackDays } from "./lib/dateFilter.js";
import { analyzeLaborLawItems } from "./gemini/laborLawAnalysis.js";
import { selectHrDigest } from "./gemini/hrDigestSelection.js";
import { buildDailyFlexMessage } from "./line/buildDailyMessage.js";
import { pushLineMessage } from "./line/pushMessage.js";
import { writeFileSync } from "fs";

// track: "law" = 勞動法令偵探(行政院公報+常見問答+勞動法令查詢系統),"news" = HR 情報站(新聞/雜誌)
// skipInCI: laws.mol.gov.tw 為政府自建主機,封鎖海外 IP(GitHub Actions 實測 ETIMEDOUT,
// 對方完全不回應),在 CI 環境直接跳過不抓,免得每天空等逾時+印失敗訊息。
// 其法令內容與行政院公報(Cloudflare,CI 可達)高度重疊,重要異動不會漏;本地執行時照常抓。
const SOURCE_CONFIGS = [
  { fetch: fetchGazette, label: "行政院公報", track: "law" },
  { fetch: fetchMolFaq, label: "勞動部常見問答", track: "law" },
  { fetch: fetchMolLaws, label: "勞動部勞動法令查詢系統", track: "law", skipInCI: true },
  { fetch: fetchMolNews, label: "勞動部新聞稿", track: "news" },
  { fetch: fetchBlog104, label: "104職場力", track: "news" },
  { fetch: fetchWorkdj, label: "WORK DJ人力銀行", track: "news" },
];

// 關鍵步驟(Notion 去重、Gemini、LINE 推播、Notion 標記)失敗時記錄下來,
// 執行結束用非零 exit code 收尾 —— 推播照常完成,但 CI 上的 run 會顯示失敗、GitHub 會寄通知信。
// 教訓:去重機制曾在 CI 上連續失敗三天沒人發現(錯誤被 catch 住、run 一直是綠色),
// 導致同樣的內容天天重複推播。優雅降級可以,但不能安靜地降級。
const criticalFailures = [];

function reportCritical(message) {
  criticalFailures.push(message);
  console.error(`[FAIL] ${message}`);
  if (process.env.GITHUB_ACTIONS) console.log(`::error::${message}`);
}

// Notion 推播紀錄的刪除界線:原則是「本月 1 號以前的全部刪」,
// 但界線最多只推到「今天往前 3 天」—— 週一會回看到上週五,如果月初剛好是週一,
// 上週五~週日的紀錄還要拿來去重(同一天的備用觸發也會用到),一進新月份就刪會造成重複推播。
// 所以上個月最後幾天的紀錄會在新月份頭幾天陸續刪掉,不是 1 號當天一次清空。
function purgeCutoffIso(todayIso) {
  const firstOfMonth = `${todayIso.slice(0, 7)}-01`;
  const keepFrom = new Date(`${todayIso}T00:00:00Z`);
  keepFrom.setUTCDate(keepFrom.getUTCDate() - (lookbackDays(1) - 1));
  const keepFromIso = keepFrom.toISOString().slice(0, 10);
  return firstOfMonth < keepFromIso ? firstOfMonth : keepFromIso;
}

async function main() {
  // 週六、週日不推播(這兩天幾乎沒有新資訊,過去都是推空訊息),
  // 週五之後發布的內容留到週一一起推(見 lookbackDays)
  const { iso: todayIso, weekday } = taipeiToday();
  if (weekday === 0 || weekday === 6) {
    console.log(`今天(${todayIso})是週末,不推播,週五之後的內容會在週一一起推送`);
    return;
  }

  // 一天最多推播一次:cron-job.org 設有備用觸發時間(補救 GitHub API 偶發故障),
  // 第二次觸發一進來先查 Notion,今天已有推播紀錄(含空訊息心跳)就直接結束,
  // 不爬取、不呼叫 Gemini、不推播;沒有紀錄代表第一次失敗了,照常整套執行等於自動補推。
  try {
    if (await hasPushRecordTodayNotion()) {
      console.log("今日已有推播紀錄,本次應為備用觸發,直接結束(一天最多推播一次)");
      return;
    }
  } catch (err) {
    console.error(`(查詢今日推播紀錄失敗,照常執行: ${err.message})`);
  }

  const activeConfigs = SOURCE_CONFIGS.filter((cfg) => {
    if (cfg.skipInCI && process.env.GITHUB_ACTIONS) {
      console.log(`[SKIP] ${cfg.label}: CI 主機(海外 IP)連不上此站,僅本地執行時抓取`);
      return false;
    }
    return true;
  });

  const results = await Promise.allSettled(activeConfigs.map((cfg) => cfg.fetch()));

  const allItems = [];
  results.forEach((result, i) => {
    const { label, track } = activeConfigs[i];
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

  const days = lookbackDays(weekday);
  const recentItems = filterRecent(uniqueItems, days);
  const rangeLabel = days === 2 ? "當日/前日" : `近 ${days} 日(週一補上週五~週日)`;
  console.log(`(只保留${rangeLabel}發布的項目:${uniqueItems.length} 筆 → ${recentItems.length} 筆)`);

  // 去重基準是「已推播」,不是「已處理」:這裡只是排除掉 90 天內已經推播過的項目,
  // 不管 Gemini 這次判斷結果如何,都要先送進 Gemini —— 真正決定要不要標記為已推播,
  // 要等 Gemini 判斷/精選完成之後才知道。
  let candidates = recentItems;
  try {
    candidates = await filterUnseenNotion(recentItems);
    console.log(`(排除 90 天內已推播過的項目:${recentItems.length} 筆 → ${candidates.length} 筆)`);
  } catch (err) {
    reportCritical(`Notion 去重查詢失敗,本次略過去重、視為全部未推播(可能導致重複推播): ${err.message}`);
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
    reportCritical(`Gemini 法令判斷失敗,略過此軌道: ${err.message}`);
  }

  console.log(`\n=== HR 情報站(${newsItems.length} 筆候選)===`);
  try {
    digestNews = await selectHrDigest(newsItems, { maxItems: 16 });
    console.log(`Gemini 精選完成,共 ${digestNews.length} 篇(上限 16)`);
    console.log(JSON.stringify(digestNews, null, 2));
    toMarkPushed.push(...digestNews);
  } catch (err) {
    reportCritical(`Gemini HR 情報站精選失敗,略過此軌道: ${err.message}`);
  }

  // 兩軌合併成單一則 LINE Flex Message(9:00 推播)
  const today = new Date().toISOString().slice(0, 10);
  const flexMessage = buildDailyFlexMessage({ lawItems: relevantLaw, newsItems: digestNews, date: today });
  console.log(`\n=== 9:00 推播內容(LINE Flex Message)===`);
  console.log(JSON.stringify(flexMessage, null, 2));
  writeFileSync("line-message.json", JSON.stringify(flexMessage, null, 2));

  // 標記「已推播」的時機是「LINE 推播成功後」才觸發,不是 Gemini 判斷完就標記 ——
  // 這樣如果推播全數失敗,這批項目下次執行還是「未推播」狀態,會被重新嘗試,不會憑空消失。
  // 部分成功(例如個人送達、群組失敗)時照常標記,避免隔天重複推給已收到的對象,
  // 失敗的對象用 reportCritical 讓 run 變紅、通知使用者。
  try {
    const { delivered, failed } = await pushLineMessage(flexMessage);
    console.log(`\n已推播到 LINE(${delivered.join("、")})`);
    for (const f of failed) {
      reportCritical(`LINE 推播到「${f.label}」失敗(其他對象已送達,此對象本次內容不會補送): ${f.error}`);
    }

    if (toMarkPushed.length > 0) {
      try {
        await markPushedNotion(toMarkPushed);
        console.log(`已寫入 ${toMarkPushed.length} 筆推播紀錄到 Notion`);
      } catch (err) {
        reportCritical(`Notion 寫入推播紀錄失敗(訊息已經推播成功,但去重紀錄沒寫入,下次會重複推播): ${err.message}`);
      }
    } else {
      // 空訊息日沒有內容項目可標記,寫一筆心跳紀錄,
      // 讓同一天的第二次觸發在開頭的檢查就知道已推過、直接結束
      try {
        await markPushedNotion([{ link: `heartbeat-${today}`, title: "📭 空訊息心跳紀錄", track: "news" }]);
        console.log("已寫入空訊息心跳紀錄到 Notion");
      } catch (err) {
        console.error(`(心跳紀錄寫入失敗,同一天若再次觸發可能重複發空訊息: ${err.message})`);
      }
    }
  } catch (err) {
    reportCritical(`LINE 推播失敗,本次不標記已推播,下次執行會重新嘗試這批項目: ${err.message}`);
  }

  // 每次執行都檢查一次,月初第一個工作日起就會把上個月的紀錄清掉,之後幾天查不到東西、幾乎不耗時。
  // 放在最後執行:去重查詢已經用完這次需要的紀錄,不會影響本次判斷。
  const purgeBefore = purgeCutoffIso(todayIso);
  try {
    const purged = await purgePushRecordsBefore(purgeBefore);
    if (purged > 0) console.log(`已刪除 ${purged} 筆 ${purgeBefore} 以前的 Notion 推播紀錄`);
  } catch (err) {
    reportCritical(`Notion 舊紀錄刪除失敗(不影響本次推播,下次執行會再試): ${err.message}`);
  }

  if (criticalFailures.length > 0) {
    console.error(`\n本次執行有 ${criticalFailures.length} 個關鍵步驟失敗(見上方 [FAIL]),以失敗狀態結束`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("執行失敗:", err);
  process.exit(1);
});
