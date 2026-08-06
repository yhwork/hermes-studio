import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { TaskManager } from "./tasks.js";
import { JsonRpcDispatcher, type JsonRpcRequest, type JsonRpcResponse } from "./jsonrpc.js";
import { isUpgradeRequest, upgrade, type WebSocketConn } from "./ws.js";
import { loadAgentConfig } from "./agent.js";
import { DEFAULT_DESCRIPTIONS, loadOverrides, saveOverrides } from "./tool-descriptions.js";
import { renderConfigPage } from "./config-page.js";
import { loadModelConfig, saveModelConfig, clearModelConfig, modelConfigFilePath } from "./model-config.js";

const SERVER_INFO = { name: "agent-demo", version: "1.0.0" };

export interface ServerOptions {
  port?: number;
  host?: string;
}

export function startServer(opts: ServerOptions = {}): { server: Server; url: string; mode: "llm" | "local" } {
  const port = opts.port ?? Number(process.env.PORT ?? 8787);
  const host = opts.host ?? process.env.HOST ?? "127.0.0.1";

  const config = loadAgentConfig();
  const tasks = new TaskManager(config, SERVER_INFO);
  const rpc = new JsonRpcDispatcher(tasks, SERVER_INFO, config.mode);

  // WS clients subscribed to task lifecycle + agent events.
  const subscribers = new Set<WebSocketConn>();
  tasks.subscribe((task, event, agentEvent) => {
    if (subscribers.size === 0) return;
    const notification: JsonRpcResponse = {
      jsonrpc: "2.0",
      id: null,
      result: { event, taskId: task.id, task: { id: task.id, status: task.status, input: task.input }, agentEvent: agentEvent ?? null },
    };
    const text = JSON.stringify(notification);
    for (const conn of subscribers) {
      try {
        conn.send(text);
      } catch {
        // connection may have closed
      }
    }
  });

  const server = createServer(async (req, res) => {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
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
          endpoints: {
            chat: "POST /chat { message, async?, callbackUrl?, cwd?, maxSteps? }",
            rpc: "POST /rpc (JSON-RPC 2.0: ping, echo, agent.talk, agent.get_task, agent.list_tasks, agent.cancel_task)",
            tasks: "GET /tasks, GET /tasks/:id, POST /tasks/:id/cancel",
            websocket: "ws /ws (JSON-RPC 2.0 + agent event stream)",
          },
        });
      }

      if (req.method === "GET" && path === "/health") {
        return json(res, 200, { ok: true, server: SERVER_INFO.name, mode: config.mode, pong: new Date().toISOString() });
      }

      // ── 工具描述配置页 ──────────────────────────────────────────
      // GET /config                    HTML 编辑页
      // GET /api/tool-descriptions     返回每个工具的默认/生效/是否覆盖
      // PUT /api/tool-descriptions     提交 { name: description } 覆盖写盘
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

      if (req.method === "POST" && path === "/chat") {
        const body = (await readJson(req)) as Record<string, unknown>;
        const message = body.message;
        if (typeof message !== "string" || !message.trim()) return json(res, 400, { error: "body.message (non-empty string) is required" });
        const isAsync = body.async !== undefined ? Boolean(body.async) : false;
        const task = await tasks.create({
          input: message,
          async: isAsync,
          callbackUrl: typeof body.callbackUrl === "string" ? body.callbackUrl : undefined,
          cwd: typeof body.cwd === "string" ? body.cwd : undefined,
          maxSteps: typeof body.maxSteps === "number" ? body.maxSteps : undefined,
        });
        return json(res, isAsync ? 202 : 200, task);
      }

      if (req.method === "POST" && path === "/rpc") {
        const body = await readJson(req);
        return json(res, 200, await dispatchBatch(rpc, body));
      }

      if (req.method === "GET" && path === "/tasks") {
        return json(res, 200, tasks.list());
      }

      const taskMatch = path.match(/^\/tasks\/([^/]+)$/);
      if (req.method === "GET" && taskMatch) {
        const task = tasks.get(taskMatch[1]);
        if (!task) return json(res, 404, { error: "task not found" });
        return json(res, 200, task);
      }

      const cancelMatch = path.match(/^\/tasks\/([^/]+)\/cancel$/);
      if (req.method === "POST" && cancelMatch) {
        const ok = tasks.cancel(cancelMatch[1]);
        return json(res, ok ? 200 : 404, { ok });
      }

      return json(res, 404, { error: "not found", path });
    } catch (err) {
      return json(res, 400, { error: err instanceof Error ? err.message : "bad request" });
    }
  });

  server.on("upgrade", (req: IncomingMessage, socket) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname !== "/ws" || !isUpgradeRequest(req)) {
      socket.destroy();
      return;
    }

    upgrade(socket, req.headers as Record<string, string | string[] | undefined>, (conn: WebSocketConn) => {
      subscribers.add(conn);
      conn.send(JSON.stringify({ jsonrpc: "2.0", id: null, result: { event: "ws.connected", server: SERVER_INFO, mode: config.mode } }));

      return {
        onMessage: (text) => {
          const parsed = JsonRpcDispatcher.parse(text);
          if (!parsed) {
            conn.send(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }));
            return;
          }
          void dispatchBatch(rpc, parsed).then((responses) => {
            for (const r of responses) conn.send(JSON.stringify(r));
          });
        },
        onClose: () => {
          subscribers.delete(conn);
        },
      };
    });
  });

  server.listen(port, host);
  const url = `http://${host}:${port}`;
  return { server, url, mode: config.mode };
}

async function dispatchBatch(rpc: JsonRpcDispatcher, parsed: unknown): Promise<JsonRpcResponse[]> {
  if (parsed === null || parsed === undefined) {
    return [{ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }];
  }
  const reqs = Array.isArray(parsed) ? (parsed as JsonRpcRequest[]) : [parsed as JsonRpcRequest];
  const responses: JsonRpcResponse[] = [];
  for (const req of reqs) {
    const isNotification = req.id === undefined || req.id === null;
    const res = await rpc.handle(req);
    if (res && !isNotification) responses.push(res);
  }
  return responses;
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
