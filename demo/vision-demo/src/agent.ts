import {
  AgentRuntime,
} from "../../../packages/ekko-agent/src/runtime/runtime";
import type { AgentRuntimeEvent } from "../../../packages/ekko-agent/src/runtime/events";
import type { AgentRuntimeRunResult } from "../../../packages/ekko-agent/src/runtime/types";
import { AgentToolRegistry } from "../../../packages/ekko-agent/src/tools/registry";
import { createProviderConfig, requestStyleForConfig } from "../../../packages/ekko-agent/src/model/provider-config";
import { createModelClient } from "../../../packages/ekko-agent/src/model/registry";
import {
  AnalyzeImageTool,
  CompareImagesTool,
  ExtractTextTool,
  DescribeImageTool,
  analyze,
  compareImages,
  extractText,
  describeImage,
} from "./vision-tool.js";
import { loadModelConfig } from "./model-config.js";

/**
 * 视觉子 agent —— 基于 ekko-agent AgentRuntime（Hermes 同款引擎）。
 *
 * - LLM 模式：自己的模型客户端 + analyze_image / compare_images / extract_text / describe_image 工具，
 *   能理解复杂分析任务、规划多图分析策略、汇总结果。
 * - local 模式（无 key 兜底）：直接调视觉工具，证明「派发 → 分析 → 回传」链路通。
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

const MAX_STEPS = 12;

let runtimeCache: AgentRuntime | null = null;

function getRuntime(): AgentRuntime {
  if (runtimeCache) return runtimeCache;
  const registry = new AgentToolRegistry();
  registry.registerMany([
    new AnalyzeImageTool(),
    new CompareImagesTool(),
    new ExtractTextTool(),
    new DescribeImageTool(),
  ]);
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
  };
}

export async function runAgent(
  input: string,
  config: AgentConfig,
  opts: AgentRunOptions = {},
): Promise<AgentRunResult> {
  if (config.mode === "local") return runLocal(input, opts);
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
    toolContext: {
      cwd: opts.cwd ?? process.cwd(),
      workspaceRoot: opts.cwd ?? process.cwd(),
    },
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
  const content =
    typeof rawContent === "string"
      ? rawContent
      : rawContent != null
      ? JSON.stringify(rawContent)
      : "";

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

/** local 兜底 —— 尝试从输入中提取图片路径/URL，直接调视觉工具。 */
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

  // 从输入中提取图片路径/URL
  // 匹配 HTTP URL（扩展名后允许有查询参数，如 ?name=a.png&token=xxx）
  const imageRegex = /(https?:\/\/[^\s"'<>]*\.(?:png|jpg|jpeg|gif|webp|bmp)[^\s"'<>]*)/gi;
  const urls = input.match(imageRegex) || [];
  // 先把 URL 从输入中去掉，再匹配本地路径（否则 localRegex 的 [./] 会匹配 URL 里的 //）
  const inputWithoutUrls = input.replace(imageRegex, "");
  const localRegex = /(?:[A-Za-z]:[\\/]|[./])[^\s"'<>]+\.(?:png|jpg|jpeg|gif|webp|bmp)/gi;
  const locals = inputWithoutUrls.match(localRegex) || [];
  const images = [...urls, ...locals];

  if (!images.length) {
    const content = "未检测到图片路径或 URL。local 模式需要输入中包含图片路径或 URL。配置 AGENT_MODEL_KEY 启用 LLM 引擎可自动规划分析策略。";
    emit("agent.message", { content }, step);
    return { content, steps: 1, toolCalls, events, mode: "local", finishedAt: new Date().toISOString() };
  }

  // 去掉图片路径，剩下的当 question
  let question = input;
  for (const img of images) {
    question = question.replace(img, "").trim();
  }
  if (!question) question = "请详细描述这张图片的内容。";

  const toolInput = { image: images[0], images: images.length > 1 ? images : undefined, question };
  emit("agent.tool_call", { name: "analyze_image", args: toolInput }, step);

  try {
    const result = images.length > 1
      ? await compareImages(images, question)
      : await analyze(images[0], question);
    const ok = Boolean(result.content);
    emit("agent.tool_result", { name: "analyze_image", ok, output: result.content?.slice(0, 200) }, step);
    toolCalls.push({ name: "analyze_image", args: toolInput, ok });

    const content = result.content || "视觉模型未返回内容";
    emit("agent.message", { content }, step);
    return { content, steps: 1, toolCalls, events, mode: "local", finishedAt: new Date().toISOString() };
  } catch (err) {
    const content = `分析失败: ${err instanceof Error ? err.message : String(err)}`;
    emit("agent.message", { content }, step);
    return { content, steps: 1, toolCalls, events, mode: "local", finishedAt: new Date().toISOString() };
  }
}

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
