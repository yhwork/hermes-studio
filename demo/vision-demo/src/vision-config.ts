import { loadMainAgentModelConfig } from "./hermes-config.js";

/**
 * Vision API 配置 —— 图像识别分析用的视觉模型。
 *
 * 视觉模型走 OpenAI 兼容的 /chat/completions 端点（vision 格式），
 * 与 hermes 主 agent 用的 anthropic_messages 协议不同。
 *
 * 配置优先级：
 *   1. 环境变量 VISION_API_KEY (或 PAPERHUB_API_KEY) + VISION_BASE_URL + VISION_MODEL
 *   2. 继承主 agent（hermes config.yaml）的 api_key + base_url
 *      - 自动把 /anthropic 端点转成 /v1（同一网关，同一 key，不同协议路径）
 *      - 模型不继承主 agent 的文本模型，默认用视觉模型 doubao-seed-1-6-vision
 *   3. 无配置 → none
 *
 * 思考过程（reasoning）默认开启，可用 REASONING_ENABLED=0 关闭。
 */

export interface VisionApiConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  reasoningEnabled: boolean;
  source: "env" | "hermes" | "none";
}

const DEFAULT_VISION_MODEL = "doubao-seed-1-6-vision";

export function loadVisionApiConfig(): VisionApiConfig {
  // 1. 环境变量独立配置
  const envKey = (process.env.VISION_API_KEY ?? process.env.PAPERHUB_API_KEY ?? "").trim();
  const envBase = (process.env.VISION_BASE_URL ?? "").trim();
  if (envKey && envBase) {
    return {
      apiKey: envKey,
      baseURL: envBase,
      model: (process.env.VISION_MODEL ?? DEFAULT_VISION_MODEL).trim(),
      reasoningEnabled: parseBool(process.env.REASONING_ENABLED, true),
      source: "env",
    };
  }

  // 2. 继承主 agent（hermes config.yaml）
  const main = loadMainAgentModelConfig();
  if (main && main.apiKey && main.baseURL) {
    let baseURL = main.baseURL;
    // 同一网关（如 diezhi.net）支持 /anthropic 和 /v1 两种协议路径
    if (baseURL.endsWith("/anthropic")) {
      baseURL = baseURL.slice(0, -"/anthropic".length) + "/v1";
    }
    return {
      apiKey: main.apiKey,
      baseURL,
      model: process.env.VISION_MODEL?.trim() || DEFAULT_VISION_MODEL,
      reasoningEnabled: parseBool(process.env.REASONING_ENABLED, true),
      source: "hermes",
    };
  }

  // 3. 无配置
  return {
    apiKey: "",
    baseURL: "",
    model: DEFAULT_VISION_MODEL,
    reasoningEnabled: true,
    source: "none",
  };
}

function parseBool(v: string | undefined, def: boolean): boolean {
  if (v == null) return def;
  const s = v.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off"].includes(s)) return false;
  return def;
}
