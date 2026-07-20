// 本地測試用:模擬「兩軌都沒有新資訊」的情境,實際推播空內容訊息到 LINE。
// 執行:npm run test-empty(於 scraper/ 目錄)。會真的發一則訊息(耗 1 則月額度)。
import { loadEnv } from "./lib/loadEnv.js";
loadEnv();

import { buildDailyFlexMessage } from "./line/buildDailyMessage.js";
import { pushLineMessage } from "./line/pushMessage.js";

const today = new Date().toISOString().slice(0, 10);
const message = buildDailyFlexMessage({ lawItems: [], newsItems: [], date: today });

console.log("推播內容:");
console.log(JSON.stringify(message, null, 2));

const { delivered, failed } = await pushLineMessage(message);
console.log(`\n已推播到 LINE(${delivered.join("、")})`);
for (const f of failed) console.error(`推播到「${f.label}」失敗: ${f.error}`);
