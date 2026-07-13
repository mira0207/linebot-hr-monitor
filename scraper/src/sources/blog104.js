import { fetchAllPages } from "../lib/paginate.js";

// 104職場力(blog.104.com.tw)有正式 WordPress REST API,比 HTML 爬取穩定
const API_BASE = "https://blog.104.com.tw/wp-json/wp/v2/posts";

// 分類 ID 是透過 /wp-json/wp/v2/categories?slug=xxx 查到的,若改版需重新查證
const CATEGORIES = {
  hr: { id: 187, label: "104職場力-人資充電" },
  laborLaw: { id: 195, label: "104職場力-勞動法令" },
};

function stripHtml(html) {
  return html.replace(/<[^>]*>/g, "").trim();
}

function fetchCategory(categoryKey, { pages = 2, perPage = 10 } = {}) {
  const { id, label } = CATEGORIES[categoryKey];

  const fetchPage = async (page) => {
    // _cb 是 cache-buster:104 的伺服器以完整 URL 為 key 快取 API 回應,
    // 固定 URL 會拿到舊資料(實測當天新文章發布 20 分鐘後仍被快取擋住看不到),
    // 加上時間戳記讓每次請求 URL 都不同,強制取得最新內容
    const url = `${API_BASE}?categories=${id}&page=${page}&per_page=${perPage}&_fields=id,date,link,title,excerpt&_cb=${Date.now()}`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (res.status === 400) return []; // 超過總頁數時 WP REST API 回傳 400,視為沒有更多資料
    if (!res.ok) throw new Error(`104職場力(${label}) 請求失敗: HTTP ${res.status} (page ${page})`);
    const posts = await res.json();

    return posts.map((post) => ({
      source: label,
      title: stripHtml(post.title.rendered),
      link: post.link,
      published_at: post.date ? post.date.slice(0, 10) : null,
      summary: stripHtml(post.excerpt.rendered),
      category: "",
    }));
  };

  return fetchAllPages(fetchPage, pages);
}

export async function fetchBlog104({ pages = 2, perPage = 10 } = {}) {
  const [hr, laborLaw] = await Promise.all([
    fetchCategory("hr", { pages, perPage }),
    fetchCategory("laborLaw", { pages, perPage }),
  ]);
  return [...hr, ...laborLaw];
}
