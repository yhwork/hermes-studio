import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { loadAgentConfig, runAgent, type AgentRunResult } from "./agent.js";
import { fetchHotNews, searchNews, fetchUrlContent, PLATFORM_IDS } from "./news-tool.js";
import { DEFAULT_DESCRIPTIONS, loadOverrides, saveOverrides } from "./tool-descriptions.js";
import { renderConfigPage } from "./config-page.js";
import { loadModelConfig, saveModelConfig, clearModelConfig, modelConfigFilePath } from "./model-config.js";

const SERVER_INFO = { name: "news-demo", version: "1.0.0" };

export interface ServerOptions {
  port?: number;
  host?: string;
}

export function startServer(opts: ServerOptions = {}): { server: Server; url: string; mode: "llm" | "local" } {
  const port = opts.port ?? Number(process.env.PORT ?? 8790);
  const host = opts.host ?? process.env.HOST ?? "127.0.0.1";

  const config = loadAgentConfig();

  const server = createServer(async (req, res) => {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-methods", "GET,POST,PUT,DELETE,OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type");
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;

    try {
      // ── Info / Health ──
      if (req.method === "GET" && (path === "/" || path === "/info")) {
        return json(res, 200, {
          ...SERVER_INFO,
          mode: config.mode,
          model: config.mode === "llm" ? config.model : null,
          platforms: PLATFORM_IDS,
          endpoints: {
            hot: "POST /hot { platform?, count? }",
            search: "POST /search { keyword, count? }",
            summary: "POST /summary { url? | title? + content? }",
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

      // ── Config page ──
      if (req.method === "GET" && path === "/config") {
        return html(res, 200, renderConfigPage());
      }

      // ── Tool descriptions API ──
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

      // ── Model config API ──
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
        if (!body || typeof body !== "object")
          return json(res, 400, { error: "expected object { apiKey?, baseURL?, model?, provider? }" });
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

      // ── POST /hot — 获取热榜 ──
      if (req.method === "POST" && path === "/hot") {
        const body = (await readJson(req)) as Record<string, unknown>;
        const platform = typeof body.platform === "string" ? body.platform : "all";
        const count = typeof body.count === "number" ? body.count : 20;
        const results = await fetchHotNews(platform, count);
        const ok = results.some((r) => r.items.length > 0);
        return json(res, ok ? 200 : 502, { ok, results });
      }

      // ── POST /search — 搜索新闻 ──
      if (req.method === "POST" && path === "/search") {
        const body = (await readJson(req)) as Record<string, unknown>;
        const keyword = body.keyword;
        if (typeof keyword !== "string" || !keyword.trim())
          return json(res, 400, { error: "body.keyword required" });
        const count = typeof body.count === "number" ? body.count : 10;
        const result = await searchNews(keyword, count);
        const ok = !result.error || result.items.length > 0;
        return json(res, ok ? 200 : 502, { ok, ...result });
      }

      // ── POST /summary — 获取摘要 ──
      if (req.method === "POST" && path === "/summary") {
        const body = (await readJson(req)) as Record<string, unknown>;
        const { url: inputUrl, title, content } = body as Record<string, string | undefined>;
        if (!inputUrl && !title && !content)
          return json(res, 400, { error: "需要 url 或 title/content 参数" });
        try {
          let text = "";
          if (inputUrl) {
            text = await fetchUrlContent(inputUrl);
          } else {
            text = [title, content].filter(Boolean).join("\n\n");
          }
          const summary = text.length > 500 ? text.slice(0, 500) + "…" : text;
          return json(res, 200, { ok: true, summary, content_length: text.length });
        } catch (e) {
          return json(res, 502, { ok: false, error: e instanceof Error ? e.message : String(e) });
        }
      }

      // ── POST /agent — 委派给 agent ──
      if (req.method === "POST" && path === "/agent") {
        const body = (await readJson(req)) as Record<string, unknown>;
        const message = body.message;
        if (typeof message !== "string" || !message.trim())
          return json(res, 400, { error: "body.message required" });
        const result: AgentRunResult = await runAgent(message, config, {
          maxSteps: typeof body.maxSteps === "number" ? body.maxSteps : undefined,
        });
        return json(res, 200, result);
      }

      return json(res, 404, { error: "not found", path });
    } catch (err) {
      return json(res, 500, { error: err instanceof Error ? err.message : "internal error" });
    }
  });

  server.listen(port, host);
  const url = `http://${host}:${port}`;
  return { server, url, mode: config.mode };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function html(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
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
