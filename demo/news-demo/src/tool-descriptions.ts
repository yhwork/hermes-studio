import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * MCP 工具描述注册表 —— 单一事实来源。
 *
 * - mcp.ts 启动时读这里，把描述喂给 Hermes 的工具表。
 * - /config 页面通过 GET/PUT /api/tool-descriptions 编辑覆盖项。
 * - 覆盖项持久化在源码目录上一层的 descriptions.json。
 */

const HERE = typeof __dirname !== "undefined" ? __dirname : process.cwd();
const OVERRIDES_FILE = join(HERE, "..", "descriptions.json");

export const DEFAULT_DESCRIPTIONS: Record<string, string> = {
  hot_news:
    "获取各平台热搜/热榜。支持微博热搜、知乎热榜、百度热搜、抖音热点、36氪快讯。" +
    "参数: platform (weibo/zhihu/baidu/douyin/36kr/all，默认 all), count (每平台条目数，默认 20)。" +
    "返回各平台的热点列表，含排名、标题、热度值、链接。",
  news_search:
    "按关键词搜索最新新闻（百度新闻 RSS）。" +
    "参数: keyword（关键词，必填）, count（返回条目数，默认 10）。" +
    "返回标题、链接、摘要列表。",
  news_summary:
    "对指定新闻/热点生成摘要。" +
    "参数: url（新闻链接，优先）或 title + content（标题+内容）。" +
    "将抓取 URL 正文并返回提取的文本摘要，可结合 agent_chat 做 AI 深度总结。",
  agent_chat:
    "将新闻分析/总结任务委派给子 agent（拥有 LLM 推理能力）。" +
    "参数: message（任务描述或问题）, maxSteps（最大推理步数，默认 12）。" +
    "适合复杂的新闻解读、多条热点汇总、趋势分析等任务。",
  agent_status:
    "查看新闻 agent 的配置状态：运行模式（llm/local）、模型信息、可用工具列表。",
};

export function loadOverrides(): Record<string, string> {
  try {
    if (!existsSync(OVERRIDES_FILE)) return {};
    const raw = readFileSync(OVERRIDES_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

export function loadDescriptions(): Record<string, string> {
  return { ...DEFAULT_DESCRIPTIONS, ...loadOverrides() };
}

export function saveOverrides(map: Record<string, string>): void {
  const compact: Record<string, string> = {};
  for (const [name, desc] of Object.entries(map)) {
    const trimmed = (desc ?? "").trim();
    if (trimmed && trimmed !== DEFAULT_DESCRIPTIONS[name]) {
      compact[name] = trimmed;
    }
  }
  writeFileSync(OVERRIDES_FILE, JSON.stringify(compact, null, 2) + "\n", "utf8");
}

export const overridesFilePath = OVERRIDES_FILE;
