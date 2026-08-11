import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadMainAgentModelConfig } from "./hermes-config.js";

/**
 * 子 agent（ekko-agent 多步推理）的模型配置 —— 优先级：
 *   1. 页面文件 (model-config.json) —— /config 页编辑
 *   2. 环境变量 (AGENT_MODEL_* / OPENAI_*)
 *   3. 主 agent 配置 (hermes config.yaml) —— 默认继承
 *   4. 默认 / local 兜底
 *
 * 注意：这是 agent 多步推理用的文本模型，与 vision-config.ts 的视觉模型独立。
 * agent 通过调用 vision 工具间接获取图像分析能力。
 */

const HERE = typeof __dirname !== "undefined" ? __dirname : process.cwd();
const MODEL_CONFIG_FILE = join(HERE, "..", "model-config.json");

export interface ModelConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  provider: string;
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

export function loadModelConfig(): ModelConfigWithMode {
  const file = readFileConfig();

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

  // env：agent 专用变量 → OPENAI_* → 复用 VISION_*（同一网关同一 key，仅模型名不同）
  const envKey = (
    process.env.AGENT_MODEL_KEY
    ?? process.env.OPENAI_API_KEY
    ?? process.env.VISION_API_KEY
    ?? process.env.PAPERHUB_API_KEY
    ?? ""
  ).trim();
  const envBase = (
    process.env.AGENT_MODEL_BASE
    ?? process.env.OPENAI_BASE_URL
    ?? process.env.VISION_BASE_URL
    ?? ""
  ).trim();
  if (envKey && envBase) {
    return {
      apiKey: envKey,
      baseURL: envBase,
      // 模型名不回退到 VISION_MODEL（视觉模型不能当 agent 文本模型用）
      model: (process.env.AGENT_MODEL_NAME ?? process.env.OPENAI_MODEL ?? DEFAULTS.model).trim(),
      provider: (process.env.AGENT_MODEL_PROVIDER ?? DEFAULTS.provider).trim(),
      apiMode: process.env.AGENT_MODEL_API_MODE,
      mode: "llm",
      source: "env",
    };
  }

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

  return { ...DEFAULTS, mode: "local", source: "default" };
}

export function saveModelConfig(cfg: Partial<ModelConfig>): void {
  const existing = readFileConfig();
  const merged: Partial<ModelConfig> = { ...existing };
  for (const k of ["apiKey", "baseURL", "model", "provider"] as const) {
    if (cfg[k] == null) continue;
    const trimmed = String(cfg[k]).trim();
    if (trimmed) merged[k] = trimmed;
    else delete merged[k];
  }
  writeFileSync(MODEL_CONFIG_FILE, JSON.stringify(merged, null, 2) + "\n", "utf8");
}

export function clearModelConfig(): void {
  writeFileSync(MODEL_CONFIG_FILE, "{}\n", "utf8");
}

export const modelConfigFilePath = MODEL_CONFIG_FILE;
