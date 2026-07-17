// 模型名稱可用環境變數覆寫。gemini-2.0-flash 實測已無免費額度(quota limit: 0,應已停用),
// 改用 gemini-2.5-flash(實測正常回應)。模型會持續汰換,建議定期確認是否仍為最新/最合適的版本。
const DEFAULT_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

// 備援模型:主模型「模型級過載」時(2026-07-15 實測 gemini-2.5-flash 持續 503 數小時,
// 同一金鑰打 gemini-flash-latest 卻正常),重試等不到恢復,改打備援模型。
const FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || "gemini-flash-latest";

// 這些狀態碼是 Google 端的暫時性問題(過載/限流/內部錯誤),值得重試;
// 其他 4xx(如 400 參數錯、401 金鑰錯)重試也不會好,直接失敗、也不落到備援模型。
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const RETRIES = 3;
const RETRY_DELAYS_MS = [5000, 15000];

async function callModelJson(model, apiKey, body) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  let res;
  for (let attempt = 1; ; attempt++) {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (res.ok || !RETRYABLE_STATUS.has(res.status) || attempt >= RETRIES) break;

    console.log(`(${model} 回傳 HTTP ${res.status},${RETRY_DELAYS_MS[attempt - 1] / 1000} 秒後重試,第 ${attempt}/${RETRIES - 1} 次)`);
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt - 1]));
  }

  if (!res.ok) {
    const errText = await res.text();
    const error = new Error(`Gemini API 請求失敗(${model}): HTTP ${res.status} - ${errText.slice(0, 300)}`);
    error.retryable = RETRYABLE_STATUS.has(res.status);
    throw error;
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error(`Gemini 回傳格式異常(${model}),找不到內容: ${JSON.stringify(data).slice(0, 300)}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Gemini 回傳非合法 JSON(${model}): ${text.slice(0, 300)}`);
  }
}

export async function callGeminiJson({ prompt, schema }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("缺少 GEMINI_API_KEY 環境變數,請在 scraper/.env 設定後再執行");
  }

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: "application/json",
      ...(schema ? { responseSchema: schema } : {}),
    },
  };

  // 依序嘗試:主模型 → 備援模型。只有「暫時性錯誤重試用盡」才落到備援;
  // 參數錯、金鑰錯這類問題換模型也不會好,直接拋出。
  const models = [...new Set([DEFAULT_MODEL, FALLBACK_MODEL])];
  let lastErr;
  for (let i = 0; i < models.length; i++) {
    try {
      return await callModelJson(models[i], apiKey, body);
    } catch (err) {
      lastErr = err;
      if (!err.retryable || i === models.length - 1) throw err;
      console.log(`(${models[i]} 重試用盡仍失敗,改用備援模型 ${models[i + 1]})`);
    }
  }
  throw lastErr;
}
