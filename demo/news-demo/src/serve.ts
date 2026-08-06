/**
 * 统一服务入口 —— 同一端口同时提供：
 *   1. HTTP REST API（/hot, /search, /summary, /agent, /info, /health, /config…）
 *   2. MCP Streamable HTTP（/mcp 路径，供远程 MCP 客户端连接）
 *   3. 本地 agent 交互式 IO（stdin readline，开发调试用）
 *
 * 启动方式：
 *   npx tsx src/serve.ts                     # 默认端口 8790
 *   PORT=9000 npx tsx src/serve.ts           # 自定义端口
 *   npx tsx src/serve.ts --no-interactive    # 不启动交互式 IO
 *
 * 其他平台 agent 接入方式：
 *   - HTTP REST:  POST http://<host>:8790/hot  { platform: "weibo" }
 *   - MCP 远程:   在 config.yaml 的 mcp_servers 里配 url: http://<host>:8790/mcp
 *   - MCP stdio:  用 src/mcp.ts（hermes-agent 本地 spawn）
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { loadAgentConfig, runAgent } from "./agent.js";
import { fetchHotNews, searchNews, fetchUrlContent, PLATFORM_IDS } from "./news-tool.js";
import { loadDescriptions, DEFAULT_DESCRIPTIONS, loadOverrides, saveOverrides } from "./tool-descriptions.js";
import { renderConfigPage } from "./config-page.js";
import { loadModelConfig, saveModelConfig, clearModelConfig, modelConfigFilePath } from "./model-config.js";

// ─── Config ───────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT ?? 8790);
const HOST = process.env.HOST ?? "0.0.0.0";
const INTERACTIVE = !process.argv.includes("--no-interactive");
const SERVER_INFO = { name: "news-demo", version: "2.0.0" };

const agentConfig = loadAgentConfig();
const descriptions = loadDescriptions();

// ─── MCP Server factory ───────────────────────────────────────────────
function createMcpServer(): McpServer {
  const srv = new McpServer({ name: "news-demo", version: "2.0.0" });

  srv.tool(
    "hot_news",
    descriptions.hot_news,
    {
      platform: z.string().optional().describe(
        `平台名：${PLATFORM_IDS.join(" / ")} / all（默认 all）`,
      ),
      count: z.number().optional().describe("每平台条目数，默认 20"),
    },
    async ({ platform, count }) => {
      const results = await fetchHotNews(platform ?? "all", count ?? 20);
      const ok = results.some((r) => r.items.length > 0);
      const text = results
        .map((r) => {
          if (r.error && !r.items.length) return `【${r.platform}】失败: ${r.error}`;
          const list = r.items
            .map((i) => `  ${String(i.rank).padStart(2)}. ${i.title}${i.hot_value ? ` (${i.hot_value})` : ""}`)
            .join("\n");
          return `【${r.platform}】${r.items.length} 条\n${list}`;
        })
        .join("\n\n");
      return toMcpContent(ok, text, results);
    },
  );

  srv.tool(
    "news_search",
    descriptions.news_search,
    {
      keyword: z.string().describe("搜索关键词"),
      count: z.number().optional().describe("返回条目数，默认 10"),
    },
    async ({ keyword, count }) => {
      const result = await searchNews(keyword, count ?? 10);
      const ok = !result.error || result.items.length > 0;
      const text = ok
        ? `"${result.keyword}" 结果 (${result.items.length} 条):\n\n` +
          result.items
            .map((i) => `${i.rank}. ${i.title}${i.url ? `\n   ${i.url}` : ""}${i.description ? `\n   ${i.description.slice(0, 100)}` : ""}`)
            .join("\n\n")
        : `搜索失败: ${result.error}`;
      return toMcpContent(ok, text, result);
    },
  );

  srv.tool(
    "news_summary",
    descriptions.news_summary,
    {
      url: z.string().optional().describe("新闻链接"),
      title: z.string().optional().describe("新闻标题"),
      content: z.string().optional().describe("新闻正文"),
    },
    async ({ url, title, content }) => {
      if (!url && !title && !content) {
        return toMcpContent(false, "需要 url 或 title/content", undefined, true);
      }
      try {
        let text = "";
        if (url) {
          text = await fetchUrlContent(url);
        } else {
          text = [title, content].filter(Boolean).join("\n\n");
        }
        const summary = text.length > 500 ? text.slice(0, 500) + "…" : text;
        return toMcpContent(true, summary, { content_length: text.length });
      } catch (e) {
        return toMcpContent(false, e instanceof Error ? e.message : String(e), undefined, true);
      }
    },
  );

  srv.tool(
    "agent_chat",
    descriptions.agent_chat,
    {
      message: z.string().describe("新闻分析任务或问题"),
      maxSteps: z.number().optional().describe("最大推理步数，默认 12"),
    },
    async ({ message, maxSteps }) => {
      try {
        const result = await runAgent(message, agentConfig, { maxSteps });
        return toMcpContent(true, JSON.stringify({
          response: result.content,
          steps: result.steps,
          toolCalls: result.toolCalls.length,
          mode: result.mode,
          finishedAt: result.finishedAt,
        }, null, 2));
      } catch (error) {
        return toMcpContent(false, error instanceof Error ? error.message : String(error), undefined, true);
      }
    },
  );

  srv.tool(
    "agent_status",
    descriptions.agent_status,
    {},
    async () => {
      return toMcpContent(true, JSON.stringify({
        ...SERVER_INFO,
        mode: agentConfig.mode,
        model: agentConfig.mode === "llm" ? agentConfig.model : null,
        baseURL: agentConfig.mode === "llm" ? agentConfig.baseURL : null,
        capabilities: ["hot_news", "news_search", "news_summary", "agent_chat"],
        platforms: PLATFORM_IDS,
      }, null, 2));
    },
  );

  return srv;
}

function toMcpContent(ok: boolean, text: string, data?: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: data ? JSON.stringify({ ok, text, data }, null, 2) : text }],
    isError: isError || !ok,
  };
}

// ─── MCP Transport ────────────────────────────────────────────────────
const mcpTransports = new Map<string, StreamableHTTPServerTransport>();

async function handleMcpRequest(req: IncomingMessage, res: ServerResponse) {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (req.method === "POST" && !sessionId) {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
    const mcpServer = createMcpServer();
    await mcpServer.connect(transport);
    transport.onclose = () => { if (transport.sessionId) mcpTransports.delete(transport.sessionId); };
    await transport.handleRequest(req, res);
    if (transport.sessionId) mcpTransports.set(transport.sessionId, transport);
    return;
  }

  if (sessionId && mcpTransports.has(sessionId)) {
    await mcpTransports.get(sessionId)!.handleRequest(req, res);
    return;
  }

  if (req.method === "GET" && !sessionId) {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
    const mcpServer = createMcpServer();
    await mcpServer.connect(transport);
    transport.onclose = () => { if (transport.sessionId) mcpTransports.delete(transport.sessionId); };
    await transport.handleRequest(req, res);
    if (transport.sessionId) mcpTransports.set(transport.sessionId, transport);
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "session not found" }));
}

// ─── REST handlers ────────────────────────────────────────────────────
async function handleRest(req: IncomingMessage, res: ServerResponse, path: string) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type,mcp-session-id");
  if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }

  if (req.method === "GET" && (path === "/" || path === "/info")) {
    return json(res, 200, {
      ...SERVER_INFO,
      mode: agentConfig.mode,
      model: agentConfig.mode === "llm" ? agentConfig.model : null,
      platforms: PLATFORM_IDS,
      transports: {
        rest: `http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`,
        mcp_streamable_http: `http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}/mcp`,
        mcp_stdio: "npx tsx src/mcp.ts",
      },
      endpoints: {
        hot: "POST /hot { platform?, count? }",
        search: "POST /search { keyword, count? }",
        summary: "POST /summary { url? | title? + content? }",
        agent: "POST /agent { message, maxSteps? }",
        config: "GET /config",
        health: "GET /health",
        mcp: "POST/GET /mcp (MCP Streamable HTTP)",
      },
    });
  }

  if (req.method === "GET" && path === "/health") {
    return json(res, 200, { ok: true, server: SERVER_INFO.name, mode: agentConfig.mode });
  }

  if (req.method === "GET" && path === "/config") {
    return html(res, 200, renderConfigPage());
  }

  if (req.method === "GET" && path === "/api/tool-descriptions") {
    const overrides = loadOverrides();
    const tools = Object.keys(DEFAULT_DESCRIPTIONS).map((name) => ({
      name,
      defaultDescription: DEFAULT_DESCRIPTIONS[name],
      description: overrides[name] ?? DEFAULT_DESCRIPTIONS[name],
      overridden: name in overrides,
    }));
    return json(res, 200, { tools });
  }
  if (req.method === "PUT" && path === "/api/tool-descriptions") {
    const body = (await readJson(req)) as Record<string, unknown>;
    if (!body || typeof body !== "object")
      return json(res, 400, { error: "expected object { toolName: description }" });
    const map: Record<string, string> = {};
    for (const [name, desc] of Object.entries(body)) {
      if (name in DEFAULT_DESCRIPTIONS && typeof desc === "string") map[name] = desc;
    }
    saveOverrides(map);
    return json(res, 200, { ok: true, saved: Object.keys(map) });
  }

  if (req.method === "GET" && path === "/api/model-config") {
    const m = loadModelConfig();
    return json(res, 200, {
      mode: m.mode, source: m.source, baseURL: m.baseURL, model: m.model, provider: m.provider,
      apiMode: m.apiMode ?? null,
      apiKeyMasked: m.apiKey ? `${m.apiKey.slice(0, 6)}…${m.apiKey.slice(-4)}` : "",
      hasApiKey: Boolean(m.apiKey), file: modelConfigFilePath,
    });
  }
  if (req.method === "PUT" && path === "/api/model-config") {
    const body = (await readJson(req)) as Record<string, unknown>;
    if (!body || typeof body !== "object") return json(res, 400, { error: "expected object" });
    saveModelConfig({
      apiKey: typeof body.apiKey === "string" ? body.apiKey : undefined,
      baseURL: typeof body.baseURL === "string" ? body.baseURL : undefined,
      model: typeof body.model === "string" ? body.model : undefined,
      provider: typeof body.provider === "string" ? body.provider : undefined,
    });
    return json(res, 200, { ok: true });
  }
  if (req.method === "DELETE" && path === "/api/model-config") {
    clearModelConfig();
    return json(res, 200, { ok: true });
  }

  if (req.method === "POST" && path === "/hot") {
    const body = (await readJson(req)) as Record<string, unknown>;
    const platform = typeof body.platform === "string" ? body.platform : "all";
    const count = typeof body.count === "number" ? body.count : 20;
    const results = await fetchHotNews(platform, count);
    const ok = results.some((r) => r.items.length > 0);
    return json(res, ok ? 200 : 502, { ok, results });
  }

  if (req.method === "POST" && path === "/search") {
    const body = (await readJson(req)) as Record<string, unknown>;
    const keyword = body.keyword;
    if (typeof keyword !== "string" || !keyword.trim())
      return json(res, 400, { error: "body.keyword required" });
    const result = await searchNews(keyword, typeof body.count === "number" ? body.count : 10);
    const ok = !result.error || result.items.length > 0;
    return json(res, ok ? 200 : 502, { ok, ...result });
  }

  if (req.method === "POST" && path === "/summary") {
    const body = (await readJson(req)) as Record<string, unknown>;
    const { url: inputUrl, title, content } = body as Record<string, string | undefined>;
    if (!inputUrl && !title && !content)
      return json(res, 400, { error: "需要 url 或 title/content" });
    try {
      let text = "";
      if (inputUrl) text = await fetchUrlContent(inputUrl);
      else text = [title, content].filter(Boolean).join("\n\n");
      const summary = text.length > 500 ? text.slice(0, 500) + "…" : text;
      return json(res, 200, { ok: true, summary, content_length: text.length });
    } catch (e) {
      return json(res, 502, { ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  if (req.method === "POST" && path === "/agent") {
    const body = (await readJson(req)) as Record<string, unknown>;
    const message = body.message;
    if (typeof message !== "string" || !message.trim())
      return json(res, 400, { error: "body.message required" });
    const result = await runAgent(message, agentConfig, {
      maxSteps: typeof body.maxSteps === "number" ? body.maxSteps : undefined,
    });
    return json(res, 200, result);
  }

  return json(res, 404, { error: "not found", path });
}

// ─── Unified HTTP Server ──────────────────────────────────────────────
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname;
  try {
    if (path === "/mcp" || path.startsWith("/mcp/")) {
      return await handleMcpRequest(req, res);
    }
    return await handleRest(req, res, path);
  } catch (err) {
    if (!res.headersSent) {
      json(res, 500, { error: err instanceof Error ? err.message : "internal error" });
    }
  }
});

server.listen(PORT, HOST, () => {
  const base = `http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`;
  console.log(`[news-demo] v2.0.0 — unified server`);
  console.log(`  REST API:        ${base}/`);
  console.log(`  MCP (HTTP):      ${base}/mcp`);
  console.log(`  MCP (stdio):     npx tsx src/mcp.ts`);
  console.log(`  Config page:     ${base}/config`);
  console.log(`  Mode: ${agentConfig.mode}${agentConfig.mode === "llm" ? ` (${agentConfig.model})` : " (no LLM key — local fallback)"}`);
  console.log(`  Platforms: ${PLATFORM_IDS.join(", ")}`);
  console.log();

  if (INTERACTIVE) startInteractiveIO();
});

// ─── Interactive IO ───────────────────────────────────────────────────
function startInteractiveIO() {
  import("node:readline").then(({ createInterface }) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const base = `http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`;

    console.log("  交互模式 — 输入关键词搜索新闻，或使用命令：");
    console.log("  /hot [platform]    获取热榜（weibo/zhihu/baidu/douyin/36kr/all）");
    console.log("  /status            查看配置");
    console.log("  /agent <message>   委派给 agent");
    console.log("  /quit              退出");
    console.log(`  REST:  ${base}/hot | /search | /summary | /agent`);
    console.log();

    rl.on("line", async (line: string) => {
      const input = line.trim();
      if (!input) return;

      if (input === "/quit" || input === "/exit") {
        rl.close();
        process.exit(0);
      }

      if (input === "/status") {
        console.log(JSON.stringify({
          mode: agentConfig.mode,
          model: agentConfig.model,
          provider: agentConfig.provider,
          platforms: PLATFORM_IDS,
        }, null, 2));
        return;
      }

      if (input.startsWith("/hot")) {
        const platform = input.slice(4).trim() || "all";
        console.log(`正在获取 ${platform} 热榜...`);
        const results = await fetchHotNews(platform, 20);
        for (const r of results) {
          if (r.error && !r.items.length) {
            console.log(`[${r.platform}] 失败: ${r.error}`);
          } else {
            console.log(`\n[${r.platform}] ${r.items.length} 条`);
            r.items.slice(0, 10).forEach((i) =>
              console.log(`  ${String(i.rank).padStart(2)}. ${i.title}${i.hot_value ? ` (${i.hot_value})` : ""}`),
            );
          }
        }
        return;
      }

      if (input.startsWith("/agent ")) {
        const message = input.slice(7).trim();
        if (!message) { console.log("用法: /agent <message>"); return; }
        console.log("agent 处理中...");
        try {
          const result = await runAgent(message, agentConfig);
          console.log(`[${result.mode}] ${result.steps} 步, ${result.toolCalls.length} 次工具调用`);
          console.log(result.content);
        } catch (err) {
          console.log(`失败: ${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }

      // Default: treat as keyword search
      console.log(`搜索"${input}"...`);
      const result = await searchNews(input, 10);
      if (result.error && !result.items.length) {
        console.log(`搜索失败: ${result.error}`);
        return;
      }
      console.log(`\n"${result.keyword}" 结果 (${result.items.length} 条):`);
      result.items.forEach((i) =>
        console.log(`  ${i.rank}. ${i.title}${i.url ? `\n     ${i.url}` : ""}`),
      );
    });

    rl.on("close", () => { /* keep server */ });
  });
}

// ─── Utils ────────────────────────────────────────────────────────────
function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

function html(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (err) { reject(err); }
    });
    req.on("error", reject);
  });
}
