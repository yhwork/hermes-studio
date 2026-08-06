import { exec } from "node:child_process";
import {
  AgentRuntime,
} from "../../../packages/ekko-agent/src/runtime/runtime";
import type { AgentRuntimeEvent } from "../../../packages/ekko-agent/src/runtime/events";
import type { AgentRuntimeRunResult } from "../../../packages/ekko-agent/src/runtime/types";
import { AgentToolRegistry } from "../../../packages/ekko-agent/src/tools/registry";
import { createTerminalTools } from "../../../packages/ekko-agent/src/tools/terminal";
import { createFileTools } from "../../../packages/ekko-agent/src/tools/files";
import { createProviderConfig, requestStyleForConfig } from "../../../packages/ekko-agent/src/model/provider-config";
import { createModelClient } from "../../../packages/ekko-agent/src/model/registry";
import { loadModelConfig } from "./model-config.js";
import { loadSkills } from "./skill-loader.js";

/**
 * The agent — built on the SAME engine as Hermes (`ekko-agent`'s `AgentRuntime`).
 *
 * This is not a hand-rolled loop: it reuses Hermes's real tool-calling runtime
 * (system prompt, model client, tool registry, step accounting, event stream),
 * just wired into a standalone HTTP/WS/JSON-RPC service for testing.
 *
 * When no model is configured (`AGENT_MODEL_KEY` unset), it falls back to a
 * local rule-based reasoner so the demo still proves dispatch → execute → return
 * without an LLM. With a key set, it's the genuine Hermes agent.
 */

export interface AgentEvent {
  type: string;
  step: number;
  data: Record<string, unknown>;
  ts: number;
}

export interface AgentRunResult {
  content: string;
  steps: number;
  toolCalls: Array<{ name: string; args: unknown; ok: boolean }>;
  events: AgentEvent[];
  mode: AgentConfig["mode"];
  model?: string;
  finishedAt: string;
}

export interface AgentRunOptions {
  maxSteps?: number;
  cwd?: string;
  onEvent?: (event: AgentEvent) => void;
  signal?: AbortSignal;
}

export interface AgentConfig {
  mode: "llm" | "local";
  baseURL: string;
  apiKey: string;
  model: string;
  provider: string;
  apiMode?: string;
}

const HERE = typeof __dirname !== "undefined" ? __dirname : process.cwd();
const MAX_STEPS = 12;
const COMMAND_TIMEOUT_MS = 30_000;

let runtimeCache: AgentRuntime | null = null;

function getRuntime(): AgentRuntime {
  if (runtimeCache) return runtimeCache;
  const registry = new AgentToolRegistry();
  registry.registerMany([...createTerminalTools(), ...createFileTools()]);
  const skills = loadSkills(HERE);
  runtimeCache = new AgentRuntime({
    tools: registry,
    toolsEnabled: true,
    skillsEnabled: skills.length > 0,
    skills,
  });
  return runtimeCache;
}

export function loadAgentConfig(): AgentConfig {
  const m = loadModelConfig();
  return { mode: m.mode, baseURL: m.baseURL, apiKey: m.apiKey, model: m.model, provider: m.provider, apiMode: m.apiMode };
}

export async function runAgent(
  input: string,
  config: AgentConfig,
  opts: AgentRunOptions = {},
): Promise<AgentRunResult> {
  if (config.mode === "local") {
    return runLocal(input, opts);
  }
  return runEkko(input, config, opts);
}

/** Real Hermes engine run. */
async function runEkko(
  input: string,
  config: AgentConfig,
  opts: AgentRunOptions,
): Promise<AgentRunResult> {
  const maxSteps = opts.maxSteps ?? MAX_STEPS;
  const events: AgentEvent[] = [];
  const toolCalls: AgentRunResult["toolCalls"] = [];
  const emit = (ev: AgentEvent) => {
    events.push(ev);
    opts.onEvent?.(ev);
  };

  const requestStyle = requestStyleForConfig(config.provider, config.baseURL, config.apiMode);
  const providerConfig = createProviderConfig({
    provider: config.provider,
    requestStyle,
    baseUrl: config.baseURL,
    apiKey: config.apiKey,
    model: config.model,
    timeoutMs: 120_000,
  });
  const modelClient = createModelClient(providerConfig);

  const runtime = getRuntime();
  const result: AgentRuntimeRunResult = await runtime.run({
    messages: [input],
    modelClient,
    model: config.model,
    maxSteps,
    signal: opts.signal,
    toolContext: { cwd: opts.cwd ?? process.cwd(), workspaceRoot: opts.cwd ?? process.cwd() },
    onEvent: (e: AgentRuntimeEvent) => emit(mapEkkoEvent(e)),
  });

  // Collect tool calls from steps.
  for (const step of result.steps) {
    if (step.type === "tool") {
      toolCalls.push({
        name: step.toolName,
        args: (step as { arguments?: Record<string, unknown> }).arguments ?? {},
        ok: (step.result as { ok?: boolean }).ok ?? true,
      });
    }
  }

  const rawContent = result.output?.content;
  const content = typeof rawContent === "string" ? rawContent : rawContent != null ? JSON.stringify(rawContent) : "";

  return {
    content,
    steps: result.steps.length,
    toolCalls,
    events,
    mode: "llm",
    model: config.model,
    finishedAt: new Date().toISOString(),
  };
}

/** Local fallback — no LLM key, but still demonstrates think → tool → answer. */
async function runLocal(input: string, opts: AgentRunOptions): Promise<AgentRunResult> {
  const events: AgentEvent[] = [];
  const toolCalls: AgentRunResult["toolCalls"] = [];
  const emit = (type: string, data: Record<string, unknown>, step: number) => {
    const ev: AgentEvent = { type, data, step, ts: Date.now() };
    events.push(ev);
    opts.onEvent?.(ev);
  };

  const step = 0;
  emit("agent.thinking", { step, mode: "local" }, step);

  const cmdMatch =
    input.match(/```(?:sh|bash)?\s*([\s\S]+?)```/) ||
    input.match(/`([^`\n]+)`/) ||
    input.match(/(?:^|\s)(?:run|run_command)[:\s]+`?([^`\n]+)`?/i) ||
    input.match(/\$\s+(.+)/);

  if (cmdMatch) {
    const command = cmdMatch[1].trim();
    emit("agent.tool_call", { name: "terminal_exec", args: { command } }, step);
    const output = await runCommand(command, opts.cwd);
    const ok = output.exitCode === 0;
    emit("agent.tool_result", { name: "terminal_exec", ok, output }, step);
    toolCalls.push({ name: "terminal_exec", args: { command }, ok });
    const content = ok
      ? `Ran \`${command}\` (exit 0). Output:\n${output.stdout || JSON.stringify(output, null, 2)}`
      : `Ran \`${command}\` and it failed (exit ${output.exitCode}): ${output.stderr}`;
    emit("agent.message", { content }, step);
    return { content, steps: 1, toolCalls, events, mode: "local", finishedAt: new Date().toISOString() };
  }

  const content = `agent-demo (local mode) received: "${input}". No LLM key configured — set AGENT_MODEL_KEY to enable the real Hermes engine.`;
  emit("agent.message", { content }, step);
  return { content, steps: 1, toolCalls, events, mode: "local", finishedAt: new Date().toISOString() };
}

/** Map ekko-agent runtime events to our flat event stream. */
function mapEkkoEvent(e: AgentRuntimeEvent): AgentEvent {
  const step = "step" in e ? (e as { step: number }).step : 0;
  const ts = Date.now();
  switch (e.type) {
    case "model.started":
      return { type: "agent.thinking", step, data: { step }, ts };
    case "model.tool_call":
      return { type: "agent.tool_call", step, data: { toolCall: e.toolCall }, ts };
    case "tool.started":
      return { type: "agent.tool_call", step, data: { name: e.toolName, args: e.arguments }, ts };
    case "tool.completed":
      return { type: "agent.tool_result", step, data: { name: e.toolName, ok: true, output: e.result, durationMs: e.durationMs }, ts };
    case "tool.failed":
      return { type: "agent.tool_result", step, data: { name: e.toolName, ok: false, output: e.result, durationMs: e.durationMs }, ts };
    case "model.message":
      return { type: "agent.message", step, data: { message: e.message }, ts };
    case "model.reasoning":
      return { type: "agent.reasoning", step, data: { text: e.text }, ts };
    case "model.delta":
      return { type: "agent.delta", step, data: { text: e.text }, ts };
    case "run.completed":
      return { type: "agent.done", step, data: { steps: e.steps }, ts };
    case "run.failed":
      return { type: "agent.error", step, data: { error: e.error, steps: e.steps }, ts };
    case "run.max_steps":
      return { type: "agent.error", step, data: { reason: "max steps", maxSteps: e.maxSteps }, ts };
    default:
      return { type: e.type, step, data: {} as Record<string, unknown>, ts };
  }
}

function runCommand(
  command: string,
  cwd?: string,
): Promise<{ command: string; stdout: string; stderr: string; exitCode: number; durationMs: number }> {
  return new Promise((resolveP) => {
    const start = Date.now();
    exec(command, { cwd, timeout: COMMAND_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      resolveP({
        command,
        stdout: stdout ?? "",
        stderr: stderr ?? "",
        exitCode: err ? (err as NodeJS.ErrnoException & { code?: number }).code ?? 1 : 0,
        durationMs: Date.now() - start,
      });
    });
  });
}
