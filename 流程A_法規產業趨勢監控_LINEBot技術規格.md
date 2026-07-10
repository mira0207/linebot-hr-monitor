# 流程 A:法規/產業趨勢監控與推播(LINE Bot 版)— 技術規格文件

> 本文件供 Claude Code 閱讀,協助實作 n8n workflow 與 LINE Bot 串接。若有欄位或邏輯需要調整,以實際需求為準,本文件為初版規格。

## 目標

自動監控勞動法令異動與人資產業趨勢,AI 判斷相關性並摘要,透過 LINE Bot 推送給 HR 審核;HR 確認後,由同一支 Bot 推送給全體員工所在的 LINE 群組。

系統分兩條軌道並行運作,**合併成單一次推播**,每日 09:00 一起發送給 HR(原規劃法令偵探 08:00、情報站週一至週五 09:00 兩個時間,已簡化為統一 09:00、每日執行):

| | HR 情報站 | 勞動法令偵探 |
|---|---|---|
| 資料來源 | 新聞、雜誌等 | 行政院公報 + 勞動部常見問答 |
| AI 處理 | Gemini 精選 ≤16 篇,分 3 大類 | Gemini 解讀法令影響與 HR 因應建議 |
| 同步寫入 | Notion 新聞資料庫(供後續評估) | — |
| 去重機制 | 已推播紀錄比對(Notion,90 天),不重複推播 | 同左 |
| 推播時間 | 每日 09:00(雙軌合併成一次推播) | 每日 09:00(雙軌合併成一次推播) |
| 推播對象 | HR 同仁 | HR 同仁 |

> 原規劃中「HR 確認後轉發全員群組」的下游流程(見下方資料流圖)暫不實作,目前先聚焦兩軌資料的抓取、AI 處理與推送給 HR 這一段。

---

## 一、整體資料流

```
【勞動法令偵探】                         【HR 情報站】
行政院公報 + 勞動部常見問答                新聞、雜誌等來源
        │                                      │
        ▼                                      ▼
        └──────────── n8n 排程觸發(每日 09:00)────────────┘
                                │
                                ▼
                    當日/前日過濾 + 去重(比對 Notion 已推播紀錄)
                                │
                ┌───────────────┴───────────────┐
                ▼                                ▼
    Gemini:解讀法令影響 + HR 因應建議      Gemini:精選 ≤16 篇,分 3 大類
                │                                │
                └───────────────┬───────────────┘
                                ▼
                    合併成單一則 LINE 訊息,推送給 HR
                                │
                                ▼
                    寫入 Notion(已推播紀錄 + 新聞資料庫)
```

> 待確認事項:HR 端後續是否仍需「確認轉發全員群組」的按鈕與 Postback 流程(見二、七章原始設計),暫定先不處理,以推送給 HR 為終點。

---

## 二、LINE Bot 前置設定

1. 到 [LINE Developers Console](https://developers.line.biz) 建立 **Provider**
2. 在該 Provider 下建立 **Messaging API Channel**(這是給程式呼叫用的,跟一般 LINE 官方帳號的圖文選單/群發功能是分開的頻道)
3. 取得以下兩組憑證,存入 n8n Credentials:
   - `Channel Access Token`(呼叫 Push API 用)
   - `Channel Secret`(驗證 Webhook 來源用)
4. 設定 **Webhook URL** 指向 n8n 的 webhook 節點網址(需 HTTPS,n8n 部署在 Hugging Face Spaces / Zeabur 上時網址本身已經是 HTTPS,不需額外處理)
5. 將 Bot 加為好友的 HR 帳號、以及「全員 LINE 群組」都要先把 Bot 拉進去,並取得對應的 `userId`(HR 個人)與 `groupId`(全員群組)

---

## 三、免費額度與設計考量(重要,會影響推播頻率設計)

- LINE 官方帳號輕用量方案為免費,**每月合計 500 則訊息額度**,Push(主動推播)與 Reply(webhook 內回覆)合計計算,超過額度需升級付費方案或訊息會被擋下。
- **Push 給個人(userId)**:每則計 1 筆額度。
- **Push 給群組(groupId)**:一次呼叫算 1 則,不會因為群組內有 70 人而乘以 70 — 這是本設計選擇「推給群組」而非逐一推給每位員工的主要原因,額度消耗會小非常多。
- 若一次 API 請求內包含多個訊息物件(最多 5 個,如文字+圖片+按鈕),仍只計 1 則。
- **額度試算**:HR 端每次摘要通知 1 則 + 全員群組廣播 1 則 = 每次流程約消耗 2 則額度。就算每天跑一次,一個月也只約 60 則,遠低於 500 則上限,不用擔心額度問題。

⚠️ 實作時建議在 n8n 加一個**每月額度監控**的簡單記錄(例如每次呼叫後在 Google Sheet 累加計數),避免哪天因為誤觸發或除錯測試把額度意外用超。

---

## 四、資料來源與爬取規格

### 4.1 兩軌資料來源總覽(已定案)

| 軌道 | 來源 | 爬取方式 | 狀態 |
|---|---|---|---|
| 勞動法令偵探 | 行政院公報(衛生勞動篇) | HTTP Request + HTML 解析 | ✅ 已驗證,可實際抓到當日更新資料 |
| 勞動法令偵探 | 勞動部常見問答 | HTTP Request + HTML 解析 | ✅ 已驗證 |
| 勞動法令偵探 | 勞動部勞動法令查詢系統「最新動態」 | HTTP Request + HTML 解析 | ✅ 已驗證,可實際抓到當日更新資料 |
| HR 情報站 | 勞動部新聞稿 | HTTP Request + HTML 解析 | ✅ 已驗證,可實際抓到當日更新資料 |
| HR 情報站 | 104職場力「人資充電」分類 | WordPress REST API | ✅ 已驗證,官方 API,穩定度較 HTML 爬取高 |
| HR 情報站 | 104職場力「勞動法令」分類 | WordPress REST API | ✅ 已驗證 |
| HR 情報站 | WORK DJ人力銀行「HR情報站」分類 | HTTP Request + HTML 解析 | ✅ 已驗證,但無可靠發布日期(見 4.2 節說明) |

以上七個來源皆已寫成 Node.js 爬蟲原型,位於 [scraper/src/sources](scraper/src/sources),可用 `npm start`(於 `scraper/` 目錄下)直接執行驗證。加上分頁邏輯後,實測共可抓到 120+ 筆不重複的當日/近期資料。

**已移除的來源:**經理人(managertoday.com.tw)—— 原本為了填補「新聞、雜誌」的一般管理類內容而加入,但實測發現不容易只挑出真正跟人事/勞資/員工權益相關的內容,常常連帶選進體育、名人傳記等不相關文章(見 5.3 節),故先移除,改用範圍更聚焦的 WORK DJ人力銀行 HR情報站。

**曾嘗試但排除的來源:**工商時報(ctee.com.tw)、Cheers 快樂工作人、1111 人力銀行 — 皆有反爬蟲保護回傳 HTTP 403;天下雜誌 — 403;遠見雜誌、104 職場趨勢 blog 舊網址 — 404。經濟日報(money.udn.com)雖可正常存取,但找不到穩定的勞動/人資專屬分類頁,抓到的多是不相關的一般財經新聞,故不採用。

### 4.2 各來源實際規格

**行政院公報([scraper/src/sources/gazette.js](scraper/src/sources/gazette.js))**
- URL:`https://gazette.nat.gov.tw/egFront/advancedSearchResult.do?action=doQuery&chapter=8&log=browseLog&clickfunc=0208`(`chapter=8` = 衛生勞動篇,混合衛福部與勞動部,程式以標題前綴 `勞動部` 過濾)
- Selector:`.List .List_Item` 為每筆項目;`p > a` 取標題與連結(相對路徑需組回絕對網址);`h4` 文字內含日期,以正規表示式 `\d{4}-\d{2}-\d{2}` 擷取;`.Tag` 為公告類型(如「行政規則」)
- 不需要特殊 Header 或 Referer 即可正常請求
- **不做分頁**:換頁動作(`action=doChangePage`)是 server-side session-based,實測直接呼叫會回傳「查詢已逾時,請重新輸入查詢條件」的 JS alert,而非資料;且此頁本身固定只回傳約 10 筆(過濾後約 4 筆勞動部項目),故暫維持只抓第一頁

**勞動部常見問答([scraper/src/sources/molFaq.js](scraper/src/sources/molFaq.js))**
- URL:`https://www.mol.gov.tw/1607/28690/2282/nodeListSearch`
- Selector:`.table_list table tbody tr` 為每筆項目,欄位順序為「項次、標題(`<a>`)、次分類、發布單位、發布日期、更新日期、點閱人氣」
- 分頁:`?Page=N&PageSize=10`,無狀態、不需 cookie,已串接,預設抓 3 頁(30 筆)

**勞動部勞動法令查詢系統([scraper/src/sources/molLaws.js](scraper/src/sources/molLaws.js))**
- URL:`https://laws.mol.gov.tw/`(勞動部自己維護的法令查詢系統「最新動態」頁,只收勞動法令,不像行政院公報混雜其他部會)
- Selector:`table.news-table tr`,欄位為「日期、類別、標題(`<a>`)+連結」
- **日期是民國年格式**(如 `115.07.09`),程式內用 `rocDateToIso()` 轉換成西元 `YYYY-MM-DD`(民國年 + 1911)
- 分頁:`?page=N`,無狀態、不需 cookie(雖然頁面本身是 ASP.NET WebForm,但分頁是走一般 GET query string,不是 `__doPostBack`),已串接,預設抓 3 頁(30 筆)
- **跟行政院公報有內容重疊**:同一則勞動部令/公告常常兩邊都會登,標題完全相同但連結不同,見 4.4 節的跨來源標題去重

**勞動部新聞稿([scraper/src/sources/molNews.js](scraper/src/sources/molNews.js))**
- URL:`https://www.mol.gov.tw/1607/1632/1633/`
- Selector:`.item_listblock .item_list2` 為每筆項目;`h3 a` 取標題與連結;`.data` 內文字用正規表示式取出「發布日期：YYYY-MM-DD」
- 分頁:`?Page=N&PageSize=10`,無狀態,已串接,預設抓 3 頁(30 筆)

**104職場力([scraper/src/sources/blog104.js](scraper/src/sources/blog104.js))**
- 改用 WordPress REST API,而非 HTML 爬取:`https://blog.104.com.tw/wp-json/wp/v2/posts?categories={id}&page=N&per_page=10&_fields=id,date,link,title,excerpt`
- 分類 ID:`人資充電`=187、`勞動法令`=195(透過 `/wp-json/wp/v2/categories?slug=xxx` 查得,若改版需重新確認)
- `title.rendered` / `excerpt.rendered` 為 HTML 片段,已用簡易正規表示式去標籤
- 分頁:超過總頁數時 API 回傳 HTTP 400,已在程式內判斷並視為「沒有更多資料」而停止,預設抓 2 頁 × 2 分類(共 40 筆)
- `robots.txt` 未禁止 `/wp-json/` 路徑

**WORK DJ人力銀行 HR情報站([scraper/src/sources/workdj.js](scraper/src/sources/workdj.js))**
- URL:`https://www.workdj.tw/products/index.php?group_id=8738`(人力派遣仲介公司的官網部落格分類)
- Selector:`ul.products-list li.item a`,`.name` 為標題,`href` 為相對路徑(需組回絕對網址)
- **沒有可靠的發布日期**:列表頁本身不顯示日期,文章詳情頁裡唯一出現的日期文字其實是「相關文章」推薦區塊的圖片 alt 文字,不是本篇文章自己的日期,HTTP 回應也沒有 `Last-Modified`。因此這個來源的項目一律 `published_at: null` + `dateUnknown: true`,在 [scraper/src/lib/dateFilter.js](scraper/src/lib/dateFilter.js) 裡略過「當日/前日」判斷,完全依賴 Notion 去重機制(六、去重機制)避免同一篇被重複推播
- 目前整個分類只有 2 篇文章,沒有分頁需求

### 4.3 分頁共用邏輯([scraper/src/lib/paginate.js](scraper/src/lib/paginate.js))

`fetchAllPages(fetchPage, pages)`:依序呼叫 `fetchPage(1..pages)`,若某一頁回傳空陣列就提前停止(避免對方最後一頁後繼續打空頁)。各來源的預設頁數皆可在呼叫時覆寫(如 `fetchMolNews({ pages: 5 })`)。

### 4.4 執行期去重(同一次執行內)

[scraper/src/index.js](scraper/src/index.js) 用 **標題**(不是連結)對同次執行結果去重,再送進「當日/前日」的時間過濾(4.5 節)。原本是用 `link` 去重,但新增「勞動部勞動法令查詢系統」後發現行政院公報跟這個來源常常登出同一則勞動部令/公告,標題完全相同、連結不同(不同網站),只用連結去重抓不到這種跨來源重複,因此改成用標題當 key。分頁造成的同站內重複(如原本經理人分頁重複的情況)也一併涵蓋在這個機制內。

### 4.5 當日/前日過濾([scraper/src/lib/dateFilter.js](scraper/src/lib/dateFilter.js))

`filterRecent(items, days = 2)`:只保留 `published_at` 落在「今天或昨天」範圍內的項目,沒有可辨識日期的項目直接排除 —— **除非**該項目標記 `dateUnknown: true`(目前只有 WORK DJ人力銀行使用,因為該站沒有可靠的發布日期,見 4.2 節),這種項目一律放行,完全依賴 Notion 去重機制(六、去重機制)避免重複推播。

這個過濾對各來源影響不同:
- 行政院公報、勞動部勞動法令查詢系統、勞動部新聞稿、104職場力本身就大致依發布時間排序,過濾後仍能保留當日/前日的更新
- **勞動部常見問答影響最大**:此頁面並非依日期排序(而是依內部項次/分類排序),套用過濾後實測經常從 30 筆降到 0 筆。這代表「常見問答」這個來源實質上只有在勞動部近期新增或更新問答時才會被抓到,平常大部分執行都會是 0 筆,屬預期行為而非爬蟲失效
- **WORK DJ人力銀行不受此過濾影響**(見上述 `dateUnknown` 機制)

### 4.6 去重機制(跨執行)

已改為 Notion database 持久化儲存,取代本地 JSON 檔原型,詳見「六、去重機制」。

### 4.7 設計原則(所有 HTTP 爬取來源共用)

- 只擷取「標題、連結、發布時間、摘要片段」,不轉載全文,降低版權疑慮
- 設定合理的 User-Agent 與請求頻率,避免高頻率重複請求同一頁面
- Selector 集中管理在各自的 source 模組,方便網站改版時快速調整
- 正式上線前需個別確認各站 `robots.txt` 是否禁止爬取該頁面

### 4.8 統一輸出格式(供後續 Gemini 判斷相關性使用)

```json
{
  "source": "來源名稱",
  "title": "標題",
  "link": "原始連結",
  "published_at": "發布時間(YYYY-MM-DD 或 null)",
  "summary": "摘要片段(非全文,目前原型皆為空字串,待補)",
  "category": "分類(依來源而定,可能為空字串)",
  "track": "law(勞動法令偵探) 或 news(HR 情報站),在 index.js 依來源標記"
}
```

---

## 五、Gemini 相關性判斷與摘要

原型已實作,位於 [scraper/src/gemini](scraper/src/gemini)。兩軌各自呼叫一次 Gemini,僅處理「去重後尚未推播過」的項目,避免重複耗用 API 額度。

### 5.1 共用呼叫層([scraper/src/lib/gemini.js](scraper/src/lib/gemini.js))

- 直接打 REST API:`POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`,用 `generationConfig.responseMimeType = "application/json"` + `responseSchema` 強制結構化輸出,不額外引入 SDK 套件
- 環境變數:`GEMINI_API_KEY`(必填)、`GEMINI_MODEL`(選填,預設 `gemini-2.0-flash`;此預設值應在實際串接前對照 Gemini 當時的可用模型清單重新確認)
- 讀取方式:[scraper/src/lib/loadEnv.js](scraper/src/lib/loadEnv.js) 會在程式啟動時讀取 `scraper/.env`(已加入 `.gitignore`,參考 [scraper/.env.example](scraper/.env.example) 建立)

### 5.2 勞動法令偵探([scraper/src/gemini/laborLawAnalysis.js](scraper/src/gemini/laborLawAnalysis.js))

- 輸入:去重後的行政院公報 + 勞動部常見問答項目,單次呼叫、批次送整批 JSON(目前實測規模約 30-40 筆,單次呼叫可負荷;若量體持續成長需評估是否要拆批)
- 輸出欄位:`relevant`(是否相關)、`relevance_score`(1-5)、`summary`(白話重點)、`affected`(受影響對象)、`effective_date`、`hr_suggestion`(HR 因應建議),並帶回原始 `link` 供比對
- 結果會附加在原始 item 的 `analysis` 欄位,`analysis === null` 代表 Gemini 回傳中找不到對應項目(理論上不應發生,除非模型漏答)

### 5.3 HR 情報站([scraper/src/gemini/hrDigestSelection.js](scraper/src/gemini/hrDigestSelection.js))

- 輸入:去重後的勞動部新聞稿 + 104職場力 + 經理人項目,單次呼叫送整批候選(套用 4.5 節當日/前日過濾後,實測規模約 20-25 筆)
- Gemini 從候選中「精選 ≤16 篇」,並分類到三大分類:**法規制度 / 人資實務 / 管理議題**(原規劃另有「產業趨勢」,已依需求先移除,不在目前收錄範圍內)
- **收錄範圍已收緊為兩類**:(1) 人事行政/勞資關係/員工權益相關法規或新聞,(2) 管理層為避免公司觸法而需注意的相關法規或新聞。明確排除體育賽事、名人傳記/職涯勵志文、產品行銷案例、AI 工具教學、一般心理健康雞湯文、純財經/產業趨勢報導,並強調「寧缺勿濫」——候選不足時只回傳實際符合數量,不硬湊到上限
  - 收緊前實測(22 筆候選)一度選出 11 篇,混入世足球員報導、名人傳記、AI 工具教學等明顯不相關內容,判定 Gemini 有「硬湊數量」傾向;收緊 prompt 後同一批候選只選出 3 篇,品質明顯改善(見 [scraper/run_output.txt](scraper/run_output.txt))
- 同一事件在多來源重複收錄時(如同一則颱風假新聞被 3 個來源都報導),只留資訊最完整的一篇
- 輸出:入選項目附加 `category`、`pick_reason`(一句話說明為何入選)

### 5.4 錯誤處理

兩軌都用 try/catch 包住,任一軌道呼叫失敗(如缺少 API Key、回傳非合法 JSON)只會讓該軌道略過,不會讓整支程式中斷,呼應「九、測試計畫」中「Gemini API 回傳非預期格式需有 fallback」的要求。實測(無 API Key)已確認:爬蟲階段正常完成並印出各來源筆數,兩個 Gemini 階段各自印出清楚的失敗訊息並繼續往下跑完。

相關待確認事項已併入「十、待確認事項」。

---

## 六、去重機制

原型已從本地 JSON 檔改為 Notion database,位於 [scraper/src/lib/notionDedupe.js](scraper/src/lib/notionDedupe.js)。

### 6.1 判斷基準:「已推播」才標記

去重的判斷基準不是「抓取到 / 處理過」,而是「Gemini 判定相關(勞動法令偵探)或精選入列(HR 情報站)才算數」。未入選的項目不會被標記,下次執行只要還在「當日/前日」的時間窗內,會被重新抓取、重新送進 Gemini 判斷 —— 好處是不會因為 Gemini 一次誤判就永久漏掉真正重要的項目,代價是同一筆資料可能被 Gemini 重複判斷、多花一點 API 額度。

實作上([scraper/src/index.js](scraper/src/index.js)):
1. 執行一開始先呼叫 `filterUnseenNotion()`,排除掉 90 天內已經標記過的項目,取得「候選名單」送進 Gemini
2. 兩軌 Gemini 判斷/精選完成後,只把「勞動法令偵探判定 relevant 的項目」+「HR 情報站精選入列的項目」丟給 `markPushedNotion()` 寫入 Notion

> ⚠️ 目前 `markPushedNotion()` 是在 Gemini 判斷完成後就呼叫,還不是「LINE 推播成功後」才呼叫 —— 因為 LINE Push 節點尚未接上。等 Push 串接後,應該把標記時機挪到推播成功的 callback 裡,才能真正做到「已推播」才算數,而不是「已判定要推播」就算數(兩者目前結果相同,但語意上有差異,萬一 Push 失敗目前的寫法會誤標記)。

### 6.2 儲存位置:Notion database

改用 Notion 是因為使用者需要能直接開資料庫查看歷史推播紀錄,不需要額外介面。**使用前需要手動建立以下設定**(比照二、LINE Bot 前置設定的模式):

1. 到 [Notion 我的整合](https://www.notion.so/my-integrations) 建立一個新的 internal integration,取得 `NOTION_API_KEY`(格式類似 `ntn_...` 或 `secret_...`)
2. 在 Notion 裡建立一個新的 database,需要以下欄位(欄位名稱需完全一致,程式是照名稱寫入的):

| 欄位名稱 | 型別 | 用途 |
|---|---|---|
| `Link` | Title | 文章原始連結,當作唯一鍵比對用 |
| `Title` | Rich text | 文章標題,方便人工在 Notion 裡瀏覽 |
| `Track` | Select(選項:`law`、`news`) | 屬於哪一軌 |
| `Pushed At` | Date | 標記為已推播的日期,去重跟 90 天保留期限都靠這欄位判斷 |

3. 把這個 database 分享給剛剛建立的 integration(database 右上角 `...` → `Connections` → 加入該 integration),否則 API 會回傳權限錯誤
4. 從 database 的網址列複製 database ID(網址中 `notion.so/xxxxx?v=...` 的 `xxxxx` 那段,32 碼英數字),存成 `NOTION_DEDUPE_DATABASE_ID`

### 6.3 保留期限:90 天

`filterUnseenNotion()` 查詢時只比對 `Pushed At` 在 90 天內的紀錄,超過 90 天的舊紀錄不會被當成「已推播」,對應項目下次抓到會被視為未推播過(但實務上因為有「當日/前日過濾」,90 天前的舊資料本來就不會再被抓到,這個保留期限主要是避免資料庫無限累積)。

真正的清理(把過期紀錄封存)由 `purgeExpiredPushRecords()` 負責,**不會**在一般執行流程中自動觸發,需要另外排一個低頻率排程(例如每週一次)呼叫。

### 6.4 錯誤處理

`filterUnseenNotion()` 若失敗(如憑證未設定、Notion API 錯誤),會在 index.js 被 catch 住,退回「本次不做去重、視為全部未推播」,不會讓整支程式中斷;`markPushedNotion()` 失敗則只記錄錯誤,不影響已經印出的 Gemini 判斷結果。

---

## 七、n8n Workflow 節點規格

> ⚠️ 本章是最初的 n8n 節點規劃,寫於實際動手爬取/串接 Gemini/Notion 之前,部分細節(單軌設計、Google Sheet 存 `summary_id`、Gemini 輸出格式)已經跟四~六章實際跑通的 Node.js 原型不一致。**目前的「事實來源」是 scraper/ 目錄下的程式碼**,尤其 [scraper/src/line/buildDailyMessage.js](scraper/src/line/buildDailyMessage.js) 已經把兩軌 Gemini 結果組成單一則 LINE Flex Message(見下方 7.1 節)。這裡先保留原始規劃供參考,等要正式搬進 n8n 時再依實際程式邏輯重寫這一章。

### 7.1 目前已驗證的 9:00 合併推播訊息(取代原本的 Workflow 1 摘要格式)

[scraper/src/line/buildDailyMessage.js](scraper/src/line/buildDailyMessage.js) 的 `buildDailyFlexMessage({ lawItems, newsItems, date })` 把「勞動法令偵探判定相關的項目」+「HR 情報站精選項目」組成**單一則** LINE Flex Message(bubble 型態):

- Header:深綠色底,顯示標題與日期
- Body 分兩區塊:「⚖️ 勞動法令偵探」(依 `relevance_score` 由高到低排序,每則顯示星等分數、Gemini 摘要、影響對象、生效日期、HR 建議)、「📰 HR 情報站」(依分類顯示標題與入選原因)
- 每個項目的 box 都掛 `action: { type: "uri", uri: item.link }`,點擊可直接開啟原文
- `index.js` 執行完會把組好的訊息印出來,並寫成 [scraper/line-message.json](scraper/line-message.json)

**目前還沒做的**:實際呼叫 LINE Push API 把這則訊息送出去。現在的原型只有「組出訊息 + 印出來」,還沒有 `HTTP Request → api.line.me/v2/bot/message/push` 這一步,也還沒有排程(cron)自動在每天 9:00 觸發整支流程。

### Workflow 1:監控 → 摘要 → 推送給 HR(原始規劃,細節已過時,見上方提示)

| 節點 | 功能 |
|---|---|
| Schedule Trigger | 每日/每週固定時間觸發 |
| RSS Feed Read / Email Trigger(讀 Google Alerts 通知信) | 抓取新內容 |
| IF | 過濾明顯不相關內容,減少 LLM 呼叫次數 |
| HTTP Request(呼叫 Gemini API) | 相關性判斷 + 摘要,輸出結構化 JSON |
| IF(相關性分數 ≥ 門檻) | 低於門檻直接結束,不推播 |
| Code 節點 | 組成 LINE Flex Message JSON(見下方範例),並產生一組 `summary_id` 存入 Google Sheet(暫存摘要內容,供 Postback 後取用) |
| HTTP Request(呼叫 LINE Push API) | 推送 Flex Message 給 HR 的 `userId` |

**Gemini 摘要輸出格式建議:**
```json
{
  "relevance_score": 1-5,
  "title": "一句話說明異動內容",
  "affected": "影響對象",
  "effective_date": "生效日期",
  "suggestion": "建議動作(判斷不出來就留空字串)"
}
```

**LINE Push API 呼叫範例(推給 HR,含確認按鈕):**
```json
POST https://api.line.me/v2/bot/message/push
Headers: Authorization: Bearer {{$credentials.lineChannelAccessToken}}

{
  "to": "{{$json.hrUserId}}",
  "messages": [
    {
      "type": "flex",
      "altText": "法規/趨勢更新摘要",
      "contents": {
        "type": "bubble",
        "body": {
          "type": "box",
          "layout": "vertical",
          "contents": [
            { "type": "text", "text": "{{$json.title}}", "weight": "bold", "wrap": true },
            { "type": "text", "text": "影響對象:{{$json.affected}}", "wrap": true, "size": "sm" },
            { "type": "text", "text": "生效日期:{{$json.effective_date}}", "wrap": true, "size": "sm" }
          ]
        },
        "footer": {
          "type": "box",
          "layout": "vertical",
          "contents": [
            {
              "type": "button",
              "action": {
                "type": "postback",
                "label": "確認,轉發給全員",
                "data": "action=confirm_broadcast&summary_id={{$json.summary_id}}"
              }
            }
          ]
        }
      }
    }
  ]
}
```

### Workflow 2:接收 HR 確認 → 推送全員群組

| 節點 | 功能 |
|---|---|
| Webhook 節點 | 接收 LINE 平台送來的事件(需先驗證 `X-Line-Signature`,用 Channel Secret 做 HMAC-SHA256 驗證,避免偽造請求) |
| IF | 判斷 `events[0].type === "postback"` 且 `data` 開頭為 `action=confirm_broadcast` |
| Code 節點 | 解析 `data` 取出 `summary_id`,回頭查 Google Sheet 取出當初暫存的完整摘要內容 |
| HTTP Request(呼叫 LINE Push API) | `to` 改為 `groupId`(全員群組),推送整理好的摘要文字 |
| Google Sheets 節點 | 更新該筆記錄狀態為「已轉發」,記錄轉發時間 |

---

## 八、環境變數 / Credentials 清單

| 名稱 | 用途 |
|---|---|
| `LINE_CHANNEL_ACCESS_TOKEN` | 呼叫 LINE Push API |
| `LINE_CHANNEL_SECRET` | 驗證 Webhook 簽章 |
| `LINE_HR_USER_ID` | HR 個人帳號的 userId,接收待確認摘要 |
| `LINE_STAFF_GROUP_ID` | 全員 LINE 群組的 groupId,廣播用 |
| `GEMINI_API_KEY` | 呼叫 Gemini API 做判斷/摘要(scraper 原型見 [scraper/.env.example](scraper/.env.example)) |
| `GEMINI_MODEL` | 選填,指定 Gemini 模型名稱,預設 `gemini-2.5-flash` |
| `NOTION_API_KEY` | 去重紀錄用,Notion internal integration 的 token(見六、2 節設定步驟) |
| `NOTION_DEDUPE_DATABASE_ID` | 去重紀錄要寫入的 Notion database ID |
| `GOOGLE_SHEETS_CREDENTIALS` | 暫存摘要內容、記錄推播狀態(n8n Workflow 用,與 scraper 的去重機制是不同用途) |

---

## 九、測試計畫

1. **Webhook 簽章驗證測試**:故意送一個沒有正確簽章的假請求,確認會被擋下,不會誤觸發推播
2. **額度試算驗證**:先在 LINE Official Account Manager → 分析 → 訊息,確認目前帳號額度使用狀況,再開始跑排程
3. **Flex Message 顯示測試**:先用假摘要資料測試 Flex Message 在手機上的排版是否正常(文字過長是否會被截斷)
4. **端對端測試**:模擬一則有效的法規更新資料,跑過「摘要→推HR→HR點確認→推全員群組」完整流程,確認 `summary_id` 對應正確、群組收到的內容跟原始摘要一致
5. **邊界情境**:
   - Gemini API 回傳非預期格式 → 需有 fallback,不讓整條流程中斷
   - HR 遲遲沒點確認按鈕 → Google Sheet 暫存記錄需要有過期/提醒機制(例如 3 天沒確認,系統再提醒一次)

---

## 十、待確認事項

- [ ] 「全員 LINE 群組」是否已經存在且穩定(避免用個人建立的群組,人員異動時容易失聯,建議用公司官方管理的群組或改用 LINE 官方帳號的社群功能)—— 目前暫不實作轉發全員的下游流程,待確認是否仍需要
- [ ] HR 是否需要「編輯摘要內容」的權限,而不是只能「確認/不確認」二選一
- [ ] 相關性分數門檻值定多少合適,建議 Pilot 階段先用寬鬆門檻觀察實際判斷品質,再逐步收斂(勞動法令偵探已有 `relevance_score` 1-5 分,門檻值待實測後決定)
- [ ] 分頁已完成四個來源(常見問答、勞動法令查詢系統、新聞稿、104職場力各抓 2-3 頁);行政院公報因換頁為 session-based 且逾時,暫維持單頁,若需要更完整歷史資料需另外評估作法
- [ ] 若日後想擴充工商時報、Cheers、1111 人力銀行等來源,需評估是否用無頭瀏覽器繞過反爬蟲保護,以及對方使用條款是否允許,目前先不處理
- [x] 新增「勞動部勞動法令查詢系統」(law 軌)、「WORK DJ人力銀行 HR情報站」(news 軌)兩個來源,並移除「經理人」(選文品質不穩定,詳見 4.1 節)
- [x] 行政院公報跟勞動部勞動法令查詢系統內容重疊(常登出同一則公告)的問題已解決:去重 key 從 `link` 改成 `title`(見 4.4 節)
- [ ] WORK DJ人力銀行目前只有 2 篇文章、且無法取得可靠發布日期,規模變大或這兩個限制之一改變時需要重新評估這個來源的爬取方式是否要調整
- [x] `GEMINI_API_KEY` 已取得並實測跑通,勞動法令偵探、HR 情報站兩軌皆正常運作,輸出品質已人工檢視(見 [scraper/run_output.txt](scraper/run_output.txt))
- [x] `GEMINI_MODEL` 預設值已確認:`gemini-2.0-flash` 實測免費額度為 0(應已停用),改為 `gemini-2.5-flash` 後正常,已更新程式碼預設值
- [x] 去重機制已改為 Notion database(見六、去重機制),判斷基準改為「已推播才標記」,保留期限 90 天
- [x] `NOTION_API_KEY`、`NOTION_DEDUPE_DATABASE_ID` 已取得並實測跑通,查詢/寫入/schema 都驗證正確
- [x] HR 情報站的 prompt 已收緊為「人事/勞資/員工權益法規」+「管理層避免觸法需注意的新聞」兩類範圍,並強調寧缺勿濫(見 5.3 節,收緊前後對照實測結果)
- [x] 兩軌推播時間已簡化為統一每日 09:00、合併成單一則訊息(見目標章節表格與一、整體資料流)
- [x] 已組出實際的 LINE Flex Message 並用真實資料模擬過 9:00 會收到的訊息內容(見 [scraper/src/line/buildDailyMessage.js](scraper/src/line/buildDailyMessage.js)、7.1 節)
- [ ] `markPushedNotion()` 目前是在 Gemini 判斷/精選完成後就呼叫,還不是「LINE 推播成功後」才呼叫,等 Push 節點接上後需要把標記時機挪過去(見 6.1 節說明)
- [ ] `purgeExpiredPushRecords()`(清掉超過 90 天的 Notion 舊紀錄)尚未排程,需另外安排低頻率排程執行
- [ ] **實際呼叫 LINE Push API 尚未串接**:目前只有組出 Flex Message JSON 並印出/存檔,還沒有真的呼叫 `api.line.me/v2/bot/message/push` 送出去,也還沒有 `LINE_HR_USER_ID` 可以測試實際推播
- [ ] 每日 09:00 自動觸發的排程(cron)尚未設定,目前都是手動執行 `node src/index.js`
- [ ] Flex Message 目前是單一 bubble,若某天項目數量變多(尤其 HR 情報站精選到 16 篇上限),bubble 會拉得很長,需要實機在 LINE App 測試顯示效果是否可接受,必要時改用 carousel 分頁
- [ ] 勞動法令偵探/HR 情報站目前都是單次批次呼叫 Gemini,若未來候選量體變大,需評估是否要拆批呼叫(避免單次 prompt 過長或超出輸出 token 限制)
