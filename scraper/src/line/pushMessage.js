const PUSH_URL = "https://api.line.me/v2/bot/message/push";

// 推播對象:LINE_HR_USER_ID(HR 個人)+ LINE_STAFF_GROUP_ID(全員群組,選填)。
// 部分成功的語意:只要至少一個對象送達就回傳成功(讓去重標記照常寫入,避免
// 隔天重複推給已收到的對象),失敗的對象由呼叫端決定怎麼告警;全數失敗才拋錯。
export async function pushLineMessage(message) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) {
    throw new Error("缺少 LINE_CHANNEL_ACCESS_TOKEN 環境變數,請在 scraper/.env 設定後再執行");
  }

  const targets = [];
  if (process.env.LINE_HR_USER_ID) {
    targets.push({ label: "HR 個人", to: process.env.LINE_HR_USER_ID });
  }
  if (process.env.LINE_STAFF_GROUP_ID) {
    targets.push({ label: "全員群組", to: process.env.LINE_STAFF_GROUP_ID });
  }
  if (targets.length === 0) {
    throw new Error("缺少推播對象:LINE_HR_USER_ID 與 LINE_STAFF_GROUP_ID 至少要設定一個");
  }

  const delivered = [];
  const failed = [];

  for (const target of targets) {
    const res = await fetch(PUSH_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ to: target.to, messages: [message] }),
    });

    if (res.ok) {
      delivered.push(target.label);
    } else {
      const errText = await res.text();
      failed.push({ label: target.label, error: `HTTP ${res.status} - ${errText.slice(0, 200)}` });
    }
  }

  if (delivered.length === 0) {
    throw new Error(
      `LINE 推播全數失敗: ${failed.map((f) => `${f.label}: ${f.error}`).join(";")}`
    );
  }

  return { delivered, failed };
}
