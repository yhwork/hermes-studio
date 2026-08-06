import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadMainAgentModelConfig } from "./hermes-config.js";

/**
 * 子 agent 模型配置 —— 优先级：
 *   1. 页面文件 (model-config.json)  —— 子 agent 自己独立的一套（/config 页编辑）
 *   2. 环境变量 (AGENT_MODEL_* / OPENAI_*)
 *   3. 主 agent 配置 (hermes config.yaml) —— 默认继承，跟主 agent 用同一套
 *   4. 默认 / local 兜底
 *
 * 「默认用同一套」= 第 3 层：不配页面 / env 时，自动读 hermes 的 config.yaml，
 * 复用主 agent 的 endpoint / key / 协议（支持 anthropic_messages / chat_completions）。
 *
 * 持久化在源码目录上一层的 `model-config.json`。路径用 `__dirname`，不依赖 cwd
 * （hermes 网关 spawn stdio 时固定以 hermes-studio 根为 CWD）。
 */

const HERE = typeof __dirname !== "undefined" ? __dirname : process.cwd();
const MODEL_CONFIG_FILE = join(HERE, "..", "model-config.json");

export interface ModelConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  provider: string;
  /** 传输协议提示，如 "anthropic_messages" / "chat_completions"；交给 ekko 的 requestStyleForConfig 映射。 */
  apiMode?: string;
}

export type ModelConfigWithMode = ModelConfig & {
  mode: "llm" | "local";
  source: "page" | "env" | "hermes" | "default";
};

const DEFAULTS: ModelConfig = {
  apiKey: "",
  baseURL: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
  provider: "openai",
};

/** 读取页面持久化的配置（部分字段）。 */
function readFileConfig(): Partial<ModelConfig> {
  try {
    if (!existsSync(MODEL_CONFIG_FILE)) return {};
    const raw = readFileSync(MODEL_CONFIG_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Partial<ModelConfig>) : {};
  } catch {
    return {};
  }
}

/**
 * 加载生效的模型配置。优先级：页面文件 > 环境变量 > 主 agent (hermes config.yaml) > 默认。
 * mode 由 apiKey 是否非空决定；source 标记配置来自哪一层。
 */
export function loadModelConfig(): ModelConfigWithMode {
  const file = readFileConfig();

  // 1. 页面文件
  if (file.apiKey && file.apiKey.trim()) {
    return {
      apiKey: file.apiKey.trim(),
      baseURL: (file.baseURL ?? DEFAULTS.baseURL).trim(),
      model: (file.model ?? DEFAULTS.model).trim(),
      provider: (file.provider ?? DEFAULTS.provider).trim(),
      apiMode: file.apiMode,
      mode: "llm",
      source: "page",
    };
  }

  // 2. 环境变量
  const envKey = (process.env.AGENT_MODEL_KEY ?? process.env.OPENAI_API_KEY ?? "").trim();
  if (envKey) {
    return {
      apiKey: envKey,
      baseURL: (process.env.AGENT_MODEL_BASE ?? process.env.OPENAI_BASE_URL ?? DEFAULTS.baseURL).trim(),
      model: (process.env.AGENT_MODEL_NAME ?? process.env.OPENAI_MODEL ?? DEFAULTS.model).trim(),
      provider: (process.env.AGENT_MODEL_PROVIDER ?? DEFAULTS.provider).trim(),
      apiMode: process.env.AGENT_MODEL_API_MODE,
      mode: "llm",
      source: "env",
    };
  }

  // 3. 主 agent 配置（hermes config.yaml）—— 默认继承
  const main = loadMainAgentModelConfig();
  if (main) {
    return {
      apiKey: main.apiKey,
      baseURL: main.baseURL,
      model: main.model,
      provider: main.provider,
      apiMode: main.apiMode,
      mode: "llm",
      source: "hermes",
    };
  }

  // 4. 默认 / local 兜底
  return { ...DEFAULTS, mode: "local", source: "default" };
}

/**
 * 持久化模型配置——与现有文件合并：
 * - 字段未提供（undefined）→ 保持现有值不变
 * - 字段为空字符串 → 清除该字段（回退到 env/默认）
 * - 字段非空 → 写入
 * 这样页面里留空 apiKey 不会误清已有 key。
 */
export function saveModelConfig(cfg: Partial<ModelConfig>): void {
  const existing = readFileConfig();
  const merged: Partial<ModelConfig> = { ...existing };
  for (const k of ["apiKey", "baseURL", "model", "provider"] as const) {
    if (cfg[k] == null) continue; // 未提供 → 保持
    const trimmed = String(cfg[k]).trim();
    if (trimmed) merged[k] = trimmed;
    else delete merged[k]; // 空串 → 清除
  }
  writeFileSync(MODEL_CONFIG_FILE, JSON.stringify(merged, null, 2) + "\n", "utf8");
}

/** 清空页面配置（回退到 env/默认）。 */
export function clearModelConfig(): void {
  writeFileSync(MODEL_CONFIG_FILE, "{}\n", "utf8");
}

export const modelConfigFilePath = MODEL_CONFIG_FILE;
