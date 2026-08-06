import {
  AgentRuntime,
} from "../../../packages/ekko-agent/src/runtime/runtime";
import type { AgentRuntimeEvent } from "../../../packages/ekko-agent/src/runtime/events";
import type { AgentRuntimeRunResult } from "../../../packages/ekko-agent/src/runtime/types";
import { AgentToolRegistry } from "../../../packages/ekko-agent/src/tools/registry";
import { createProviderConfig, requestStyleForConfig } from "../../../packages/ekko-agent/src/model/provider-config";
import { createModelClient } from "../../../packages/ekko-agent/src/model/registry";
import {
  HotNewsTool,
  SearchNewsTool,
  fetchHotNews,
  searchNews,
  formatHotNews,
} from "./news-tool.js";
import { loadModelConfig } from "./model-config.js";

/**
 * 新闻热点子 agent —— 基于 ekko-agent AgentRuntime（Hermes 同款引擎）。
 *
 * LLM 模式：自己的模型客户端 + hot_news / search_news 工具，能理解复杂问题、
 *   规划搜索策略、汇总多平台热点、生成分析报告。
 * local 模式（无 key 兜底）：把用户输入拆解为平台/关键词直接调工具，
 *   证明「派发 → 抓取 → 回传」链路通，不需要 LLM。
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
  registry.registerMany([new HotNewsTool(), new SearchNewsTool()]);
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

/** local 兜底 —— 直接调 fetchHotNews / searchNews，不需要 LLM。 */
async function runLocal(
  input: string,
  opts: AgentRunOptions,
): Promise<AgentRunResult> {
  const events: AgentEvent[] = [];
  const toolCalls: AgentRunResult["toolCalls"] = [];
  const emit = (type: string, data: Record<string, unknown>, step: number) => {
    const ev: AgentEvent = { type, data, step, ts: Date.now() };
    events.push(ev);
    opts.onEvent?.(ev);
  };

  const step = 0;
  emit("agent.thinking", { step, mode: "local" }, step);

  // 判断请求类型
  const lowered = input.toLowerCase();
  const isSearch =
    lowered.includes("搜索") ||
    lowered.includes("search") ||
    lowered.includes("查找") ||
    lowered.includes("查询");

  if (isSearch) {
    // 提取关键词（去掉命令词）
    const keyword = input
      .replace(/搜索|查找|查询|search|新闻|关键词/gi, "")
      .trim() || input;
    emit("agent.tool_call", { name: "search_news", args: { keyword } }, step);
    const result = await searchNews(keyword, 10);
    const ok = !result.error || result.items.length > 0;
    emit("agent.tool_result", { name: "search_news", ok, output: result }, step);
    toolCalls.push({ name: "search_news", args: { keyword }, ok });
    const content = ok
      ? `搜索"${keyword}"结果 (${result.items.length} 条):\n\n` +
        result.items
          .map((i) => `${i.rank}. ${i.title}${i.url ? `\n   ${i.url}` : ""}`)
          .join("\n\n")
      : `搜索失败: ${result.error}。本地模式 — 配置 AGENT_MODEL_KEY 启用 LLM 引擎。`;
    emit("agent.message", { content }, step);
    return {
      content,
      steps: 1,
      toolCalls,
      events,
      mode: "local",
      finishedAt: new Date().toISOString(),
    };
  }

  // 默认抓取全平台热榜
  const platform = detectPlatform(input);
  emit("agent.tool_call", { name: "hot_news", args: { platform, count: 20 } }, step);
  const results = await fetchHotNews(platform, 20);
  const ok = results.some((r) => r.items.length > 0);
  emit("agent.tool_result", { name: "hot_news", ok, output: results }, step);
  toolCalls.push({ name: "hot_news", args: { platform, count: 20 }, ok });

  const content = ok
    ? formatHotNews(results)
    : `获取热榜失败。本地模式 — 配置 AGENT_MODEL_KEY 启用 LLM 引擎。\n` +
      results.map((r) => `[${r.platform}] ${r.error ?? "无数据"}`).join("\n");

  emit("agent.message", { content }, step);
  return {
    content,
    steps: 1,
    toolCalls,
    events,
    mode: "local",
    finishedAt: new Date().toISOString(),
  };
}

/** 从输入文本中检测目标平台。 */
function detectPlatform(input: string): string {
  const lower = input.toLowerCase();
  if (lower.includes("微博") || lower.includes("weibo")) return "weibo";
  if (lower.includes("知乎") || lower.includes("zhihu")) return "zhihu";
  if (lower.includes("百度") || lower.includes("baidu")) return "baidu";
  if (lower.includes("抖音") || lower.includes("douyin")) return "douyin";
  if (lower.includes("36kr") || lower.includes("36氪")) return "36kr";
  return "all";
}

/** ekko-agent 事件映射。 */
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
