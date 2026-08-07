/**
 * 统一服务入口 —— 同一端口同时提供：
 *   1. HTTP REST API（/generate, /edit, /read, /validate, /export, /agent, /info, /health, /config…）
 *   2. MCP Streamable HTTP（/mcp 路径，供远程 MCP 客户端连接）
 *   3. 本地交互式 IO（stdin readline，开发调试用）
 *
 * 启动方式：
 *   npx tsx src/serve.ts                     # 默认端口 8792
 *   PORT=9100 npx tsx src/serve.ts           # 自定义端口
 *   npx tsx src/serve.ts --no-interactive    # 不启动交互式 IO
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { loadAgentConfig, runAgent } from "./agent.js";
import {
  generateCases,
  generateCasesFromFile,
  editCases,
  validateCases,
  exportXmind,
} from "./case-tool.js";
import { extractDocument } from "./doc-reader.js";
import { loadModelConfig, saveModelConfig, clearModelConfig, modelConfigFilePath } from "./model-config.js";
import { loadDescriptions, DEFAULT_DESCRIPTIONS, loadOverrides, saveOverrides } from "./tool-descriptions.js";
import { renderConfigPage } from "./config-page.js";

// ─── Config ───────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT ?? 8792);
const HOST = process.env.HOST ?? "0.0.0.0";
const INTERACTIVE = !process.argv.includes("--no-interactive");
const SERVER_INFO = { name: "case-demo", version: "1.0.0" };

const agentConfig = loadAgentConfig();
const descriptions = loadDescriptions();

// ─── MCP Server factory ───────────────────────────────────────────────
function createMcpServer(): McpServer {
  const srv = new McpServer({ name: "case-demo", version: "1.0.0" });

  srv.tool(
    "generate_cases",
    descriptions.generate_cases,
    {
      requirement: z.string().optional(),
      file: z.string().optional(),
      rootTitle: z.string().optional(),
      extraInstructions: z.string().optional(),
    },
    async ({ requirement, file, rootTitle, extraInstructions }) => {
      try {
        let result;
        if (file) {
          result = await generateCasesFromFile(file, { rootTitle, extraInstructions });
        } else {
          if (!requirement?.trim()) return toMcpContent(false, "requirement 或 file 参数必填", undefined, true);
          result = await generateCases(requirement, { rootTitle, extraInstructions });
        }
        return toMcpContent(true, result.markdown, {
          rootTitle: result.rootTitle,
          stats: result.stats,
          model: result.model,
          source: result.source,
          usage: result.usage,
          document: (result as { document?: Record<string, unknown> }).document,
          finishedAt: result.finishedAt,
        });
      } catch (e) {
        return toMcpContent(false, `生成失败: ${e instanceof Error ? e.message : String(e)}`, undefined, true);
      }
    },
  );

  srv.tool(
    "edit_cases",
    descriptions.edit_cases,
    {
      currentMarkdown: z.string(),
      instruction: z.string(),
    },
    async ({ currentMarkdown, instruction }) => {
      if (!currentMarkdown?.trim() || !instruction?.trim())
        return toMcpContent(false, "currentMarkdown 和 instruction 参数必填", undefined, true);
      try {
        const result = await editCases(currentMarkdown, instruction);
        return toMcpContent(true, result.markdown, {
          rootTitle: result.rootTitle,
          stats: result.stats,
          model: result.model,
          finishedAt: result.finishedAt,
        });
      } catch (e) {
        return toMcpContent(false, `编辑失败: ${e instanceof Error ? e.message : String(e)}`, undefined, true);
      }
    },
  );

  srv.tool(
    "read_requirement",
    descriptions.read_requirement,
    { path: z.string(), maxChars: z.number().optional() },
    async ({ path: filePath, maxChars }) => {
      if (!filePath?.trim()) return toMcpContent(false, "path 参数必填", undefined, true);
      try {
        const doc = extractDocument(filePath, maxChars);
        return toMcpContent(true, doc.textContent, {
          filePath: doc.filePath,
          fileType: doc.fileType,
          paragraphCount: doc.paragraphCount,
          truncated: doc.truncated,
        });
      } catch (e) {
        return toMcpContent(false, `读取失败: ${e instanceof Error ? e.message : String(e)}`, undefined, true);
      }
    },
  );

  srv.tool(
    "validate_cases",
    descriptions.validate_cases,
    { markdown: z.string() },
    async ({ markdown }) => {
      if (!markdown?.trim()) return toMcpContent(false, "markdown 参数必填", undefined, true);
      try {
        const result = validateCases(markdown);
        return toMcpContent(true, JSON.stringify({
          ok: result.ok, issues: result.issues, warnings: result.warnings, stats: result.stats,
        }, null, 2), result);
      } catch (e) {
        return toMcpContent(false, `校验失败: ${e instanceof Error ? e.message : String(e)}`, undefined, true);
      }
    },
  );

  srv.tool(
    "export_xmind",
    descriptions.export_xmind,
    { markdown: z.string(), outputPath: z.string(), rootTitle: z.string().optional() },
    async ({ markdown, outputPath, rootTitle }) => {
      if (!markdown?.trim() || !outputPath?.trim())
        return toMcpContent(false, "markdown 和 outputPath 参数必填", undefined, true);
      try {
        const result = exportXmind(markdown, outputPath, rootTitle);
        return toMcpContent(true, `已导出: ${result.path}`, result);
      } catch (e) {
        return toMcpContent(false, `导出失败: ${e instanceof Error ? e.message : String(e)}`, undefined, true);
      }
    },
  );

  srv.tool(
    "agent_chat",
    descriptions.agent_chat,
    { message: z.string(), maxSteps: z.number().optional() },
    async ({ message, maxSteps }) => {
      try {
        const result = await runAgent(message, agentConfig, { maxSteps });
        return toMcpContent(true, JSON.stringify({
          response: result.content, steps: result.steps,
          toolCalls: result.toolCalls.length, mode: result.mode, finishedAt: result.finishedAt,
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
      const m = loadModelConfig();
      return toMcpContent(true, JSON.stringify({
        ...SERVER_INFO,
        agentMode: agentConfig.mode,
        agentModel: agentConfig.mode === "llm" ? agentConfig.model : null,
        llmSource: m.source,
        capabilities: ["generate_cases", "edit_cases", "read_requirement", "validate_cases", "export_xmind", "agent_chat"],
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
      llmModel: agentConfig.mode === "llm" ? agentConfig.model : null,
      transports: {
        rest: `http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`,
        mcp_streamable_http: `http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}/mcp`,
        mcp_stdio: "npx tsx src/mcp.ts",
      },
      endpoints: {
        generate: "POST /generate { requirement?|file?, rootTitle?, extraInstructions? }",
        edit: "POST /edit { currentMarkdown, instruction }",
        read: "POST /read { path, maxChars? }",
        validate: "POST /validate { markdown }",
        export: "POST /export { markdown, outputPath, rootTitle? }",
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
      llmConfigured: agentConfig.mode === "llm",
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

  if (req.method === "POST" && path === "/generate") {
    const body = (await readJson(req)) as Record<string, unknown>;
    try {
      let result;
      if (typeof body.file === "string") {
        result = await generateCasesFromFile(body.file, {
          rootTitle: typeof body.rootTitle === "string" ? body.rootTitle : undefined,
          extraInstructions: typeof body.extraInstructions === "string" ? body.extraInstructions : undefined,
          maxChars: typeof body.maxChars === "number" ? body.maxChars : undefined,
        });
      } else {
        if (typeof body.requirement !== "string" || !body.requirement.trim())
          return json(res, 400, { error: "requirement 或 file 参数必填" });
        result = await generateCases(body.requirement, {
          rootTitle: typeof body.rootTitle === "string" ? body.rootTitle : undefined,
          extraInstructions: typeof body.extraInstructions === "string" ? body.extraInstructions : undefined,
        });
      }
      return json(res, 200, { ok: true, ...result });
    } catch (e) {
      return json(res, 502, { ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  if (req.method === "POST" && path === "/edit") {
    const body = (await readJson(req)) as Record<string, unknown>;
    if (typeof body.currentMarkdown !== "string" || typeof body.instruction !== "string")
      return json(res, 400, { error: "currentMarkdown 和 instruction 参数必填" });
    try {
      const result = await editCases(body.currentMarkdown, body.instruction);
      return json(res, 200, { ok: true, ...result });
    } catch (e) {
      return json(res, 502, { ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  if (req.method === "POST" && path === "/read") {
    const body = (await readJson(req)) as Record<string, unknown>;
    if (typeof body.path !== "string") return json(res, 400, { error: "path 参数必填" });
    try {
      const doc = extractDocument(body.path, typeof body.maxChars === "number" ? body.maxChars : undefined);
      return json(res, 200, { ok: true, ...doc });
    } catch (e) {
      return json(res, 502, { ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  if (req.method === "POST" && path === "/validate") {
    const body = (await readJson(req)) as Record<string, unknown>;
    if (typeof body.markdown !== "string") return json(res, 400, { error: "markdown 参数必填" });
    try {
      const result = validateCases(body.markdown);
      return json(res, 200, { requestOk: true, ...result });
    } catch (e) {
      return json(res, 502, { ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  if (req.method === "POST" && path === "/export") {
    const body = (await readJson(req)) as Record<string, unknown>;
    if (typeof body.markdown !== "string" || typeof body.outputPath !== "string")
      return json(res, 400, { error: "markdown 和 outputPath 参数必填" });
    try {
      const result = exportXmind(body.markdown, body.outputPath, typeof body.rootTitle === "string" ? body.rootTitle : undefined);
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
  console.log(`[case-demo] v1.0.0 — 用例生成 agent 统一服务`);
  console.log(`  REST API:        ${base}/`);
  console.log(`  MCP (HTTP):      ${base}/mcp`);
  console.log(`  MCP (stdio):     npx tsx src/mcp.ts`);
  console.log(`  Config page:     ${base}/config`);
  console.log(`  Agent: ${agentConfig.mode}${agentConfig.mode === "llm" ? ` (${agentConfig.model})` : " (no LLM key — local fallback)"}`);
  console.log();

  if (INTERACTIVE) startInteractiveIO();
});

// ─── Interactive IO ───────────────────────────────────────────────────
function startInteractiveIO() {
  import("node:readline").then(({ createInterface }) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const base = `http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`;

    console.log("  交互模式 — 输入需求文本生成用例，或使用命令：");
    console.log("  /generate <file> [rootTitle]   从需求文档生成用例树");
    console.log("  /edit <instruction>            编辑上一次的用例树（需先 /generate）");
    console.log("  /read <file>                   读取需求文档文本");
    console.log("  /validate                      校验上一次的用例树");
    console.log("  /export <output.xmind>         导出上一次的用例树为 .xmind");
    console.log("  /agent <message>               委派给 agent");
    console.log("  /status                        查看配置");
    console.log("  /quit                          退出");
    console.log(`  REST:  ${base}/generate | /edit | /read | /validate | /export | /agent`);
    console.log();

    let lastMarkdown = "";

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
        }, null, 2));
        return;
      }

      if (input.startsWith("/read ")) {
        const filePath = input.slice(6).trim();
        console.log(`读取: ${filePath}`);
        try {
          const doc = extractDocument(filePath);
          console.log(`[${doc.fileType}] ${doc.paragraphCount} 段${doc.truncated ? "（已截断）" : ""}`);
          console.log(`\n${doc.textContent.slice(0, 2000)}${doc.textContent.length > 2000 ? "\n..." : ""}`);
        } catch (e) {
          console.log(`失败: ${e instanceof Error ? e.message : String(e)}`);
        }
        return;
      }

      if (input.startsWith("/generate ")) {
        const rest = input.slice(10).trim();
        const [filePath, ...titleParts] = rest.split(/\s+/);
        const rootTitle = titleParts.join(" ") || undefined;
        console.log(`从 ${filePath} 生成用例...`);
        try {
          const result = await generateCasesFromFile(filePath, { rootTitle });
          lastMarkdown = result.markdown;
          console.log(`\n${result.markdown}`);
          console.log(`\n--- 模型: ${result.model} | 节点: ${result.stats.totalNodes} | 最深: ${result.stats.maxDepth} | 叶子: ${result.stats.leafCount}`);
        } catch (e) {
          console.log(`失败: ${e instanceof Error ? e.message : String(e)}`);
        }
        return;
      }

      if (input.startsWith("/edit ")) {
        const instruction = input.slice(6).trim();
        if (!lastMarkdown) { console.log("请先 /generate 生成用例树"); return; }
        console.log(`编辑: ${instruction}`);
        try {
          const result = await editCases(lastMarkdown, instruction);
          lastMarkdown = result.markdown;
          console.log(`\n${result.markdown}`);
        } catch (e) {
          console.log(`失败: ${e instanceof Error ? e.message : String(e)}`);
        }
        return;
      }

      if (input === "/validate") {
        if (!lastMarkdown) { console.log("请先 /generate 生成用例树"); return; }
        try {
          const result = validateCases(lastMarkdown);
          console.log(JSON.stringify({ ok: result.ok, issues: result.issues, warnings: result.warnings, stats: result.stats }, null, 2));
        } catch (e) {
          console.log(`失败: ${e instanceof Error ? e.message : String(e)}`);
        }
        return;
      }

      if (input.startsWith("/export ")) {
        const out = input.slice(8).trim();
        if (!lastMarkdown) { console.log("请先 /generate 生成用例树"); return; }
        try {
          const result = exportXmind(lastMarkdown, out);
          console.log(`已导出: ${result.path}（${result.stats.totalNodes} 节点）`);
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

      // 默认：把整行当需求文本生成
      console.log("生成用例...");
      try {
        const result = await generateCases(input);
        lastMarkdown = result.markdown;
        console.log(`\n${result.markdown}`);
        console.log(`\n--- 模型: ${result.model} | 节点: ${result.stats.totalNodes} | 最深: ${result.stats.maxDepth} | 叶子: ${result.stats.leafCount}`);
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
