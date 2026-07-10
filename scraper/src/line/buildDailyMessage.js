// 把兩軌 Gemini 判斷結果組成一則 LINE Flex Message,兩軌合併成單一次 9:00 推播。
const CATEGORY_COLORS = {
  法規制度: "#235F4C",
  人資實務: "#35597A",
  管理議題: "#764161",
};

function scoreColor(score) {
  if (score >= 4) return "#A03F2C";
  if (score === 3) return "#C77B5E";
  return "#8C8C8C";
}

function lawItemBox(item) {
  const a = item.analysis || {};
  const contents = [
    {
      type: "box",
      layout: "baseline",
      spacing: "sm",
      contents: [
        {
          type: "text",
          text: `★${a.relevance_score ?? "-"}`,
          size: "xs",
          color: scoreColor(a.relevance_score || 0),
          weight: "bold",
          flex: 0,
        },
        { type: "text", text: a.summary || item.title, weight: "bold", size: "sm", wrap: true, flex: 1 },
      ],
    },
  ];

  if (a.affected) {
    contents.push({ type: "text", text: `影響對象:${a.affected}`, size: "xxs", color: "#888888", wrap: true });
  }
  if (a.effective_date) {
    contents.push({ type: "text", text: `生效日期:${a.effective_date}`, size: "xxs", color: "#888888" });
  }
  if (a.hr_suggestion) {
    contents.push({
      type: "text",
      text: `建議:${a.hr_suggestion}`,
      size: "xxs",
      color: "#235F4C",
      wrap: true,
      margin: "xs",
    });
  }

  return {
    type: "box",
    layout: "vertical",
    margin: "lg",
    spacing: "xs",
    action: { type: "uri", uri: item.link },
    contents,
  };
}

function newsItemBox(item) {
  return {
    type: "box",
    layout: "vertical",
    margin: "lg",
    spacing: "xs",
    action: { type: "uri", uri: item.link },
    contents: [
      { type: "text", text: item.category, size: "xxs", weight: "bold", color: CATEGORY_COLORS[item.category] || "#888888" },
      { type: "text", text: item.title, weight: "bold", size: "sm", wrap: true },
      { type: "text", text: item.pick_reason || "", size: "xxs", color: "#888888", wrap: true },
    ],
  };
}

// lawItems:勞動法令偵探判定 relevant 的項目(附 analysis 欄位)
// newsItems:HR 情報站精選入列的項目(附 category / pick_reason)
export function buildDailyFlexMessage({ lawItems, newsItems, date }) {
  const bodyContents = [
    { type: "text", text: "⚖️ 勞動法令偵探", weight: "bold", size: "md" },
  ];

  if (lawItems.length === 0) {
    bodyContents.push({ type: "text", text: "今日無相關法令異動", size: "xs", color: "#888888", margin: "md" });
  } else {
    [...lawItems]
      .sort((a, b) => (b.analysis?.relevance_score || 0) - (a.analysis?.relevance_score || 0))
      .forEach((item) => bodyContents.push(lawItemBox(item)));
  }

  bodyContents.push({ type: "separator", margin: "xl" });
  bodyContents.push({ type: "text", text: "📰 HR 情報站", weight: "bold", size: "md", margin: "xl" });

  if (newsItems.length === 0) {
    bodyContents.push({ type: "text", text: "今日無精選文章", size: "xs", color: "#888888", margin: "md" });
  } else {
    newsItems.forEach((item) => bodyContents.push(newsItemBox(item)));
  }

  const altText = `法規/HR情報 ${date}:法令偵探 ${lawItems.length} 則、情報站 ${newsItems.length} 篇`.slice(0, 400);

  return {
    type: "flex",
    altText,
    contents: {
      type: "bubble",
      header: {
        type: "box",
        layout: "vertical",
        backgroundColor: "#235F4C",
        paddingAll: "16px",
        contents: [
          { type: "text", text: "法規 / HR 情報站", color: "#FFFFFF", weight: "bold", size: "lg" },
          { type: "text", text: date, color: "#D7E9E0", size: "xs" },
        ],
      },
      body: {
        type: "box",
        layout: "vertical",
        contents: bodyContents,
      },
    },
  };
}
