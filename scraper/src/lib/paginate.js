// 依序抓取多頁,直到抓完指定頁數或某一頁沒有資料為止(避免超過對方最後一頁時繼續打空頁)
export async function fetchAllPages(fetchPage, pages) {
  const all = [];
  for (let page = 1; page <= pages; page++) {
    const items = await fetchPage(page);
    if (!items.length) break;
    all.push(...items);
  }
  return all;
}
