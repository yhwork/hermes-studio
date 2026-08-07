import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";

/**
 * 读取 Hermes 主 agent 的模型配置（来自 hermes-agent 的 config.yaml），
 * 让子 agent 默认继承主 agent 用的同一套模型 / endpoint / key / 协议。
 *
 * 配置文件位置（profile 感知）：
 *   - HERMES_PROFILE 未设或 "default" → <hermes-home>/config.yaml
 *   - HERMES_PROFILE=<name>           → <hermes-home>/profiles/<name>/config.yaml
 *   - hermes-home：HERMES_HOME 环境变量，否则 ~/AppData/Local/hermes (Windows)
 */

export interface MainAgentModelConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  provider: string;
  apiMode?: string;
  profile: string;
  configPath: string;
}

function hermesHome(): string {
  return process.env.HERMES_HOME || join(homedir(), "AppData", "Local", "hermes");
}

function profileConfigPath(profile: string): string {
  if (profile && profile !== "default") {
    return join(hermesHome(), "profiles", profile, "config.yaml");
  }
  return join(hermesHome(), "config.yaml");
}

export function loadMainAgentModelConfig(): MainAgentModelConfig | null {
  const profile = process.env.HERMES_PROFILE || "default";
  const configPath = profileConfigPath(profile);
  try {
    if (!existsSync(configPath)) return null;
    const cfg = parseYaml(readFileSync(configPath, "utf8"));
    if (!cfg || typeof cfg !== "object") return null;

    const modelDefault = typeof cfg.model?.default === "string" ? cfg.model.default : "";
    let providerName = typeof cfg.model?.provider === "string" ? cfg.model.provider : "";
    providerName = providerName.replace(/^custom:/, "").trim();
    if (!providerName) return null;

    const prov = cfg.providers?.[providerName];
    if (!prov || typeof prov !== "object") return null;

    let apiKey = typeof prov.api_key === "string" ? prov.api_key.trim() : "";
    if (!apiKey && typeof prov.api_key_env === "string" && prov.api_key_env.trim()) {
      apiKey = (process.env[prov.api_key_env.trim()] || "").trim();
    }
    const baseURL = typeof (prov.api ?? prov.base_url) === "string" ? (prov.api ?? prov.base_url).trim() : "";
    if (!apiKey || !baseURL) return null;

    const model = (typeof prov.default_model === "string" ? prov.default_model : modelDefault).trim();
    if (!model) return null;

    return {
      apiKey,
      baseURL,
      model,
      provider: providerName,
      apiMode: typeof prov.transport === "string" ? prov.transport : undefined,
      profile,
      configPath,
    };
  } catch {
    return null;
  }
}
