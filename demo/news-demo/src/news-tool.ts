import type { AgentTool, AgentToolContext, AgentToolResult } from "../../../packages/ekko-agent/src/tools/types";

/**
 * 新闻热点核心工具 —— 抓取各平台热搜/热榜。
 *
 * 支持平台：
 *   weibo   — 微博热搜  https://weibo.com/ajax/side/hotSearch
 *   zhihu   — 知乎热榜  https://www.zhihu.com/api/v3/feed/topstory/hot-lists/total
 *   baidu   — 百度热搜  https://top.baidu.com/board?tab=realtime
 *   douyin  — 抖音热点  https://www.douyin.com/aweme/v1/web/hot/search/list/
 *   36kr    — 36氪快讯  https://36kr.com/api/newsflash/index
 *
 * 每个平台独立 try/catch，失败不影响其他平台。
 * 所有 fetch 附 AbortSignal.timeout(15_000)。
 */

// ── Types ─────────────────────────────────────────────────────────────

export interface NewsItem {
  rank: number;
  title: string;
  hot_value?: number | string;
  url?: string;
  description?: string;
  category?: string;
}

export interface PlatformNews {
  platform: string;
  platform_id: string;
  items: NewsItem[];
  fetchedAt: string;
  error?: string;
}

export interface SearchResult {
  keyword: string;
  items: NewsItem[];
  fetchedAt: string;
  error?: string;
}

export interface HotNewsInput extends Record<string, unknown> {
  platform?: string;
  count?: number;
}

export interface SearchNewsInput extends Record<string, unknown> {
  keyword: string;
  count?: number;
}

export interface SummaryInput extends Record<string, unknown> {
  url?: string;
  title?: string;
  content?: string;
}

// ── HTTP helpers ──────────────────────────────────────────────────────

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const BASE_HEADERS: Record<string, string> = {
  "User-Agent": UA,
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
};

async function get(
  url: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(url, {
    headers: { ...BASE_HEADERS, ...headers },
    signal: AbortSignal.timeout(15_000),
  });
}

// ── Platform fetchers ─────────────────────────────────────────────────

async function fetchWeibo(count: number): Promise<PlatformNews> {
  const meta = { platform: "微博热搜", platform_id: "weibo" };
  try {
    const res = await get("https://weibo.com/ajax/side/hotSearch", {
      "Referer": "https://weibo.com/",
      "Accept": "application/json, text/plain, */*",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as Record<string, unknown>;
    const realtime = (
      (data.data as Record<string, unknown>)?.realtime as unknown[]
    ) ?? [];
    const items: NewsItem[] = [];
    for (let i = 0; i < Math.min(realtime.length, count); i++) {
      const item = realtime[i] as Record<string, unknown>;
      if (!item.word) continue;
      items.push({
        rank: typeof item.num === "number" ? item.num : i + 1,
        title: String(item.word),
        hot_value:
          typeof item.raw_hot === "number" ? item.raw_hot : undefined,
        url: `https://s.weibo.com/weibo?q=${encodeURIComponent(String(item.word))}`,
        description:
          typeof item.icon_desc === "string" ? item.icon_desc : undefined,
      });
    }
    return { ...meta, items, fetchedAt: new Date().toISOString() };
  } catch (e) {
    return {
      ...meta,
      items: [],
      fetchedAt: new Date().toISOString(),
      error: String(e),
    };
  }
}

async function fetchZhihu(count: number): Promise<PlatformNews> {
  const meta = { platform: "知乎热榜", platform_id: "zhihu" };
  try {
    const res = await get(
      "https://www.zhihu.com/api/v3/feed/topstory/hot-lists/total?limit=50",
      {
        "Referer": "https://www.zhihu.com/hot",
        "x-api-version": "3.0.40",
        "x-app-za": "OS=Web",
      },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as Record<string, unknown>;
    const list = (data.data as unknown[]) ?? [];
    const items: NewsItem[] = [];
    for (let i = 0; i < Math.min(list.length, count); i++) {
      const entry = list[i] as Record<string, unknown>;
      const target = entry.target as Record<string, unknown> | undefined;
      if (!target?.title) continue;
      items.push({
        rank: i + 1,
        title: String(target.title),
        hot_value:
          typeof entry.detail_text === "string"
            ? entry.detail_text
            : undefined,
        url:
          typeof target.url === "string"
            ? target.url
            : `https://www.zhihu.com/question/${target.id}`,
        description:
          typeof entry.detail_text === "string"
            ? entry.detail_text
            : undefined,
      });
    }
    return { ...meta, items, fetchedAt: new Date().toISOString() };
  } catch (e) {
    return {
      ...meta,
      items: [],
      fetchedAt: new Date().toISOString(),
      error: String(e),
    };
  }
}

async function fetchBaidu(count: number): Promise<PlatformNews> {
  const meta = { platform: "百度热搜", platform_id: "baidu" };
  try {
    const res = await get("https://top.baidu.com/board?tab=realtime", {
      "Referer": "https://www.baidu.com/",
      "Accept":
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();

    const items: NewsItem[] = [];

    // Try pattern 1: <script type="application/json" id="FE_WIDGETS_DATA">
    const m1 = html.match(
      /<script[^>]*id=["']FE_WIDGETS_DATA["'][^>]*>([\s\S]*?)<\/script>/i,
    );
    if (m1) {
      try {
        const json = JSON.parse(m1[1].trim()) as Record<string, unknown>;
        const list =
          (json.realtime as unknown[]) ??
          (json.today as unknown[]) ??
          (json.daily as unknown[]) ??
          [];
        for (let i = 0; i < Math.min(list.length, count); i++) {
          const item = list[i] as Record<string, unknown>;
          const word = String(item.query ?? item.word ?? item.title ?? "");
          if (!word) continue;
          items.push({
            rank: i + 1,
            title: word,
            hot_value:
              item.hotScore != null ? String(item.hotScore) : undefined,
            url:
              typeof item.detailUrl === "string"
                ? item.detailUrl
                : `https://www.baidu.com/s?wd=${encodeURIComponent(word)}`,
            description:
              typeof item.desc === "string" ? item.desc : undefined,
          });
        }
      } catch { /* ignore parse errors, try next pattern */ }
    }

    // Try pattern 2: window.__FE_WIDGETS_DATA__={...}
    if (!items.length) {
      const m2 = html.match(
        /window\.__FE_WIDGETS_DATA__\s*=\s*(\{[\s\S]+?\});\s*(?:<\/script>|window\.)/,
      );
      if (m2) {
        try {
          const json = JSON.parse(m2[1]) as Record<string, unknown>;
          const list =
            (json.realtime as unknown[]) ??
            (json.today as unknown[]) ??
            [];
          for (let i = 0; i < Math.min(list.length, count); i++) {
            const item = list[i] as Record<string, unknown>;
            const word = String(item.query ?? item.word ?? "");
            if (!word) continue;
            items.push({
              rank: i + 1,
              title: word,
              hot_value:
                item.hotScore != null ? String(item.hotScore) : undefined,
              url:
                typeof item.detailUrl === "string"
                  ? item.detailUrl
                  : `https://www.baidu.com/s?wd=${encodeURIComponent(word)}`,
            });
          }
        } catch { /* ignore */ }
      }
    }

    if (!items.length) throw new Error("无法从页面提取热搜数据");
    return { ...meta, items, fetchedAt: new Date().toISOString() };
  } catch (e) {
    return {
      ...meta,
      items: [],
      fetchedAt: new Date().toISOString(),
      error: String(e),
    };
  }
}

async function fetchDouyin(count: number): Promise<PlatformNews> {
  const meta = { platform: "抖音热点", platform_id: "douyin" };
  try {
    const res = await get(
      "https://www.douyin.com/aweme/v1/web/hot/search/list/?detail_list=1",
      {
        "Referer": "https://www.douyin.com/",
        "Accept": "application/json, text/plain, */*",
      },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as Record<string, unknown>;
    const wordList =
      (
        (data.data as Record<string, unknown>)?.word_list as unknown[]
      ) ?? [];
    const items: NewsItem[] = [];
    for (let i = 0; i < Math.min(wordList.length, count); i++) {
      const item = wordList[i] as Record<string, unknown>;
      const word = String(item.word ?? "");
      if (!word) continue;
      items.push({
        rank: typeof item.position === "number" ? item.position : i + 1,
        title: word,
        hot_value:
          typeof item.hot_value === "number" ? item.hot_value : undefined,
        url: `https://www.douyin.com/search/${encodeURIComponent(word)}`,
        description:
          typeof item.label === "string" ? item.label : undefined,
      });
    }
    return { ...meta, items, fetchedAt: new Date().toISOString() };
  } catch (e) {
    return {
      ...meta,
      items: [],
      fetchedAt: new Date().toISOString(),
      error: String(e),
    };
  }
}

async function fetch36kr(count: number): Promise<PlatformNews> {
  const meta = { platform: "36氪快讯", platform_id: "36kr" };
  try {
    const res = await get(
      `https://36kr.com/api/newsflash/index?limit=${count}&category_id=0&is_seo=1`,
      {
        "Referer": "https://36kr.com/newsflash",
        "Accept": "application/json, text/plain, */*",
      },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as Record<string, unknown>;
    const content = (data.data as Record<string, unknown>)
      ?.newsflash_content as Record<string, unknown> | undefined;
    const list = (content?.items as unknown[]) ?? [];
    const items: NewsItem[] = [];
    for (let i = 0; i < Math.min(list.length, count); i++) {
      const item = list[i] as Record<string, unknown>;
      const title = String(item.title ?? item.brief ?? "");
      if (!title) continue;
      items.push({
        rank: i + 1,
        title,
        url: item.itemId
          ? `https://36kr.com/newsflash/${item.itemId}`
          : "https://36kr.com/newsflash",
        description:
          typeof item.description === "string"
            ? item.description
            : undefined,
        category:
          typeof item.templateMaterial === "string"
            ? item.templateMaterial
            : undefined,
      });
    }
    return { ...meta, items, fetchedAt: new Date().toISOString() };
  } catch (e) {
    return {
      ...meta,
      items: [],
      fetchedAt: new Date().toISOString(),
      error: String(e),
    };
  }
}

// ── Platform registry ─────────────────────────────────────────────────

const PLATFORMS: Record<string, (count: number) => Promise<PlatformNews>> = {
  weibo: fetchWeibo,
  zhihu: fetchZhihu,
  baidu: fetchBaidu,
  douyin: fetchDouyin,
  "36kr": fetch36kr,
};

export const PLATFORM_IDS = Object.keys(PLATFORMS);

// ── Exported API ──────────────────────────────────────────────────────

/** 获取热搜榜。platform="all" 时并发抓取全部平台。 */
export async function fetchHotNews(
  platform: string = "all",
  count: number = 20,
): Promise<PlatformNews[]> {
  if (platform === "all") {
    const results = await Promise.allSettled(
      Object.values(PLATFORMS).map((fn) => fn(count)),
    );
    return results.map((r) =>
      r.status === "fulfilled"
        ? r.value
        : {
            platform: "unknown",
            platform_id: "unknown",
            items: [],
            fetchedAt: new Date().toISOString(),
            error:
              r.reason instanceof Error
                ? r.reason.message
                : String(r.reason),
          },
    );
  }

  const id = platform.toLowerCase();
  const fn = PLATFORMS[id];
  if (!fn) {
    return [
      {
        platform,
        platform_id: id,
        items: [],
        fetchedAt: new Date().toISOString(),
        error: `未知平台 "${platform}"。支持: ${PLATFORM_IDS.join(", ")}, all`,
      },
    ];
  }
  return [await fn(count)];
}

/** 关键词搜索新闻（百度新闻 RSS）。 */
export async function searchNews(
  keyword: string,
  count: number = 10,
): Promise<SearchResult> {
  try {
    const url = `https://news.baidu.com/ns?word=${encodeURIComponent(keyword)}&tn=news&from=news&cl=2&pn=0&rn=${count}&ct=1&rss=1`;
    const res = await get(url, {
      "Referer": "https://news.baidu.com/",
      "Accept":
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    const items = parseRssItems(xml, count);
    if (!items.length) throw new Error("RSS 未返回结果");
    return { keyword, items, fetchedAt: new Date().toISOString() };
  } catch (e) {
    return {
      keyword,
      items: [],
      fetchedAt: new Date().toISOString(),
      error: String(e),
    };
  }
}

/** 抓取并提取 URL 正文（简单文本提取，供 news_summary 使用）。 */
export async function fetchUrlContent(url: string): Promise<string> {
  const res = await get(url, {
    "Accept":
      "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  return extractTextFromHtml(html, 4000);
}

// ── Helpers ───────────────────────────────────────────────────────────

function parseRssItems(xml: string, count: number): NewsItem[] {
  const items: NewsItem[] = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/gi;
  let m: RegExpExecArray | null;
  let rank = 1;
  while ((m = itemRe.exec(xml)) !== null && items.length < count) {
    const chunk = m[1];
    const title = decodeHtml(extractTag(chunk, "title"));
    const link =
      extractTag(chunk, "link") || extractTag(chunk, "url") || undefined;
    const desc = decodeHtml(extractTag(chunk, "description"));
    if (title) {
      items.push({
        rank: rank++,
        title,
        url: link || undefined,
        description: desc || undefined,
      });
    }
  }
  return items;
}

function extractTag(xml: string, tag: string): string {
  const cdataRe = new RegExp(
    `<${tag}[^>]*><!\\[CDATA\\[[\\s\\S]*?\\]\\]><\\/${tag}>`,
    "i",
  );
  const normalRe = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const mCdata = xml.match(cdataRe);
  if (mCdata) {
    const inner = mCdata[0].match(/\[CDATA\[([\s\S]*?)\]\]/);
    return inner ? inner[1].trim() : "";
  }
  const mNormal = xml.match(normalRe);
  return mNormal ? mNormal[1].trim() : "";
}

function decodeHtml(str: string): string {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) =>
      String.fromCodePoint(parseInt(h, 16)),
    );
}

function extractTextFromHtml(html: string, maxLen: number): string {
  const text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > maxLen ? text.slice(0, maxLen) + "…" : text;
}

/** 格式化热榜结果为可读文本。 */
export function formatHotNews(results: PlatformNews[]): string {
  return results
    .map((r) => {
      if (r.error && !r.items.length) {
        return `【${r.platform}】获取失败: ${r.error}`;
      }
      const header = `【${r.platform}】${r.items.length} 条`;
      const list = r.items
        .map(
          (i) =>
            `  ${String(i.rank).padStart(2)}. ${i.title}${i.hot_value ? ` (${i.hot_value})` : ""}`,
        )
        .join("\n");
      return `${header}\n${list}`;
    })
    .join("\n\n");
}

// ── AgentTool classes ─────────────────────────────────────────────────

export class HotNewsTool implements AgentTool<HotNewsInput> {
  readonly definition = {
    name: "hot_news",
    description:
      "获取各平台热搜/热榜（微博热搜、知乎热榜、百度热搜、抖音热点、36氪快讯）。支持 platform=weibo/zhihu/baidu/douyin/36kr/all（默认 all）。",
    parameters: {
      type: "object",
      properties: {
        platform: {
          type: "string",
          description:
            "平台名：weibo / zhihu / baidu / douyin / 36kr / all（默认 all，全平台并发）",
        },
        count: {
          type: "number",
          description: "每平台返回条目数，默认 20",
        },
      },
    },
  };

  async execute(
    input: HotNewsInput,
    _ctx: AgentToolContext = {},
  ): Promise<AgentToolResult> {
    const results = await fetchHotNews(
      input.platform ?? "all",
      input.count ?? 20,
    );
    const text = formatHotNews(results);
    return { ok: true, content: text, data: results };
  }
}

export class SearchNewsTool implements AgentTool<SearchNewsInput> {
  readonly definition = {
    name: "search_news",
    description:
      "按关键词搜索最新新闻（百度新闻 RSS）。返回标题、链接、摘要列表。",
    parameters: {
      type: "object",
      properties: {
        keyword: {
          type: "string",
          description: "搜索关键词（支持中文）",
        },
        count: {
          type: "number",
          description: "返回条目数，默认 10",
        },
      },
      required: ["keyword"],
    },
  };

  async execute(
    input: SearchNewsInput,
    _ctx: AgentToolContext = {},
  ): Promise<AgentToolResult> {
    if (!input.keyword?.trim()) {
      return { ok: false, content: "keyword 参数必填", error: "missing_keyword" };
    }
    const result = await searchNews(input.keyword, input.count ?? 10);
    if (result.error && !result.items.length) {
      return {
        ok: false,
        content: `搜索失败: ${result.error}`,
        error: result.error,
        data: result,
      };
    }
    const text =
      `"${result.keyword}" 搜索结果 (${result.items.length} 条):\n\n` +
      result.items
        .map(
          (i) =>
            `${i.rank}. ${i.title}${i.url ? `\n   ${i.url}` : ""}${i.description ? `\n   ${i.description.slice(0, 100)}` : ""}`,
        )
        .join("\n\n");
    return { ok: true, content: text, data: result };
  }
}
