// 模型名稱可用環境變數覆寫。gemini-2.0-flash 實測已無免費額度(quota limit: 0,應已停用),
// 改用 gemini-2.5-flash(實測正常回應)。模型會持續汰換,建議定期確認是否仍為最新/最合適的版本。
const DEFAULT_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

export async function callGeminiJson({ prompt, schema }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("缺少 GEMINI_API_KEY 環境變數,請在 scraper/.env 設定後再執行");
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_MODEL}:generateContent?key=${apiKey}`;

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: "application/json",
      ...(schema ? { responseSchema: schema } : {}),
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API 請求失敗: HTTP ${res.status} - ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error(`Gemini 回傳格式異常,找不到內容: ${JSON.stringify(data).slice(0, 300)}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Gemini 回傳非合法 JSON: ${text.slice(0, 300)}`);
  }
}
