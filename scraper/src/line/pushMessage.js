const PUSH_URL = "https://api.line.me/v2/bot/message/push";

// 呼叫 LINE Push API,把組好的 Flex Message 推送給指定的 userId
export async function pushLineMessage(flexMessage) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) {
    throw new Error("缺少 LINE_CHANNEL_ACCESS_TOKEN 環境變數,請在 scraper/.env 設定後再執行");
  }

  const userId = process.env.LINE_HR_USER_ID;
  if (!userId) {
    throw new Error("缺少 LINE_HR_USER_ID 環境變數,請在 scraper/.env 設定後再執行");
  }

  const res = await fetch(PUSH_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ to: userId, messages: [flexMessage] }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`LINE Push API 請求失敗: HTTP ${res.status} - ${errText.slice(0, 300)}`);
  }
}
