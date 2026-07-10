// 去重紀錄存在 Notion database,取代原型階段的本地 JSON 檔(容器重啟會消失)。
// 判斷基準:只有「已推播」(Gemini 判定相關 / 精選入列)的項目才會寫入紀錄,
// 未入選的項目不標記,下次執行仍會被重新抓取、重新送進 Gemini 判斷。
// 保留期限:90 天,超過的紀錄視為過期(不影響去重判斷),需要另外呼叫
// purgeExpiredPushRecords() 做實際清理,不會在一般執行流程中自動觸發。
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

// 維護用:清掉超過保留期限的紀錄(archive)。不在一般執行流程自動呼叫,
// 建議另外排一個低頻率的排程(例如每週一次)執行。
export async function purgeExpiredPushRecords() {
  let archived = 0;
  let cursor;

  do {
    const res = await fetch(`https://api.notion.com/v1/databases/${databaseId()}/query`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        filter: { property: "Pushed At", date: { before: cutoffDateIso() } },
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}),
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Notion 查詢過期紀錄失敗: HTTP ${res.status} - ${errText.slice(0, 300)}`);
    }

    const data = await res.json();

    for (const page of data.results) {
      const archiveRes = await fetch(`https://api.notion.com/v1/pages/${page.id}`, {
        method: "PATCH",
        headers: headers(),
        body: JSON.stringify({ archived: true }),
      });
      if (archiveRes.ok) archived++;
    }

    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);

  return archived;
}
