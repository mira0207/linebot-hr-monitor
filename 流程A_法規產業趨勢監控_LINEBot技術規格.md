# 流程 A:法規/HR情報監控與推播(LINE Bot 版)— 技術規格文件

> 本文件記錄實際已經跑通的系統,不是規劃草案。程式碼是唯一事實來源,本文件描述程式碼在做什麼、為什麼這樣做、以及已知的限制。

## 目標

自動監控勞動法令異動與 HR 相關新聞,AI 判斷相關性並摘要,每天固定時間透過 LINE Bot 推送給 HR。

## 系統狀態

**目前階段:測試觀察中,尚未正式宣告上線。**

程式碼已經全部跑通(爬取 → 去重 → Gemini 判斷 → LINE 推播 → 寫回去重紀錄)。自動觸發改用外部 cron-job.org 每日 09:10 呼叫 GitHub Actions(GitHub 自己的排程實測不可靠,見七、1 節),明天起觀察是否穩定。計畫先觀察幾天實際推播的內容品質與穩定度,確認沒問題後正式宣告上線(見「九、上線前檢查清單」)。

---

## 一、整體架構與資料流

```
七個資料來源(見二)
        │
        ▼
GitHub Actions 排程觸發(每日 09:00 台灣時間)
        │
        ▼
同次執行內去重(依標題,見 2.3 節)
        │
        ▼
當日/前日過濾(見三)
        │
        ▼
排除 90 天內已推播過的項目(Notion 查詢,見四)
        │
        ├──────────────┬──────────────┐
        ▼                              ▼
勞動法令偵探軌                   HR 情報站軌
Gemini:相關性判斷                Gemini:精選 ≤16 篇、分 3 類
+ HR 因應建議                    (見五)
(見五)
        │                              │
        └──────────────┬──────────────┘
                        ▼
        兩軌合併成單一則 LINE Flex Message(見六)
                        │
                        ▼
              呼叫 LINE Push API 推播
                        │
              ┌─────────┴─────────┐
              ▼(推播成功)          ▼(推播失敗)
      寫入 Notion 已推播紀錄    不寫入,下次執行重新嘗試
```

**原本規劃是用 n8n 串接**(見文件初版),實際動手後改成直接寫 Node.js 程式(位於 [scraper/](scraper)),理由是爬蟲邏輯(selector、分頁、日期格式轉換等)需要頻繁除錯調整,用程式碼比用 n8n 節點更快迭代。部署方式也從「n8n on Zeabur/HF Spaces」改成「GitHub Actions 排程」,因為現在的邏輯是無狀態的(去重狀態在 Notion,不需要常駐伺服器),排程執行完就結束,不需要一台一直開著的機器。

**HR 確認後轉發全員群組的下游流程(文件最初有規劃)目前不實作**,系統做到「推播給 HR」為止。

---

## 二、資料來源

### 2.1 來源清單

| 軌道 | 來源 | 程式檔案 | 爬取方式 |
|---|---|---|---|
| 勞動法令偵探 | 行政院公報(衛生勞動篇) | [scraper/src/sources/gazette.js](scraper/src/sources/gazette.js) | HTTP + HTML 解析 |
| 勞動法令偵探 | 勞動部常見問答 | [scraper/src/sources/molFaq.js](scraper/src/sources/molFaq.js) | HTTP + HTML 解析,分頁 |
| 勞動法令偵探 | 勞動部勞動法令查詢系統「最新動態」 | [scraper/src/sources/molLaws.js](scraper/src/sources/molLaws.js) | HTTP + HTML 解析,分頁 |
| HR 情報站 | 勞動部新聞稿 | [scraper/src/sources/molNews.js](scraper/src/sources/molNews.js) | HTTP + HTML 解析,分頁 |
| HR 情報站 | 104職場力「人資充電」「勞動法令」分類 | [scraper/src/sources/blog104.js](scraper/src/sources/blog104.js) | WordPress REST API,分頁 |
| HR 情報站 | WORK DJ人力銀行「HR情報站」分類 | [scraper/src/sources/workdj.js](scraper/src/sources/workdj.js) | HTTP + HTML 解析,無日期 |

**曾經加入後又移除:**經理人(managertoday.com.tw)—— 選文品質不穩定,Gemini 常常連帶選進體育、名人傳記、產品行銷案例等不相關內容(見五、3 節)。

**曾嘗試但排除:**工商時報、Cheers 快樂工作人、1111 人力銀行、天下雜誌 — 反爬蟲保護回傳 403;遠見雜誌、104 職場趨勢 blog 舊網址 — 404;經濟日報(money.udn.com)— 可存取但沒有穩定的勞動/人資專屬分類頁。

### 2.2 各來源細節

**行政院公報**
- URL:`https://gazette.nat.gov.tw/egFront/advancedSearchResult.do?action=doQuery&chapter=8&log=browseLog&clickfunc=0208`(`chapter=8` = 衛生勞動篇,混合衛福部與勞動部,程式以標題前綴 `勞動部` 過濾)
- Selector:`.List .List_Item`;`p > a` 取標題與連結;`h4` 含日期;`.Tag` 為公告類型
- **不做分頁**:換頁動作是 server-side session-based,直接呼叫會回傳「查詢已逾時」而非資料;且此頁固定只回傳約 10 筆(過濾後約 4 筆勞動部項目),故只抓第一頁

**勞動部常見問答**
- URL:`https://www.mol.gov.tw/1607/28690/2282/nodeListSearch`
- Selector:`.table_list table tbody tr`,欄位為「項次、標題、次分類、發布單位、發布日期、更新日期、點閱人氣」
- 分頁:`?Page=N&PageSize=10`,無狀態,預設抓 3 頁
- 這個頁面不是依日期排序(依內部項次/分類排序),套用「當日/前日過濾」後經常變成 0 筆,屬預期行為

**勞動部勞動法令查詢系統**
- URL:`https://laws.mol.gov.tw/`(勞動部自己維護,只收勞動法令,不像行政院公報混雜其他部會)
- Selector:`table.news-table tr`,欄位為「日期、類別、標題」
- **日期是民國年格式**(如 `115.07.09`),程式內 `rocDateToIso()` 轉換成西元 `YYYY-MM-DD`
- 分頁:`?page=N`,雖然頁面是 ASP.NET WebForm,但分頁走一般 GET query string、不需要 session,預設抓 3 頁
- **跟行政院公報內容常重疊**(同一則勞動部令兩邊都登,標題完全相同、連結不同)——這是 2.3 節「用標題去重」的由來
- **⚠️ 此來源在 GitHub Actions 上一律跳過(`skipInCI`)**:此站為政府自建主機(`124.199.82.82`,無 CDN),封鎖海外 IP——本地(台灣 IP)從未失敗,CI(美國 IP)每次 `ETIMEDOUT`(對方完全不回應,2026-07-14 由重試+錯誤原因輸出確診)。曾評估全國法規資料庫(law.moj.gov.tw)作替代,但它也是政府網路(GSN)直連主機,預期同樣被擋。CI 環境的法令覆蓋由行政院公報(Cloudflare)與 104職場力勞動法令分類(Cloudflare)承擔;此來源僅在本地執行時抓取

**勞動部新聞稿**
- URL:`https://www.mol.gov.tw/1607/1632/1633/`
- Selector:`.item_listblock .item_list2`;`h3 a` 取標題連結;`.data` 內文字取「發布日期：YYYY-MM-DD」
- 分頁:`?Page=N&PageSize=10`,無狀態,預設抓 3 頁

**104職場力**
- 改用 WordPress REST API,不用 HTML 爬取:`https://blog.104.com.tw/wp-json/wp/v2/posts?categories={id}&page=N&per_page=10&_fields=id,date,link,title,excerpt`
- 分類 ID:`人資充電`=187、`勞動法令`=195(若改版需重新查 `/wp-json/wp/v2/categories?slug=xxx`)
- 分頁:超過總頁數時回傳 HTTP 400,程式判斷為「沒有更多資料」,預設抓 2 頁 × 2 分類

**WORK DJ人力銀行 HR情報站**
- URL:`https://www.workdj.tw/products/index.php?group_id=8738`(人力派遣仲介公司的部落格分類)
- Selector:`ul.products-list li.item a`,`.name` 為標題
- **沒有可靠的發布日期**:列表頁不顯示日期,文章詳情頁裡唯一出現的日期其實是「相關文章」推薦區塊的圖片說明文字,不是本篇文章的日期。因此這個來源的項目一律 `published_at: null` + `dateUnknown: true`,略過「當日/前日」判斷,完全依賴 Notion 去重機制避免重複推播
- 目前整個分類只有 2 篇文章,沒有分頁需求

### 2.3 去重與過濾邏輯(執行期)

實作於 [scraper/src/index.js](scraper/src/index.js):

1. **同次執行內去重,用標題當 key**:七個來源抓回來的項目先用 `title` 去重(不是用 `link`)。原因是行政院公報跟勞動法令查詢系統常登出同一則公告,標題完全相同但連結不同,只用連結去重抓不到這種跨來源重複
2. **當日/前日過濾**([scraper/src/lib/dateFilter.js](scraper/src/lib/dateFilter.js)):`filterRecent(items, days = 2)` 只保留 `published_at` 落在今天或昨天的項目,沒有日期的項目排除,除非該項目標記 `dateUnknown: true`(目前只有 WORK DJ)
3. **分頁邏輯**([scraper/src/lib/paginate.js](scraper/src/lib/paginate.js)):`fetchAllPages(fetchPage, pages)` 依序抓多頁,某頁回傳空陣列就提前停止

**設計原則(所有 HTTP 爬取來源共用):**
- 只擷取「標題、連結、發布時間、摘要片段」,不轉載全文
- 設定合理的 User-Agent 與請求頻率
- Selector 集中管理在各自的 source 模組
- 已確認七個來源的 `robots.txt` 都不禁止程式擷取的路徑

**統一輸出格式:**
```json
{
  "source": "來源名稱",
  "title": "標題",
  "link": "原始連結",
  "published_at": "YYYY-MM-DD 或 null",
  "summary": "摘要片段(非全文,部分來源固定為空字串)",
  "category": "分類(依來源而定,可能為空字串)",
  "track": "law 或 news",
  "dateUnknown": "true(只有 WORK DJ 有此欄位)"
}
```

---

## 三、Gemini 相關性判斷與摘要

實作於 [scraper/src/gemini](scraper/src/gemini),兩軌各自呼叫一次 Gemini,只處理「去重後尚未推播過」的項目。

### 3.1 共用呼叫層([scraper/src/lib/gemini.js](scraper/src/lib/gemini.js))

- 直接打 REST API:`POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`,用 `responseSchema` 強制結構化 JSON 輸出
- 環境變數:`GEMINI_API_KEY`(必填)、`GEMINI_MODEL`(選填,預設 `gemini-2.5-flash`)
- **`gemini-2.0-flash` 實測免費額度為 0(應已停用)**,若未來 `gemini-2.5-flash` 也停用,需要重新確認可用模型清單

### 3.2 勞動法令偵探([scraper/src/gemini/laborLawAnalysis.js](scraper/src/gemini/laborLawAnalysis.js))

- 輸入:去重後的行政院公報 + 常見問答 + 勞動法令查詢系統項目,單次批次呼叫
- 輸出欄位:`relevant`(是否相關)、`relevance_score`(1-5)、`summary`(白話摘要)、`affected`(受影響對象)、`effective_date`、`hr_suggestion`(HR 因應建議)

### 3.3 HR 情報站([scraper/src/gemini/hrDigestSelection.js](scraper/src/gemini/hrDigestSelection.js))

- 輸入:去重後的新聞稿 + 104職場力 + WORK DJ 項目,單次批次呼叫
- Gemini 精選「最多 16 篇」,分類到三大類:**法規制度 / 人資實務 / 管理議題**
- **收錄範圍限定兩類**:(1) 人事行政/勞資關係/員工權益相關法規或新聞,(2) 管理層為避免公司觸法而需注意的相關法規或新聞
- **明確排除**:體育賽事、名人傳記/職涯勵志文、產品行銷案例、AI 工具教學、一般心理健康雞湯文、純財經/產業趨勢報導
- **強調寧缺勿濫**:候選不足時只回傳實際數量,不硬湊到 16 篇上限

> 這個 prompt 是收緊過的版本。收緊前用同一批 22 篇候選測試,曾一次選出 11 篇,混入世足球員報導、名人傳記、AI 工具教學等明顯不相關內容;收緊後同一批候選只選出 3 篇,品質明顯改善。這也是移除「經理人」來源的直接原因 —— 那個來源的內容跟收錄範圍(人事/勞資/員工權益/合規)重疊度太低。

### 3.4 錯誤處理

兩軌都用 try/catch 包住,任一軌道呼叫失敗只會讓該軌道略過,不會讓整支程式中斷。

---

## 四、去重機制

實作於 [scraper/src/lib/notionDedupe.js](scraper/src/lib/notionDedupe.js),存在 Notion database。

### 4.1 判斷基準:「已推播成功」才標記

不是「抓取到」或「Gemini 判斷完」就算數,而是 **LINE Push API 呼叫成功之後**才寫入 Notion。未入選 / 推播失敗的項目不會被標記,只要還在「當日/前日」的時間窗內,下次執行會被重新抓取、重新送進 Gemini 判斷。好處是不會因為單次判斷失準或推播失敗就永久漏掉重要項目;代價是同一筆資料可能被 Gemini 重複判斷、多花一點 API 額度。

### 4.2 Notion database 設定

需要一個 internal integration + 一個 database,欄位:

| 欄位名稱 | 型別 | 用途 |
|---|---|---|
| `Link` | Title | 文章連結,當唯一鍵 |
| `Title` | Rich text | 文章標題,方便人工瀏覽 |
| `Track` | Select(`law`、`news`) | 屬於哪一軌 |
| `Pushed At` | Date | 標記為已推播的日期 |

Database 需要分享給 integration(右上角 `...` → Connections)才能被 API 存取。

### 4.3 保留期限:90 天

查詢時只比對 `Pushed At` 在 90 天內的紀錄,超過的舊紀錄不影響去重判斷(但實務上因為有「當日/前日過濾」,90 天前的資料本來就不會再被抓到)。真正的清理由 `purgeExpiredPushRecords()` 負責,**不會**在一般執行流程中自動觸發,需要另外排一個低頻率排程執行(尚未設定)。

### 4.4 錯誤處理

`filterUnseenNotion()` 失敗會退回「本次不做去重、視為全部未推播」,不中斷程式;`markPushedNotion()` 失敗只記錄錯誤(此時訊息已經推播成功,但去重紀錄沒寫入,下次可能重複推播 —— 已知風險,尚未處理)。

---

## 五、LINE Bot 前置設定

1. 到 [LINE Developers Console](https://developers.line.biz/console/) 建立 **Provider**
2. 在該 Provider 下建立 **Messaging API Channel**
3. 在「Messaging API」分頁發行 **Channel access token**,存成 `LINE_CHANNEL_ACCESS_TOKEN`
4. 掃該分頁的 QR code 把 Bot 加為好友
5. **取得自己的 userId**(沒有架設 webhook 伺服器時的做法):
   - 到 [webhook.site](https://webhook.site) 取得一個臨時網址
   - 貼到 LINE Developers Console 的 Webhook URL,開啟「Use webhook」
   - 到 LINE Official Account Manager →「回應設定」關閉「加入好友的歡迎訊息」「自動回應訊息」(避免攔截)
   - 用手機傳一句話給 Bot
   - 回 webhook.site 找 `events[0].source.userId`,存成 `LINE_HR_USER_ID`
   - **事後記得把「Use webhook」關掉**,推播功能用不到接收訊息,留著只會讓 LINE 一直嘗試打一個沒人接的網址

---

## 六、LINE 推播內容

實作於 [scraper/src/line](scraper/src/line)。

### 6.1 訊息組成([scraper/src/line/buildDailyMessage.js](scraper/src/line/buildDailyMessage.js))

把「勞動法令偵探判定相關的項目」+「HR 情報站精選項目」組成**單一則** LINE Flex Message(bubble 型態):
- Header:深綠色底,顯示標題與日期
- Body 分兩區塊:「⚖️ 勞動法令偵探」(依 `relevance_score` 由高到低排序,顯示星等分數、Gemini 摘要、影響對象、生效日期、HR 建議)、「📰 HR 情報站」(依分類顯示標題與入選原因)
- 每個項目的 box 都掛 `action: { type: "uri", uri: item.link }`,點擊可直接開啟原文
- 只有單軌沒有項目時,對應區塊顯示「今日無相關法令異動」/「今日無精選文章」
- **兩軌都沒有項目時,不發空的 Flex 卡片,改推一句簡短文字**:「📭 今天無精選文章(YYYY-MM-DD)」,仍然照常推播(當作系統還活著的心跳訊號)。可用 `npm run test-empty`(於 `scraper/` 目錄)單獨模擬這個情境並實際推播測試(會耗 1 則月額度)

### 6.2 推播([scraper/src/line/pushMessage.js](scraper/src/line/pushMessage.js))

呼叫 `POST https://api.line.me/v2/bot/message/push`,`to` 帶 `LINE_HR_USER_ID`。推播成功後才觸發 Notion 已推播標記(見 4.1 節)。

**已知限制:**目前是單一 bubble,若某天項目數量變多(尤其 HR 情報站精選到 16 篇上限),bubble 會拉得很長,尚未在 LINE App 實機測試顯示效果是否可接受,必要時可能要改用 carousel 分頁。

---

## 七、部署

### 7.1 觸發方式:外部 cron-job.org,不是 GitHub 原生排程

Repo:`https://github.com/mira0207/linebot-hr-monitor`,workflow 檔案:[.github/workflows/daily.yml](.github/workflows/daily.yml)

**GitHub 原生的 `schedule` 事件實測不可靠,已經移除,改用 [cron-job.org](https://cron-job.org) 每天 09:10 台灣時間呼叫 GitHub 的 `workflow_dispatch` REST API 來觸發。**

踩過的坑(依序):
1. 一開始用 `cron: "0 1 * * *"`(整點觸發),2026-07-11 09:00 完全沒有觸發紀錄
2. 改成 `cron: "5 1 * * *"` 避開整點,結果隔天實測延遲到 **12:31** 才觸發,晚了 3 個多小時(確認過 GitHub Actions 執行紀錄上標示為 `Scheduled`,排除是手動或外部觸發)
3. 判定 GitHub 原生排程對這個 repo 不夠穩定,改成外部服務 cron-job.org 定時打 API 觸發,workflow 檔案裡**只留 `workflow_dispatch`**,不寫 `schedule`,避免兩邊同一天各跑一次造成重複執行、浪費 API 額度

- workflow 執行內容:checkout → setup-node(22)→ `npm install` → `npm start`(於 `scraper/` 目錄)
- 執行完會把 `line-message.json`(當次推播的實際內容)存成 workflow artifact,保留 14 天,方便事後回頭查當天到底推了什麼

**已知限制:**
- cron-job.org 觸發 `workflow_dispatch` 需要一組有權限的 GitHub Personal Access Token,這組憑證存在 cron-job.org 那邊,不在這個 repo 的管控範圍內,如果 token 過期/被撤銷,排程會悄悄停止,沒有另外設告警
- 排程只認 `main` 分支
- 這是無狀態的一次性執行,沒有做「執行中/執行失敗」的額外告警,依賴 GitHub 預設的失敗通知信

### 7.2 Repository Secrets

在 [repo Secrets 設定頁](https://github.com/mira0207/linebot-hr-monitor/settings/secrets/actions) 設定,對應到七、環境變數清單裡標「必填」的項目。

---

## 八、環境變數清單

本機開發用 [scraper/.env](scraper/.env)(已加入 `.gitignore`,參考 [scraper/.env.example](scraper/.env.example));正式環境用 GitHub Actions Secrets。

| 名稱 | 必填 | 用途 |
|---|---|---|
| `GEMINI_API_KEY` | ✅ | 呼叫 Gemini API 做判斷/摘要 |
| `GEMINI_MODEL` | 選填 | 指定模型名稱,預設 `gemini-2.5-flash` |
| `NOTION_API_KEY` | ✅ | 去重紀錄用,Notion internal integration token |
| `NOTION_DEDUPE_DATABASE_ID` | ✅ | 去重紀錄的 Notion database ID |
| `LINE_CHANNEL_ACCESS_TOKEN` | ✅ | 呼叫 LINE Push API |
| `LINE_HR_USER_ID` | ✅ | 接收推播的 HR 個人 userId |

---

## 九、上線前檢查清單

目前是**測試觀察階段**,以下確認過再正式宣告上線:

- [x] 爬蟲七個來源全部驗證可正常抓到當日/近期真實資料
- [x] Gemini 判斷/精選品質已人工檢視,兩軌輸出都合理
- [x] Notion 去重機制實測跑通(查詢、寫入、90 天保留邏輯)
- [x] LINE 推播實測至少成功一次(手動觸發)
- [ ] 觀察至少 3-5 天的自動排程執行結果,確認：
  - 每天都有準時(或接近準時)執行 —— GitHub 原生排程已證實不可靠(見七、1 節的踩坑紀錄),已改用外部 cron-job.org 觸發,從改用當天起重新觀察,這項還不能打勾
  - 推播內容品質穩定,沒有明顯的誤判或重複
  - 沒有 API 額度或費用異常
- [ ] 確認 GitHub Actions 執行失敗時,失敗通知信真的會寄到有人在看的信箱
- [ ] `purgeExpiredPushRecords()` 排一個低頻率排程執行(見 4.3 節)

---

## 十、待確認事項

- [ ] 「全員 LINE 群組」轉發下游流程是否仍需要 —— 目前不實作,系統做到「推播給 HR」為止
- [ ] HR 是否需要「編輯摘要內容」的權限,目前訊息是唯讀的
- [ ] `relevance_score` 的門檻值目前沒有設定門檻(只要 `relevant: true` 就收錄),Pilot 階段觀察後可能需要收斂
- [ ] WORK DJ人力銀行目前只有 2 篇文章、且無法取得可靠發布日期,規模變大或這個限制改變時需要重新評估爬取方式
- [ ] `markPushedNotion()` 失敗時(推播成功但去重紀錄沒寫入)可能導致下次重複推播,尚未處理這個邊界情況
- [ ] Flex Message 單一 bubble 在項目數量多時的顯示效果未實機驗證(見 6.2 節)
- [ ] 兩軌目前都是單次批次呼叫 Gemini,候選量體變大時需評估是否要拆批
- [ ] 若日後想擴充工商時報、Cheers、1111 人力銀行等來源,需評估無頭瀏覽器繞過反爬蟲保護的做法與對方使用條款
