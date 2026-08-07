/**
 * 统一服务入口 —— 同一端口同时提供：
 *   1. HTTP REST API（/analyze, /compare, /extract, /describe, /agent, /info, /health, /config…）
 *   2. MCP Streamable HTTP（/mcp 路径，供远程 MCP 客户端连接）
 *   3. 本地交互式 IO（stdin readline，开发调试用）
 *
 * 启动方式：
 *   npx tsx src/serve.ts                     # 默认端口 8791
 *   PORT=9000 npx tsx src/serve.ts           # 自定义端口
 *   npx tsx src/serve.ts --no-interactive    # 不启动交互式 IO
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { loadAgentConfig, runAgent } from "./agent.js";
import { analyze, compareImages, extractText, describeImage } from "./vision-tool.js";
import { loadVisionApiConfig } from "./vision-config.js";
import { loadDescriptions, DEFAULT_DESCRIPTIONS, loadOverrides, saveOverrides } from "./tool-descriptions.js";
import { renderConfigPage } from "./config-page.js";
import { loadModelConfig, saveModelConfig, clearModelConfig, modelConfigFilePath } from "./model-config.js";

// ─── Config ───────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT ?? 8791);
const HOST = process.env.HOST ?? "0.0.0.0";
const INTERACTIVE = !process.argv.includes("--no-interactive");
const SERVER_INFO = { name: "vision-demo", version: "1.0.0" };

const agentConfig = loadAgentConfig();
const visionConfig = loadVisionApiConfig();
const descriptions = loadDescriptions();

// ─── MCP Server factory ───────────────────────────────────────────────
function createMcpServer(): McpServer {
  const srv = new McpServer({ name: "vision-demo", version: "1.0.0" });

  srv.tool(
    "analyze_image",
    descriptions.analyze_image,
    {
      image: z.string().optional(),
      images: z.array(z.string()).optional(),
      question: z.string().optional(),
      reasoning: z.boolean().optional(),
    },
    async ({ image, images, question, reasoning }) => {
      const imgs = images ?? (image ? [image] : []);
      if (!imgs.length) return toMcpContent(false, "image 或 images 参数必填", undefined, true);
      try {
        const result = await analyze(imgs, question || "请详细描述这张图片的内容。", { reasoning });
        const text = result.reasoning
          ? `【思考过程】\n${result.reasoning}\n\n【分析结果】\n${result.content}`
          : result.content;
        return toMcpContent(true, text, result);
      } catch (e) {
        return toMcpContent(false, `分析失败: ${e instanceof Error ? e.message : String(e)}`, undefined, true);
      }
    },
  );

  srv.tool(
    "compare_images",
    descriptions.compare_images,
    {
      images: z.array(z.string()),
      question: z.string().optional(),
      reasoning: z.boolean().optional(),
    },
    async ({ images, question, reasoning }) => {
      if (!images || images.length < 2) return toMcpContent(false, "对比至少需要 2 张图片", undefined, true);
      try {
        const result = await compareImages(images, question, { reasoning });
        const text = result.reasoning
          ? `【思考过程】\n${result.reasoning}\n\n【对比结果】\n${result.content}`
          : result.content;
        return toMcpContent(true, text, result);
      } catch (e) {
        return toMcpContent(false, `对比失败: ${e instanceof Error ? e.message : String(e)}`, undefined, true);
      }
    },
  );

  srv.tool(
    "extract_text",
    descriptions.extract_text,
    {
      image: z.string(),
      question: z.string().optional(),
      reasoning: z.boolean().optional(),
    },
    async ({ image, question, reasoning }) => {
      if (!image) return toMcpContent(false, "image 参数必填", undefined, true);
      try {
        const result = await extractText(image, question, { reasoning });
        const text = result.reasoning
          ? `【思考过程】\n${result.reasoning}\n\n【提取结果】\n${result.content}`
          : result.content;
        return toMcpContent(true, text, result);
      } catch (e) {
        return toMcpContent(false, `提取失败: ${e instanceof Error ? e.message : String(e)}`, undefined, true);
      }
    },
  );

  srv.tool(
    "describe_image",
    descriptions.describe_image,
    {
      image: z.string(),
      aspect: z.enum(["general", "ui", "chart", "document", "scene", "code"]).optional(),
      reasoning: z.boolean().optional(),
    },
    async ({ image, aspect, reasoning }) => {
      if (!image) return toMcpContent(false, "image 参数必填", undefined, true);
      try {
        const result = await describeImage(image, aspect || "general", { reasoning });
        const text = result.reasoning
          ? `【思考过程】\n${result.reasoning}\n\n【描述结果】\n${result.content}`
          : result.content;
        return toMcpContent(true, text, { ...result, aspect: aspect || "general" });
      } catch (e) {
        return toMcpContent(false, `描述失败: ${e instanceof Error ? e.message : String(e)}`, undefined, true);
      }
    },
  );

  srv.tool(
    "agent_chat",
    descriptions.agent_chat,
    {
      message: z.string(),
      maxSteps: z.number().optional(),
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
        agentMode: agentConfig.mode,
        agentModel: agentConfig.mode === "llm" ? agentConfig.model : null,
        visionSource: visionConfig.source,
        visionModel: visionConfig.model,
        reasoningEnabled: visionConfig.reasoningEnabled,
        capabilities: ["analyze_image", "compare_images", "extract_text", "describe_image", "agent_chat"],
        maxSteps: 12,
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
      agentMode: agentConfig.mode,
      visionSource: visionConfig.source,
      visionModel: visionConfig.model,
      reasoningEnabled: visionConfig.reasoningEnabled,
      transports: {
        rest: `http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`,
        mcp_streamable_http: `http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}/mcp`,
        mcp_stdio: "npx tsx src/mcp.ts",
      },
      endpoints: {
        analyze: "POST /analyze { image?|images?, question?, reasoning? }",
        compare: "POST /compare { images: [...], question? }",
        extract: "POST /extract { image, question? }",
        describe: "POST /describe { image, aspect? }",
        agent: "POST /agent { message, maxSteps? }",
        config: "GET /config",
        health: "GET /health",
        mcp: "POST/GET /mcp (MCP Streamable HTTP)",
      },
    });
  }

  if (req.method === "GET" && path === "/health") {
    return json(res, 200, {
      ok: true,
      server: SERVER_INFO.name,
      agentMode: agentConfig.mode,
      visionConfigured: visionConfig.source !== "none",
    });
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

  if (req.method === "POST" && path === "/analyze") {
    const body = (await readJson(req)) as Record<string, unknown>;
    const imgs = Array.isArray(body.images) ? body.images : body.image ? [body.image] : [];
    if (!imgs.length) return json(res, 400, { error: "image 或 images 参数必填" });
    try {
      const result = await analyze(imgs as string[], (body.question as string) || "请详细描述这张图片的内容。", {
        reasoning: typeof body.reasoning === "boolean" ? body.reasoning : undefined,
      });
      return json(res, 200, { ok: true, ...result });
    } catch (e) {
      return json(res, 502, { ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  if (req.method === "POST" && path === "/compare") {
    const body = (await readJson(req)) as Record<string, unknown>;
    if (!Array.isArray(body.images) || body.images.length < 2)
      return json(res, 400, { error: "images 参数需要 2+ 张图片" });
    try {
      const result = await compareImages(body.images as string[], body.question as string | undefined, {
        reasoning: typeof body.reasoning === "boolean" ? body.reasoning : undefined,
      });
      return json(res, 200, { ok: true, ...result });
    } catch (e) {
      return json(res, 502, { ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  if (req.method === "POST" && path === "/extract") {
    const body = (await readJson(req)) as Record<string, unknown>;
    if (typeof body.image !== "string") return json(res, 400, { error: "image 参数必填" });
    try {
      const result = await extractText(body.image, body.question as string | undefined, {
        reasoning: typeof body.reasoning === "boolean" ? body.reasoning : undefined,
      });
      return json(res, 200, { ok: true, ...result });
    } catch (e) {
      return json(res, 502, { ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  if (req.method === "POST" && path === "/describe") {
    const body = (await readJson(req)) as Record<string, unknown>;
    if (typeof body.image !== "string") return json(res, 400, { error: "image 参数必填" });
    try {
      const result = await describeImage(body.image, (body.aspect as string) || "general", {
        reasoning: typeof body.reasoning === "boolean" ? body.reasoning : undefined,
      });
      return json(res, 200, { ok: true, ...result });
    } catch (e) {
      return json(res, 502, { ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  if (req.method === "POST" && path === "/agent") {
    const body = (await readJson(req)) as Record<string, unknown>;
    if (typeof body.message !== "string" || !body.message.trim())
      return json(res, 400, { error: "body.message required" });
    const result = await runAgent(body.message, agentConfig, {
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
  console.log(`[vision-demo] v1.0.0 — unified server`);
  console.log(`  REST API:        ${base}/`);
  console.log(`  MCP (HTTP):      ${base}/mcp`);
  console.log(`  MCP (stdio):     npx tsx src/mcp.ts`);
  console.log(`  Config page:     ${base}/config`);
  console.log(`  Agent: ${agentConfig.mode}${agentConfig.mode === "llm" ? ` (${agentConfig.model})` : " (no LLM key — local fallback)"}`);
  console.log(`  Vision: ${visionConfig.source === "none" ? "❌ 未配置" : `${visionConfig.source} → ${visionConfig.model} (reasoning: ${visionConfig.reasoningEnabled ? "on" : "off"})`}`);
  console.log();

  if (INTERACTIVE) startInteractiveIO();
});

// ─── Interactive IO ───────────────────────────────────────────────────
function startInteractiveIO() {
  import("node:readline").then(({ createInterface }) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const base = `http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`;

    console.log("  交互模式 — 输入图片路径/URL 分析，或使用命令：");
    console.log("  /analyze <image> [question]   分析图片");
    console.log("  /extract <image>              提取文字");
    console.log("  /describe <image> [aspect]    描述图片 (general/ui/chart/document/scene/code)");
    console.log("  /compare <img1> <img2> [...]  对比图片");
    console.log("  /agent <message>              委派给 agent");
    console.log("  /status                       查看配置");
    console.log("  /quit                         退出");
    console.log(`  REST:  ${base}/analyze | /compare | /extract | /describe | /agent`);
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
          agentMode: agentConfig.mode,
          agentModel: agentConfig.model,
          visionSource: visionConfig.source,
          visionModel: visionConfig.model,
          reasoningEnabled: visionConfig.reasoningEnabled,
        }, null, 2));
        return;
      }

      if (input.startsWith("/analyze ")) {
        const rest = input.slice(9).trim();
        const [image, ...qParts] = rest.split(/\s+/);
        const question = qParts.join(" ") || "请详细描述这张图片的内容。";
        console.log(`分析图片: ${image}`);
        try {
          const result = await analyze(image, question);
          if (result.reasoning) console.log(`\n【思考过程】\n${result.reasoning}`);
          console.log(`\n【分析结果】\n${result.content}`);
        } catch (e) {
          console.log(`失败: ${e instanceof Error ? e.message : String(e)}`);
        }
        return;
      }

      if (input.startsWith("/extract ")) {
        const image = input.slice(9).trim();
        console.log(`提取文字: ${image}`);
        try {
          const result = await extractText(image);
          if (result.reasoning) console.log(`\n【思考过程】\n${result.reasoning}`);
          console.log(`\n【提取结果】\n${result.content}`);
        } catch (e) {
          console.log(`失败: ${e instanceof Error ? e.message : String(e)}`);
        }
        return;
      }

      if (input.startsWith("/describe ")) {
        const rest = input.slice(10).trim();
        const [image, aspect] = rest.split(/\s+/);
        console.log(`描述图片 (${aspect || "general"}): ${image}`);
        try {
          const result = await describeImage(image, aspect || "general");
          if (result.reasoning) console.log(`\n【思考过程】\n${result.reasoning}`);
          console.log(`\n【描述结果】\n${result.content}`);
        } catch (e) {
          console.log(`失败: ${e instanceof Error ? e.message : String(e)}`);
        }
        return;
      }

      if (input.startsWith("/compare ")) {
        const images = input.slice(9).trim().split(/\s+/);
        if (images.length < 2) { console.log("用法: /compare <img1> <img2> [...]"); return; }
        console.log(`对比 ${images.length} 张图片...`);
        try {
          const result = await compareImages(images);
          if (result.reasoning) console.log(`\n【思考过程】\n${result.reasoning}`);
          console.log(`\n【对比结果】\n${result.content}`);
        } catch (e) {
          console.log(`失败: ${e instanceof Error ? e.message : String(e)}`);
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

      // 默认：把整行当图片路径分析
      console.log(`分析: ${input}`);
      try {
        const result = await analyze(input, "请详细描述这张图片的内容。");
        if (result.reasoning) console.log(`\n【思考过程】\n${result.reasoning}`);
        console.log(`\n【分析结果】\n${result.content}`);
      } catch (e) {
        console.log(`失败: ${e instanceof Error ? e.message : String(e)}`);
      }
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
