import { randomUUID } from "node:crypto";
import { request } from "node:https";
import { request as httpRequest } from "node:http";
import { runAgent, type AgentConfig, type AgentEvent, type AgentRunResult } from "./agent.js";

/**
 * Task manager — wraps each agent run as a trackable task.
 *
 * A "task" is a conversation turn dispatched to the sub-agent. Callers can:
 *   - await it synchronously (POST /chat, sync JSON-RPC),
 *   - poll / subscribe / receive a webhook when it finishes (async mode).
 *
 * This is what proves: dispatch succeeded → child thought + executed → result returned.
 */

export type TaskStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled";

export interface Task {
  id: string;
  input: string;
  status: TaskStatus;
  result: AgentRunResult | null;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  callbackUrl: string | null;
  mode: AgentConfig["mode"];
}

export interface CreateTaskOptions {
  input: string;
  async: boolean;
  callbackUrl?: string;
  cwd?: string;
  maxSteps?: number;
}

export type TaskListener = (task: Task, event: string, agentEvent?: AgentEvent) => void;

const MAX_TASKS = 200;

export class TaskManager {
  private tasks = new Map<string, Task>();
  private listeners = new Set<TaskListener>();

  constructor(
    private readonly config: AgentConfig,
    private readonly serverInfo: { name: string; version: string },
  ) {}

  subscribe(listener: TaskListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  list(): Task[] {
    return [...this.tasks.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  async create(opts: CreateTaskOptions): Promise<Task> {
    const task: Task = {
      id: randomUUID(),
      input: opts.input,
      status: "pending",
      result: null,
      error: null,
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      callbackUrl: opts.callbackUrl ?? null,
      mode: this.config.mode,
    };

    this.remember(task);
    this.emit(task, "task.created");

    if (opts.async) {
      void this.run(task, opts);
      return task;
    }

    await this.run(task, opts);
    return task;
  }

  cancel(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task || (task.status !== "pending" && task.status !== "running")) return false;
    task.status = "cancelled";
    task.finishedAt = Date.now();
    this.emit(task, "task.cancelled");
    return true;
  }

  // --- internals ---

  private async run(task: Task, opts: CreateTaskOptions): Promise<void> {
    task.status = "running";
    task.startedAt = Date.now();
    this.emit(task, "task.started");

    try {
      const result = await runAgent(task.input, this.config, {
        cwd: opts.cwd,
        maxSteps: opts.maxSteps,
        onEvent: (ev) => this.emit(task, "task.agent_event", ev),
      });
      if ((task.status as TaskStatus) === "cancelled") return;
      task.result = result;
      task.status = "succeeded";
      task.finishedAt = Date.now();
      this.emit(task, "task.succeeded");
      this.maybeCallback(task);
    } catch (err) {
      if ((task.status as TaskStatus) === "cancelled") return;
      task.error = err instanceof Error ? err.message : String(err);
      task.status = "failed";
      task.finishedAt = Date.now();
      this.emit(task, "task.failed");
      this.maybeCallback(task);
    }
  }

  private emit(task: Task, event: string, agentEvent?: AgentEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(task, event, agentEvent);
      } catch {
        // listener errors must not break task execution
      }
    }
  }

  private maybeCallback(task: Task): void {
    if (!task.callbackUrl) return;
    const payload = JSON.stringify({
      agent: this.serverInfo,
      event: task.status === "succeeded" ? "task.succeeded" : "task.failed",
      task,
    });
    try {
      const url = new URL(task.callbackUrl);
      const lib = url.protocol === "https:" ? request : httpRequest;
      const req = lib(
        { hostname: url.hostname, port: url.port, path: `${url.pathname}${url.search}`, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } },
        (res) => {
          res.resume();
        },
      );
      req.on("error", () => {});
      req.write(payload);
      req.end();
    } catch {
      // invalid callback url — ignore
    }
  }

  private remember(task: Task): void {
    this.tasks.set(task.id, task);
    if (this.tasks.size > MAX_TASKS) {
      const oldest = [...this.tasks.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
      if (oldest) this.tasks.delete(oldest.id);
    }
  }
}
