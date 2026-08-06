import {
  AgentRuntime,
} from "../../../packages/ekko-agent/src/runtime/runtime";
import type { AgentRuntimeEvent } from "../../../packages/ekko-agent/src/runtime/events";
import type { AgentRuntimeRunResult } from "../../../packages/ekko-agent/src/runtime/types";
import { AgentToolRegistry } from "../../../packages/ekko-agent/src/tools/registry";
import { createProviderConfig, requestStyleForConfig } from "../../../packages/ekko-agent/src/model/provider-config";
import { createModelClient } from "../../../packages/ekko-agent/src/model/registry";
import { GenerateImageTool, generateImage, describeInputForLocal, type GenerateImageInput, type ImageApiConfig, loadImageApiConfig } from "./image-tool.js";
import { loadModelConfig } from "./model-config.js";

/**
 * 生图子 agent —— 同样基于 Hermes 同款引擎（ekko-agent 的 AgentRuntime）。
 *
 * - LLM 模式：自己的模型客户端 + generate_image 工具，能理解创意简报、
 *   构造 prompt、按需多次生图/改图、给最终答复。
 * - local 模式（无 key 兜底）：把用户输入当 prompt 直接调 generate_image，
 *   证明「派发 → 生图 → 回传」链路通，不需要 LLM。
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
  imageApi: ImageApiConfig;
}

const MAX_STEPS = 12;

let runtimeCache: AgentRuntime | null = null;

function getRuntime(): AgentRuntime {
  if (runtimeCache) return runtimeCache;
  const registry = new AgentToolRegistry();
  registry.registerMany([new GenerateImageTool()]);
  runtimeCache = new AgentRuntime({
    tools: registry,
    toolsEnabled: true,
    skillsEnabled: false,
  });
  return runtimeCache;
}

export function loadAgentConfig(): AgentConfig {
  const m = loadModelConfig();
  return {
    mode: m.mode,
    baseURL: m.baseURL,
    apiKey: m.apiKey,
    model: m.model,
    provider: m.provider,
    apiMode: m.apiMode,
    imageApi: loadImageApiConfig(),
  };
}

export async function runAgent(
  input: string,
  config: AgentConfig,
  opts: AgentRunOptions = {},
): Promise<AgentRunResult> {
  if (config.mode === "local") return runLocal(input, config, opts);
  return runEkko(input, config, opts);
}

/** LLM 模式 —— 真 Hermes 引擎跑。 */
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

  return { content, steps: result.steps.length, toolCalls, events, mode: "llm", model: config.model, finishedAt: new Date().toISOString() };
}

/** local 兜底 —— 直接拿输入当 prompt 调 generate_image。 */
async function runLocal(input: string, config: AgentConfig, opts: AgentRunOptions): Promise<AgentRunResult> {
  const events: AgentEvent[] = [];
  const toolCalls: AgentRunResult["toolCalls"] = [];
  const emit = (type: string, data: Record<string, unknown>, step: number) => {
    const ev: AgentEvent = { type, data, step, ts: Date.now() };
    events.push(ev);
    opts.onEvent?.(ev);
  };

  const step = 0;
  emit("agent.thinking", { step, mode: "local" }, step);

  const prompt = describeInputForLocal(input);
  const toolInput: GenerateImageInput = { prompt, mode: "text" };
  emit("agent.tool_call", { name: "generate_image", args: toolInput }, step);

  const result = await generateImage(toolInput, config.imageApi);
  const ok = result.ok;
  emit("agent.tool_result", { name: "generate_image", ok, output: result.data ?? result.content }, step);
  toolCalls.push({ name: "generate_image", args: toolInput, ok });

  const content = ok
    ? `Generated an image for prompt: "${prompt}". ${result.content}`
    : `Image generation failed: ${result.content}`;
  emit("agent.message", { content }, step);
  return { content, steps: 1, toolCalls, events, mode: "local", finishedAt: new Date().toISOString() };
}

/** 把 ekko-agent 事件映射成扁平事件流。 */
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
