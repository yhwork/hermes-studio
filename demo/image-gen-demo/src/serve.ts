/**
 * 统一服务入口 —— 同一端口同时提供：
 *   1. HTTP REST API（/generate, /agent, /info, /health, /config…）
 *   2. MCP Streamable HTTP（/mcp 路径，供远程 MCP 客户端连接）
 *   3. 本地 agent 交互式 IO（stdin readline，开发调试用）
 *
 * 启动方式：
 *   npx tsx src/serve.ts                     # 默认端口 8789，启用全部
 *   PORT=9000 npx tsx src/serve.ts           # 自定义端口
 *   npx tsx src/serve.ts --no-interactive    # 不启动交互式 IO
 *
 * 其他平台 agent 接入方式：
 *   - HTTP REST:  POST http://<host>:8789/generate  { prompt: "..." }
 *   - MCP 远程:   在 config.yaml 的 mcp_servers 里配 url: http://<host>:8789/mcp
 *   - MCP stdio:  用 src/mcp.ts（hermes-agent 本地 spawn）
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { loadAgentConfig, runAgent } from "./agent.js";
import { generateImage, type GenerateImageInput } from "./image-tool.js";
import { loadDescriptions, DEFAULT_DESCRIPTIONS, loadOverrides, saveOverrides } from "./tool-descriptions.js";
import { renderConfigPage } from "./config-page.js";
import { loadModelConfig, saveModelConfig, clearModelConfig, modelConfigFilePath } from "./model-config.js";

// ─── Config ──────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT ?? 8789);
const HOST = process.env.HOST ?? "0.0.0.0";
const INTERACTIVE = !process.argv.includes("--no-interactive");
const SERVER_INFO = { name: "image-gen-demo", version: "2.0.0" };

const agentConfig = loadAgentConfig();
const descriptions = loadDescriptions();

// ─── MCP Server (shared instance for all transports) ──────────────────
function createMcpServer(): McpServer {
  const server = new McpServer({ name: "image-gen-demo", version: "2.0.0" });

  server.tool(
    "image_gen",
    descriptions.image_gen,
    {
      prompt: z.string().describe("The image prompt — describe subject, style, composition, lighting."),
      size: z.string().optional().describe("Image size, e.g. 1024x1024, 1536x1024. Default 1024x1024."),
      output_path: z.string().optional().describe("Absolute output file path."),
      n: z.number().optional().describe("Number of images. Default 1."),
    },
    async ({ prompt, size, output_path, n }) => {
      const result = await generateImage(
        { prompt, mode: "text", size, output_path, n },
        agentConfig.imageApi,
      );
      return toMcpContent(result.ok, result.content, result.data);
    },
  );

  server.tool(
    "image_edit",
    descriptions.image_edit,
    {
      prompt: z.string().describe("How to transform or edit the reference image."),
      image_path: z.string().describe("Absolute path to the reference/source image."),
      mode: z.enum(["image", "edit"]).optional().describe("'image' = image-to-image; 'edit' = in-place edit. Default 'edit'."),
      size: z.string().optional().describe("Output size. Default 1024x1024."),
      output_path: z.string().optional().describe("Absolute output file path."),
    },
    async ({ prompt, image_path, mode, size, output_path }) => {
      const result = await generateImage(
        { prompt, mode: mode || "edit", image_path, size, output_path },
        agentConfig.imageApi,
      );
      return toMcpContent(result.ok, result.content, result.data);
    },
  );

  server.tool(
    "agent_chat",
    descriptions.agent_chat,
    {
      message: z.string().describe("The creative brief or request for the image-generation agent."),
      maxSteps: z.number().optional().describe("Maximum reasoning steps (default 12)."),
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

  server.tool(
    "agent_status",
    descriptions.agent_status,
    {},
    async () => {
      return toMcpContent(true, JSON.stringify({
        ...SERVER_INFO,
        mode: agentConfig.mode,
        model: agentConfig.model,
        baseURL: agentConfig.mode === "llm" ? agentConfig.baseURL : null,
        image_api: {
          source: agentConfig.imageApi.source,
          base_url: agentConfig.imageApi.baseURL || null,
          model: agentConfig.imageApi.model || null,
          has_key: Boolean(agentConfig.imageApi.apiKey),
        },
        capabilities: ["text_to_image", "image_to_image", "image_edit", "agent_chat"],
      }, null, 2));
    },
  );

  server.tool(
    "test_connection",
    "Test image API connectivity.",
    {},
    async () => {
      const cfg = agentConfig.imageApi;
      if (!cfg.apiKey || !cfg.baseURL) {
        return toMcpContent(false, JSON.stringify({
          status: "not_configured",
          message: "IMAGE_API_KEY + IMAGE_BASE_URL not set",
        }, null, 2));
      }
      const url = `${cfg.baseURL.replace(/\/$/, "")}/images/generations`;
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { authorization: `Bearer ${cfg.apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({ model: cfg.model, prompt: "test", n: 1, size: "256x256" }),
          signal: AbortSignal.timeout(30_000),
        });
        if (res.ok) return toMcpContent(true, `OK — ${url}`);
        const data = await res.json().catch(() => ({})) as Record<string, unknown>;
        const errMsg = typeof data.error === "object" ? (data.error as any)?.message || JSON.stringify(data.error) : data.error || res.statusText;
        return toMcpContent(false, `${res.status}: ${errMsg}`);
      } catch (err) {
        return toMcpContent(false, `unreachable: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  return server;
}

function toMcpContent(ok: boolean, text: string, data?: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: data ? JSON.stringify({ ok, text, data }, null, 2) : text }],
    isError: isError || !ok,
  };
}

// ─── MCP Transport (per-session, Streamable HTTP) ────────────────────
const mcpTransports = new Map<string, StreamableHTTPServerTransport>();

async function handleMcpRequest(req: IncomingMessage, res: ServerResponse) {
  // Each new session gets its own McpServer + transport pair
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (req.method === "POST" && !sessionId) {
    // New session — create transport + server
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
    const mcpServer = createMcpServer();
    await mcpServer.connect(transport);
    transport.onclose = () => {
      if (transport.sessionId) mcpTransports.delete(transport.sessionId);
    };
    // handleRequest will set the session header on the response
    await transport.handleRequest(req, res);
    if (transport.sessionId) mcpTransports.set(transport.sessionId, transport);
    return;
  }

  if (sessionId && mcpTransports.has(sessionId)) {
    await mcpTransports.get(sessionId)!.handleRequest(req, res);
    return;
  }

  // Unknown session or no session for GET
  if (req.method === "GET" && !sessionId) {
    // Standalone SSE — create ephemeral transport
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
    const mcpServer = createMcpServer();
    await mcpServer.connect(transport);
    transport.onclose = () => {
      if (transport.sessionId) mcpTransports.delete(transport.sessionId);
    };
    await transport.handleRequest(req, res);
    if (transport.sessionId) mcpTransports.set(transport.sessionId, transport);
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "session not found" }));
}

// ─── HTTP REST handlers ──────────────────────────────────────────────
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
      image_api: {
        source: agentConfig.imageApi.source,
        base_url: agentConfig.imageApi.baseURL || null,
        model: agentConfig.imageApi.model || null,
        has_key: Boolean(agentConfig.imageApi.apiKey),
      },
      transports: {
        rest: `http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`,
        mcp_streamable_http: `http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}/mcp`,
        mcp_stdio: "npx tsx src/mcp.ts",
      },
      endpoints: {
        generate: "POST /generate { prompt, mode?, size?, image_path?, output_path?, model?, n? }",
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
    if (!body || typeof body !== "object") return json(res, 400, { error: "expected object { toolName: description }" });
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

  // ── Direct image generation ──
  if (req.method === "POST" && path === "/generate") {
    const body = (await readJson(req)) as Record<string, unknown>;
    const prompt = body.prompt;
    if (typeof prompt !== "string" || !prompt.trim()) return json(res, 400, { error: "body.prompt required" });
    const input: GenerateImageInput = {
      prompt,
      mode: (body.mode as GenerateImageInput["mode"]) || "text",
      size: typeof body.size === "string" ? body.size : undefined,
      image_path: typeof body.image_path === "string" ? body.image_path : undefined,
      output_path: typeof body.output_path === "string" ? body.output_path : undefined,
      n: typeof body.n === "number" ? body.n : undefined,
    };
    const result = await generateImage(input, agentConfig.imageApi);
    return json(res, result.ok ? 200 : 502, { ok: result.ok, content: result.content, data: result.data, error: result.error });
  }

  // ── Delegate to agent ──
  if (req.method === "POST" && path === "/agent") {
    const body = (await readJson(req)) as Record<string, unknown>;
    const message = body.message;
    if (typeof message !== "string" || !message.trim()) return json(res, 400, { error: "body.message required" });
    const result = await runAgent(message, agentConfig, {
      maxSteps: typeof body.maxSteps === "number" ? body.maxSteps : undefined,
    });
    return json(res, 200, result);
  }

  return json(res, 404, { error: "not found", path });
}

// ─── Unified HTTP Server ─────────────────────────────────────────────
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname;

  try {
    // Route /mcp to MCP Streamable HTTP transport
    if (path === "/mcp" || path.startsWith("/mcp/")) {
      return await handleMcpRequest(req, res);
    }
    // Everything else is REST
    return await handleRest(req, res, path);
  } catch (err) {
    if (!res.headersSent) {
      json(res, 500, { error: err instanceof Error ? err.message : "internal error" });
    }
  }
});

server.listen(PORT, HOST, () => {
  const base = `http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`;
  console.log(`[image-gen-demo] v2.0.0 — unified server`);
  console.log(`  REST API:        ${base}/`);
  console.log(`  MCP (HTTP):      ${base}/mcp`);
  console.log(`  MCP (stdio):     npx tsx src/mcp.ts`);
  console.log(`  Config page:     ${base}/config`);
  console.log(`  Mode: ${agentConfig.mode}${agentConfig.mode === "llm" ? ` (${agentConfig.model})` : ""}`);
  console.log(`  Image API: source=${agentConfig.imageApi.source} model=${agentConfig.imageApi.model || "-"}`);
  console.log();

  if (INTERACTIVE) startInteractiveIO();
});

// ─── Local interactive IO ────────────────────────────────────────────
function startInteractiveIO() {
  import("node:readline").then(({ createInterface }) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });

    console.log("  Interactive mode (type a prompt to generate an image, or /agent <message> to chat)");
    console.log("  Commands: /status, /test, /quit");
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
          image_api: { source: agentConfig.imageApi.source, model: agentConfig.imageApi.model, has_key: Boolean(agentConfig.imageApi.apiKey) },
        }, null, 2));
        return;
      }

      if (input === "/test") {
        console.log("Testing image API connection...");
        const cfg = agentConfig.imageApi;
        if (!cfg.apiKey || !cfg.baseURL) { console.log("❌ Not configured"); return; }
        try {
          const url = `${cfg.baseURL.replace(/\/$/, "")}/images/generations`;
          const res = await fetch(url, {
            method: "POST",
            headers: { authorization: `Bearer ${cfg.apiKey}`, "content-type": "application/json" },
            body: JSON.stringify({ model: cfg.model, prompt: "test", n: 1, size: "256x256" }),
            signal: AbortSignal.timeout(30_000),
          });
          console.log(res.ok ? `✅ Connected (${res.status})` : `❌ ${res.status} ${res.statusText}`);
        } catch (err) {
          console.log(`❌ ${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }

      if (input.startsWith("/agent ")) {
        const message = input.slice(7).trim();
        if (!message) { console.log("Usage: /agent <message>"); return; }
        console.log("🤔 Agent thinking...");
        try {
          const result = await runAgent(message, agentConfig);
          console.log(`✅ [${result.mode}] ${result.steps} steps, ${result.toolCalls.length} tool calls`);
          console.log(result.content);
        } catch (err) {
          console.log(`❌ ${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }

      // Default: treat input as image prompt
      console.log("🎨 Generating image...");
      const result = await generateImage({ prompt: input, mode: "text" }, agentConfig.imageApi);
      if (result.ok) {
        console.log(`✅ ${result.content}`);
      } else {
        console.log(`❌ ${result.content}`);
      }
    });

    rl.on("close", () => { /* noop, keep server running */ });
  });
}

// ─── Utils ───────────────────────────────────────────────────────────
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
