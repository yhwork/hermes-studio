import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { loadAgentConfig, runAgent, type AgentRunResult } from "./agent.js";
import { generateImage, type GenerateImageInput } from "./image-tool.js";
import { DEFAULT_DESCRIPTIONS, loadOverrides, saveOverrides } from "./tool-descriptions.js";
import { renderConfigPage } from "./config-page.js";
import { loadModelConfig, saveModelConfig, clearModelConfig, modelConfigFilePath } from "./model-config.js";

const SERVER_INFO = { name: "image-gen-demo", version: "1.0.0" };

export interface ServerOptions {
  port?: number;
  host?: string;
}

export function startServer(opts: ServerOptions = {}): { server: Server; url: string; mode: "llm" | "local" } {
  const port = opts.port ?? Number(process.env.PORT ?? 8789);
  const host = opts.host ?? process.env.HOST ?? "127.0.0.1";

  const config = loadAgentConfig();

  const server = createServer(async (req, res) => {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-methods", "GET,POST,PUT,OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type");
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;

    try {
      if (req.method === "GET" && (path === "/" || path === "/info")) {
        return json(res, 200, {
          ...SERVER_INFO,
          mode: config.mode,
          model: config.mode === "llm" ? config.model : null,
          image_api: {
            source: config.imageApi.source,
            base_url: config.imageApi.baseURL || null,
            model: config.imageApi.model || null,
            has_key: Boolean(config.imageApi.apiKey),
          },
          endpoints: {
            generate: "POST /generate { prompt, mode?, size?, image_path?, output_path?, model?, n? }",
            agent: "POST /agent { message, maxSteps? }",
            config: "GET /config (HTML editor)",
            toolDescriptions: "GET/PUT /api/tool-descriptions",
            health: "GET /health",
          },
        });
      }

      if (req.method === "GET" && path === "/health") {
        return json(res, 200, { ok: true, server: SERVER_INFO.name, mode: config.mode, pong: new Date().toISOString() });
      }

      // ── 工具描述配置页 ──
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
        if (!body || typeof body !== "object") return json(res, 400, { error: "expected an object { toolName: description }" });
        const map: Record<string, string> = {};
        for (const [name, desc] of Object.entries(body)) {
          if (name in DEFAULT_DESCRIPTIONS && typeof desc === "string") map[name] = desc;
        }
        saveOverrides(map);
        return json(res, 200, { ok: true, saved: Object.keys(map) });
      }

      // ── 子 agent 独立模型配置 ──
      // GET /api/model-config    返回当前生效配置（含 mode/source，apiKey 脱敏）
      // PUT /api/model-config    提交 { apiKey?, baseURL?, model?, provider? } 写盘
      // DELETE /api/model-config 清空页面配置，回退到 env/默认
      if (req.method === "GET" && path === "/api/model-config") {
        const m = loadModelConfig();
        return json(res, 200, {
          mode: m.mode,
          source: m.source,
          baseURL: m.baseURL,
          model: m.model,
          provider: m.provider,
          apiMode: m.apiMode ?? null,
          apiKeyMasked: m.apiKey ? `${m.apiKey.slice(0, 6)}…${m.apiKey.slice(-4)}` : "",
          hasApiKey: Boolean(m.apiKey),
          file: modelConfigFilePath,
        });
      }
      if (req.method === "PUT" && path === "/api/model-config") {
        const body = (await readJson(req)) as Record<string, unknown>;
        if (!body || typeof body !== "object") return json(res, 400, { error: "expected an object { apiKey?, baseURL?, model?, provider? }" });
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

      // ── 直接生图 ──
      if (req.method === "POST" && path === "/generate") {
        const body = (await readJson(req)) as Record<string, unknown>;
        const prompt = body.prompt;
        if (typeof prompt !== "string" || !prompt.trim()) return json(res, 400, { error: "body.prompt (non-empty string) is required" });
        const input: GenerateImageInput = {
          prompt,
          mode: (body.mode as GenerateImageInput["mode"]) || "text",
          size: typeof body.size === "string" ? body.size : undefined,
          image_path: typeof body.image_path === "string" ? body.image_path : undefined,
          output_path: typeof body.output_path === "string" ? body.output_path : undefined,
          provider: typeof body.provider === "string" ? body.provider : undefined,
          n: typeof body.n === "number" ? body.n : undefined,
        };
        const result = await generateImage(input, config.imageApi);
        return json(res, result.ok ? 200 : 502, { ok: result.ok, content: result.content, data: result.data, error: result.error });
      }

      // ── 委派给 agent（LLM/local） ──
      if (req.method === "POST" && path === "/agent") {
        const body = (await readJson(req)) as Record<string, unknown>;
        const message = body.message;
        if (typeof message !== "string" || !message.trim()) return json(res, 400, { error: "body.message (non-empty string) is required" });
        const result: AgentRunResult = await runAgent(message, config, {
          maxSteps: typeof body.maxSteps === "number" ? body.maxSteps : undefined,
        });
        return json(res, 200, result);
      }

      return json(res, 404, { error: "not found", path });
    } catch (err) {
      return json(res, 400, { error: err instanceof Error ? err.message : "bad request" });
    }
  });

  server.listen(port, host);
  const url = `http://${host}:${port}`;
  return { server, url, mode: config.mode };
}

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
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}
