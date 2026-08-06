import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadAgentConfig, runAgent } from "./agent.js";
import { fetchHotNews, searchNews, fetchUrlContent, PLATFORM_IDS } from "./news-tool.js";
import { loadDescriptions } from "./tool-descriptions.js";

/**
 * MCP stdio 服务 —— news-demo。
 * 暴露 5 个工具：hot_news / news_search / news_summary / agent_chat / agent_status。
 * Hermes（或任意 MCP 客户端）注册后即可在对话中调用。
 */

const MAX_STEPS = 12;

const server = new McpServer({
  name: "news-demo",
  version: "1.0.0",
});

const agentConfig = loadAgentConfig();
const descriptions = loadDescriptions();

// ── Tool 1: hot_news ──────────────────────────────────────────────────
server.tool(
  "hot_news",
  descriptions.hot_news,
  {
    platform: z
      .string()
      .optional()
      .describe(
        `平台名：${PLATFORM_IDS.join(" / ")} / all（默认 all，全平台并发获取）`,
      ),
    count: z
      .number()
      .optional()
      .describe("每平台返回条目数，默认 20"),
  },
  async ({ platform, count }) => {
    const results = await fetchHotNews(platform ?? "all", count ?? 20);
    const ok = results.some((r) => r.items.length > 0);
    const text = results
      .map((r) => {
        if (r.error && !r.items.length)
          return `【${r.platform}】获取失败: ${r.error}`;
        const list = r.items
          .map(
            (i) =>
              `  ${String(i.rank).padStart(2)}. ${i.title}${i.hot_value ? ` (${i.hot_value})` : ""}`,
          )
          .join("\n");
        return `【${r.platform}】${r.items.length} 条\n${list}`;
      })
      .join("\n\n");
    return toMcpContent(ok, text, results);
  },
);

// ── Tool 2: news_search ───────────────────────────────────────────────
server.tool(
  "news_search",
  descriptions.news_search,
  {
    keyword: z.string().describe("搜索关键词（支持中文）"),
    count: z.number().optional().describe("返回条目数，默认 10"),
  },
  async ({ keyword, count }) => {
    const result = await searchNews(keyword, count ?? 10);
    const ok = !result.error || result.items.length > 0;
    const text =
      `"${result.keyword}" 搜索结果 (${result.items.length} 条):\n\n` +
      result.items
        .map(
          (i) =>
            `${i.rank}. ${i.title}${i.url ? `\n   ${i.url}` : ""}${i.description ? `\n   ${i.description.slice(0, 120)}` : ""}`,
        )
        .join("\n\n");
    return toMcpContent(ok, result.error && !result.items.length ? `搜索失败: ${result.error}` : text, result);
  },
);

// ── Tool 3: news_summary ──────────────────────────────────────────────
server.tool(
  "news_summary",
  descriptions.news_summary,
  {
    url: z.string().optional().describe("新闻链接（优先使用）"),
    title: z.string().optional().describe("新闻标题"),
    content: z.string().optional().describe("新闻正文内容"),
  },
  async ({ url, title, content }) => {
    if (!url && !title && !content) {
      return toMcpContent(false, "请提供 url 或 title/content 参数", undefined, true);
    }
    try {
      let text = "";
      if (url) {
        const fetched = await fetchUrlContent(url);
        text = fetched;
      } else {
        text = [title, content].filter(Boolean).join("\n\n");
      }
      // 简单提取式摘要：取前 500 字符
      const summary = text.length > 500 ? text.slice(0, 500) + "…" : text;
      return toMcpContent(true, summary, { url, title, content_length: text.length });
    } catch (e) {
      return toMcpContent(false, `获取失败: ${e instanceof Error ? e.message : String(e)}`, undefined, true);
    }
  },
);

// ── Tool 4: agent_chat ────────────────────────────────────────────────
server.tool(
  "agent_chat",
  descriptions.agent_chat,
  {
    message: z.string().describe("新闻分析任务或问题，委派给子 agent 处理"),
    maxSteps: z.number().optional().describe("最大推理步数，默认 12"),
  },
  async ({ message, maxSteps }) => {
    try {
      const result = await runAgent(message, agentConfig, { maxSteps });
      return toMcpContent(
        true,
        JSON.stringify(
          {
            response: result.content,
            steps: result.steps,
            toolCalls: result.toolCalls.length,
            mode: result.mode,
            finishedAt: result.finishedAt,
          },
          null,
          2,
        ),
      );
    } catch (error) {
      return toMcpContent(
        false,
        error instanceof Error ? error.message : String(error),
        undefined,
        true,
      );
    }
  },
);

// ── Tool 5: agent_status ──────────────────────────────────────────────
server.tool(
  "agent_status",
  descriptions.agent_status,
  {},
  async () => {
    return toMcpContent(
      true,
      JSON.stringify(
        {
          name: "news-demo",
          version: "1.0.0",
          mode: agentConfig.mode,
          model: agentConfig.mode === "llm" ? agentConfig.model : null,
          baseURL: agentConfig.mode === "llm" ? agentConfig.baseURL : null,
          capabilities: ["hot_news", "news_search", "news_summary", "agent_chat"],
          platforms: PLATFORM_IDS,
          maxSteps: MAX_STEPS,
        },
        null,
        2,
      ),
    );
  },
);

function toMcpContent(ok: boolean, text: string, data?: unknown, isError = false) {
  return {
    content: [
      {
        type: "text" as const,
        text: data ? JSON.stringify({ ok, text, data }, null, 2) : text,
      },
    ],
    isError: isError || !ok,
  };
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[news-demo-mcp] Server started on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
