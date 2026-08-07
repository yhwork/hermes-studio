import {
  AgentRuntime,
} from "../../../packages/ekko-agent/src/runtime/runtime";
import type { AgentRuntimeEvent } from "../../../packages/ekko-agent/src/runtime/events";
import type { AgentRuntimeRunResult } from "../../../packages/ekko-agent/src/runtime/types";
import { AgentToolRegistry } from "../../../packages/ekko-agent/src/tools/registry";
import { createProviderConfig, requestStyleForConfig } from "../../../packages/ekko-agent/src/model/provider-config";
import { createModelClient } from "../../../packages/ekko-agent/src/model/registry";
import {
  GenerateCasesTool,
  EditCasesTool,
  ReadRequirementTool,
  ValidateCasesTool,
  ExportXmindTool,
  generateCases,
  generateCasesFromFile,
  editCases,
} from "./case-tool.js";
import { loadModelConfig } from "./model-config.js";

/**
 * 用例生成子 agent —— 基于 ekko-agent AgentRuntime（Hermes 同款引擎）。
 *
 * - LLM 模式：自己的模型客户端 + generate_cases / edit_cases / read_requirement /
 *   validate_cases / export_xmind 工具，能理解复杂任务、规划多步、读写文件、导出 .xmind。
 * - local 模式（无 key 兜底）：直接调单次 generate/edit（仍需 LLM key，否则提示配置）。
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
    new GenerateCasesTool(),
    new EditCasesTool(),
    new ReadRequirementTool(),
    new ValidateCasesTool(),
    new ExportXmindTool(),
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
    timeoutMs: 180_000,
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

/**
 * local 兜底 —— 没有 agent LLM key 时走这条。
 * 仍尝试用 model-config 的 key 跑一次单次生成/编辑；若也没有 key，提示配置。
 */
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

  const cfg = loadModelConfig();
  if (cfg.mode !== "llm" || !cfg.apiKey) {
    const content =
      "用例生成需要 LLM 模型。请在 /config 页填入 API Key + Base URL + Model，或设置 AGENT_MODEL_KEY / OPENAI_API_KEY 环境变量，或确保 hermes config.yaml 已配置主 agent 模型。";
    emit("agent.message", { content }, step);
    return { content, steps: 1, toolCalls, events, mode: "local", finishedAt: new Date().toISOString() };
  }

  // 从输入中提取文件路径（.docx/.xlsx/.txt/.md）
  const fileRegex = /(?:[A-Za-z]:[\\/]|[./])[^\s"'<>]+\.(?:docx|xlsx|txt|md|markdown|json)/i;
  const fileMatch = input.match(fileRegex);
  const question = (fileMatch ? input.replace(fileMatch[0], "") : input).trim();

  try {
    let result;
    if (fileMatch) {
      emit("agent.tool_call", { name: "generate_cases", args: { file: fileMatch[0] } }, step);
      result = await generateCasesFromFile(fileMatch[0], {
        extraInstructions: question || undefined,
      });
    } else {
      emit("agent.tool_call", { name: "generate_cases", args: { requirement: input } }, step);
      result = await generateCases(input);
    }
    toolCalls.push({ name: "generate_cases", args: { file: fileMatch?.[0], question }, ok: true });
    emit("agent.tool_result", { name: "generate_cases", ok: true, output: result.markdown.slice(0, 200) }, step);

    const content = `# 生成结果\n\n${result.markdown}\n\n---\n模型: ${result.model} | 来源: ${result.source} | 节点: ${result.stats.totalNodes} | 最深: ${result.stats.maxDepth} 层 | 叶子: ${result.stats.leafCount}`;
    emit("agent.message", { content }, step);
    return { content, steps: 1, toolCalls, events, mode: "local", finishedAt: new Date().toISOString() };
  } catch (err) {
    const content = `生成失败: ${err instanceof Error ? err.message : String(err)}`;
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

export { editCases };
