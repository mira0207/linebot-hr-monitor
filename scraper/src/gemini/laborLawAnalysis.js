import { callGeminiJson } from "../lib/gemini.js";

const RESPONSE_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      link: { type: "string" },
      relevant: { type: "boolean" },
      relevance_score: { type: "integer" },
      summary: { type: "string" },
      affected: { type: "string" },
      effective_date: { type: "string" },
      hr_suggestion: { type: "string" },
    },
    required: ["link", "relevant", "relevance_score", "summary", "affected", "hr_suggestion"],
  },
};

function buildPrompt(items) {
  return `你是台灣企業 HR 的法規顧問助理。以下是從行政院公報與勞動部常見問答抓到的原始資料(JSON 陣列),請針對「是否與企業人事、勞資關係、員工權益管理直接相關」逐筆判斷,並給出:

- relevant: 是否與 HR 實務直接相關(布林值)
- relevance_score: 1-5 分,5 分表示非常重要、需要立即讓 HR 注意,1 分表示幾乎無關
- summary: 用一句話白話說明這則異動或問答的重點,不要照抄原標題
- affected: 受影響的對象(例如:全體員工、輪班人員、派遣員工等),無法判斷時留空字串
- effective_date: 生效日期,原始資料若有明確日期就沿用,無法判斷時留空字串
- hr_suggestion: 給 HR 的具體因應建議,無法判斷時留空字串

請針對輸入的「每一筆」資料都回傳一筆結果,並在結果中帶回原始的 link 欄位以便比對,不要遺漏、不要新增不存在的項目。輸出必須是 JSON 陣列,不要有其他文字或 markdown 標記。

原始資料:
${JSON.stringify(items, null, 2)}`;
}

// 輸入:去重後、尚未推播過的「勞動法令偵探」軌道項目(gazette + molFaq)
// 輸出:每筆原始 item 附加 analysis 欄位(Gemini 判斷結果),analysis 為 null 代表該筆未取得有效判斷結果
export async function analyzeLaborLawItems(items) {
  if (items.length === 0) return [];

  const results = await callGeminiJson({ prompt: buildPrompt(items), schema: RESPONSE_SCHEMA });
  const byLink = new Map(results.map((r) => [r.link, r]));

  return items.map((item) => {
    const { link: _omit, ...analysis } = byLink.get(item.link) || {};
    return { ...item, analysis: byLink.has(item.link) ? analysis : null };
  });
}
