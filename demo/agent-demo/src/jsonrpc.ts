import type { TaskManager } from "./tasks.js";

/**
 * JSON-RPC 2.0 dispatcher — one handler serves both POST /rpc and the WS channel.
 *
 * Methods:
 *   ping                              → { server, version, pong, mode }
 *   echo        { message }           → message
 *   agent.talk  { message, async?, callbackUrl?, cwd?, maxSteps? }
 *                                     → sync: { task (with result) }; async: { taskId, status }
 *   agent.get_task   { id }           → task
 *   agent.list_tasks                  → task[]
 *   agent.cancel_task { id }          → { ok }
 */

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown> | unknown[];
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export class JsonRpcDispatcher {
  constructor(
    private readonly tasks: TaskManager,
    private readonly serverInfo: { name: string; version: string },
    private readonly mode: "llm" | "local",
  ) {}

  async handle(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    const id = req.id ?? null;

    if (req.jsonrpc !== "2.0" || typeof req.method !== "string") {
      return this.error(id, -32600, "Invalid Request");
    }

    const params = (req.params ?? {}) as Record<string, unknown>;

    try {
      switch (req.method) {
        case "ping":
          return this.ok(id, { server: this.serverInfo.name, version: this.serverInfo.version, mode: this.mode, pong: new Date().toISOString() });

        case "echo":
          if (params.message === undefined) return this.error(id, -32602, "params.message is required");
          return this.ok(id, params.message);

        case "agent.talk": {
          const message = params.message;
          if (typeof message !== "string" || !message.trim()) return this.error(id, -32602, "params.message (non-empty string) is required");
          const isAsync = Boolean(params.async);
          const task = await this.tasks.create({
            input: message,
            async: isAsync,
            callbackUrl: typeof params.callbackUrl === "string" ? params.callbackUrl : undefined,
            cwd: typeof params.cwd === "string" ? params.cwd : undefined,
            maxSteps: typeof params.maxSteps === "number" ? params.maxSteps : undefined,
          });
          if (isAsync) {
            return this.ok(id, { taskId: task.id, status: task.status, createdAt: task.createdAt });
          }
          return this.ok(id, task);
        }

        case "agent.get_task": {
          if (typeof params.id !== "string") return this.error(id, -32602, "params.id is required");
          const task = this.tasks.get(params.id);
          if (!task) return this.error(id, -32601, `task not found: ${params.id}`);
          return this.ok(id, task);
        }

        case "agent.list_tasks":
          return this.ok(id, this.tasks.list());

        case "agent.cancel_task": {
          if (typeof params.id !== "string") return this.error(id, -32602, "params.id is required");
          const ok = this.tasks.cancel(params.id);
          return this.ok(id, { ok });
        }

        default:
          return this.error(id, -32601, `Method not found: ${req.method}`);
      }
    } catch (err) {
      return this.error(id, -32603, err instanceof Error ? err.message : "Internal error");
    }
  }

  static parse(data: string): JsonRpcRequest[] | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return null;
    }
    if (Array.isArray(parsed)) return parsed as JsonRpcRequest[];
    if (parsed && typeof parsed === "object") return [parsed as JsonRpcRequest];
    return null;
  }

  private ok(id: string | number | null, result: unknown): JsonRpcResponse {
    return { jsonrpc: "2.0", id, result };
  }

  private error(id: string | number | null, code: number, message: string, data?: unknown): JsonRpcResponse {
    return { jsonrpc: "2.0", id, error: { code, message, data } };
  }
}
