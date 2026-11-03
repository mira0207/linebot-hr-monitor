// 去重紀錄存在 Notion database,取代原型階段的本地 JSON 檔(容器重啟會消失)。
// 判斷基準:只有「已推播」(Gemini 判定相關 / 精選入列)的項目才會寫入紀錄,
// 未入選的項目不標記,下次執行仍會被重新抓取、重新送進 Gemini 判斷。
// 保留期限:只留本月的紀錄,上個月(含更早)的由 index.js 每次執行結尾呼叫
// purgePushRecordsBefore() 自動刪除(見該處說明)。查詢時的 90 天條件是舊設計留下的保險,
// 實際上紀錄活不到 90 天。
const NOTION_VERSION = "2022-06-28";
const RETENTION_DAYS = 90;
const QUERY_BATCH_SIZE = 20;

function headers() {
  const apiKey = process.env.NOTION_API_KEY;
  if (!apiKey) {
    throw new Error("缺少 NOTION_API_KEY 環境變數,請在 scraper/.env 設定後再執行");
  }
  return {
    Authorization: `Bearer ${apiKey}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };
}

function databaseId() {
  const id = process.env.NOTION_DEDUPE_DATABASE_ID;
  if (!id) {
    throw new Error("缺少 NOTION_DEDUPE_DATABASE_ID 環境變數,請在 scraper/.env 設定後再執行");
  }
  return id;
}

function cutoffDateIso() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
  return cutoff.toISOString().slice(0, 10);
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// 過濾掉「90 天內已推播過」的項目;超過 90 天的舊紀錄視為過期,不列入已推播判斷
export async function filterUnseenNotion(items) {
  if (items.length === 0) return items;

  const seenLinks = new Set();

  for (const batch of chunk(items, QUERY_BATCH_SIZE)) {
    const res = await fetch(`https://api.notion.com/v1/databases/${databaseId()}/query`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        filter: {
          and: [
            { property: "Pushed At", date: { on_or_after: cutoffDateIso() } },
            { or: batch.map((item) => ({ property: "Link", title: { equals: item.link } })) },
          ],
        },
        page_size: 100,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Notion 查詢失敗: HTTP ${res.status} - ${errText.slice(0, 300)}`);
    }

    const data = await res.json();
    for (const page of data.results) {
      const link = page.properties?.Link?.title?.[0]?.plain_text;
      if (link) seenLinks.add(link);
    }
  }

  return items.filter((item) => !seenLinks.has(item.link));
}

// 查詢今天是否已有任何推播紀錄(含空訊息心跳)。
// 用途:排程可能一天觸發多次(cron-job.org 設有備用時間補救 GitHub API 偶發故障),
// 內容項目靠 link 去重擋重複,但「📭 今天無精選文章」心跳訊息沒有對應紀錄,
// 需要靠這個查詢判斷「今天已經推過了」而跳過,避免同一天發兩則空訊息。
export async function hasPushRecordTodayNotion() {
  const today = new Date().toISOString().slice(0, 10);
  const res = await fetch(`https://api.notion.com/v1/databases/${databaseId()}/query`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      filter: { property: "Pushed At", date: { equals: today } },
      page_size: 1,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Notion 查詢今日推播紀錄失敗: HTTP ${res.status} - ${errText.slice(0, 200)}`);
  }

  const data = await res.json();
  return data.results.length > 0;
}

// 標記為已推播:每個項目寫入一筆 Notion page
export async function markPushedNotion(items) {
  for (const item of items) {
    const res = await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        parent: { database_id: databaseId() },
        properties: {
          Link: { title: [{ text: { content: item.link } }] },
          Title: { rich_text: [{ text: { content: (item.title || "").slice(0, 200) } }] },
          Track: { select: { name: item.track === "law" ? "law" : "news" } },
          "Pushed At": { date: { start: new Date().toISOString().slice(0, 10) } },
        },
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Notion 寫入失敗 (${item.link}): HTTP ${res.status} - ${errText.slice(0, 300)}`);
    }
  }
}

// 清理舊紀錄:把 Pushed At 早於 beforeIso 的紀錄刪除(archive,移到 Notion 垃圾桶,
// 垃圾桶 30 天後由 Notion 自動永久刪除)。
// WORK DJ 的紀錄不刪:這個來源沒有發布日期、不經過當日/前日過濾,同幾篇文章會一直掛在列表頁,
// 唯一擋住重複推播的就是這裡的紀錄,刪掉的話下個月會被當成新文章再推一次。
export async function purgePushRecordsBefore(beforeIso) {
  let archived = 0;

  // 不用 start_cursor 翻頁:每刪掉一批,剩下的查詢結果就會往前移,用 cursor 會跳過資料。
  // 改成每次都重新查第一頁,直到查不到為止。
  for (;;) {
    const res = await fetch(`https://api.notion.com/v1/databases/${databaseId()}/query`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        filter: {
          and: [
            { property: "Pushed At", date: { before: beforeIso } },
            { property: "Link", title: { does_not_contain: "workdj.tw" } },
          ],
        },
        page_size: 100,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Notion 查詢舊紀錄失敗: HTTP ${res.status} - ${errText.slice(0, 300)}`);
    }

    const data = await res.json();
    if (data.results.length === 0) break;

    for (const page of data.results) {
      const archiveRes = await fetch(`https://api.notion.com/v1/pages/${page.id}`, {
        method: "PATCH",
        headers: headers(),
        body: JSON.stringify({ archived: true }),
      });
      // 刪除失敗要直接中斷,否則同一筆會一直出現在第一頁,變成無窮迴圈
      if (!archiveRes.ok) {
        const errText = await archiveRes.text();
        throw new Error(`Notion 刪除紀錄失敗(已刪 ${archived} 筆): HTTP ${archiveRes.status} - ${errText.slice(0, 200)}`);
      }
      archived++;
    }
  }

  return archived;
}
