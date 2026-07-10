import { callGeminiJson } from "../lib/gemini.js";

export const HR_DIGEST_CATEGORIES = ["法規制度", "人資實務", "管理議題"];

const RESPONSE_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      link: { type: "string" },
      category: { type: "string", enum: HR_DIGEST_CATEGORIES },
      reason: { type: "string" },
    },
    required: ["link", "category", "reason"],
  },
};

function buildPrompt(items, maxItems) {
  return `你是企業 HR 的法規/合規新聞編輯助理。以下是候選新聞/文章列表(JSON 陣列),請從中挑選出「最多 ${maxItems} 篇」符合下列範圍的文章,並分類到以下三大類之一:
${HR_DIGEST_CATEGORIES.join("、")}

**收錄範圍,只限以下兩種:**
1. 人事行政、勞資關係、員工權益相關的法規或新聞(例如:出勤/請假規定、工資與福利、勞動契約、職業安全衛生、性別平等工作、勞資爭議)
2. 管理層為了避免公司觸法而必須注意的相關法規或新聞(例如:新法規上路、裁罰案例、合規義務異動)

**明確排除,即使標題看起來像商業/職場相關也不要收錄:**
- 體育賽事、運動員報導(即使內容在討論心理素質、決策或自我管理)
- 名人傳記、企業家生平故事、職涯勵志文章
- 產品行銷、品牌經營、商業策略案例(除非直接涉及勞動法規遵循)
- AI 工具/軟體操作教學(如提示詞教學、效率工具介紹)
- 一般心理健康、自我成長、情緒調適等雞湯文(除非直接與員工假別、出勤、給薪等法規實務相關)
- 純個股財經消息、總體經濟或產業趨勢報導(海外設廠、外派人才市場、產業景氣分析等)

同一件事若在多篇候選中重複出現(例如同一則颱風假新聞被多個來源報導),只挑選其中資訊最完整的一篇,不要重複收錄。

對每篇入選的文章給出:
- link: 原始連結(需與輸入資料完全一致)
- category: 上述三大分類之一
- reason: 一句話說明為什麼符合收錄範圍

輸出必須是 JSON 陣列,最多 ${maxItems} 筆。**寧缺勿濫**:若候選內容中真正符合上述範圍的不足 ${maxItems} 篇,就只回傳實際數量,即使只有 1-2 篇甚至 0 篇也沒關係,絕對不要為了湊數而納入不符合範圍的內容。不要有其他文字或 markdown 標記。

候選資料:
${JSON.stringify(items, null, 2)}`;
}

// 輸入:去重後、尚未推播過的「HR 情報站」軌道項目(勞動部新聞稿 + 104職場力 + 經理人)
// 輸出:Gemini 挑選出的 ≤ maxItems 篇文章,附加 category / pick_reason
export async function selectHrDigest(items, { maxItems = 16 } = {}) {
  if (items.length === 0) return [];

  const picks = await callGeminiJson({
    prompt: buildPrompt(items, maxItems),
    schema: RESPONSE_SCHEMA,
  });

  const byLink = new Map(items.map((item) => [item.link, item]));

  return picks
    .filter((pick) => byLink.has(pick.link)) // 避免 Gemini 幻覺出不存在的 link
    .slice(0, maxItems)
    .map((pick) => ({
      ...byLink.get(pick.link),
      category: pick.category,
      pick_reason: pick.reason,
    }));
}
