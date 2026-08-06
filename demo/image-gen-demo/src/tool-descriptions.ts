import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * 工具描述注册表 —— 单一事实来源。
 *
 * - `mcp.ts` 启动时读这里，把描述喂给 Hermes 的 LLM 工具表。
 * - `server.ts` 的 `/config` 页面通过 `GET/PUT /api/tool-descriptions` 编辑覆盖项。
 *
 * 覆盖项持久化在源码目录上一层的 `descriptions.json`。路径用 `__dirname`
 * （tsx 按 commonjs tsconfig 编译，CJS 下可用），不依赖 `process.cwd()`。
 */

const HERE = typeof __dirname !== "undefined" ? __dirname : process.cwd();
const OVERRIDES_FILE = join(HERE, "..", "descriptions.json");

/** 内置默认描述。 */
export const DEFAULT_DESCRIPTIONS: Record<string, string> = {
  image_gen:
    "Generate an image from a text prompt. Speciality: text-to-image generation. Use when the user wants to create a new picture, illustration, poster, or any visual content from a text description. Returns the saved file path(s).",
  image_edit:
    "Edit or refine an existing image from a reference image and a prompt. Speciality: image-to-image transformation, in-place edits. Use when the user provides a reference image and wants modifications. Returns the saved file path(s).",
  agent_chat:
    "Delegate a creative or multi-step image task to an autonomous image-generation sub-agent. The agent has its own LLM reasoning, plans prompts (may iterate), generates/edits images, and returns the final result. Use for complex creative briefs, multi-step image workflows, or when the task needs planning beyond a single generation call.",
  agent_status: "Get the current image-gen agent configuration and status.",
};

export function loadOverrides(): Record<string, string> {
  try {
    if (!existsSync(OVERRIDES_FILE)) return {};
    const raw = readFileSync(OVERRIDES_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

export function loadDescriptions(): Record<string, string> {
  return { ...DEFAULT_DESCRIPTIONS, ...loadOverrides() };
}

export function saveOverrides(map: Record<string, string>): void {
  const compact: Record<string, string> = {};
  for (const [name, desc] of Object.entries(map)) {
    const trimmed = (desc ?? "").trim();
    if (trimmed && trimmed !== DEFAULT_DESCRIPTIONS[name]) {
      compact[name] = trimmed;
    }
  }
  writeFileSync(OVERRIDES_FILE, JSON.stringify(compact, null, 2) + "\n", "utf8");
}

export const overridesFilePath = OVERRIDES_FILE;

/** Hermes Web UI 连接配置（图片生成工具用）。 */
export interface HermesEndpointConfig {
  baseUrl: string;
  token: string;
  tokenSource: string;
  profile: string;
  provider: string;
  outputDir: string;
}

/** 解析 Hermes Web UI base URL。 */
function resolveBaseUrl(): string {
  if (process.env.HERMES_WEB_UI_URL) return process.env.HERMES_WEB_UI_URL.replace(/\/$/, "");
  if (process.env.PORT) return `http://127.0.0.1:${process.env.PORT}`;
  return "http://127.0.0.1:8647";
}

/** 解析 Hermes Web UI server token（按 SKILL.md 优先级）。 */
function resolveToken(): { token: string; source: string } {
  if (process.env.AUTH_TOKEN) return { token: process.env.AUTH_TOKEN, source: "AUTH_TOKEN" };
  const home = process.env.HERMES_WEB_UI_HOME;
  if (home) {
    const p = join(home, ".token");
    if (existsSync(p)) return { token: readFileSync(p, "utf8").trim(), source: p };
  }
  const stateDir = process.env.HERMES_WEBUI_STATE_DIR;
  if (stateDir) {
    const p = join(stateDir, ".token");
    if (existsSync(p)) return { token: readFileSync(p, "utf8").trim(), source: p };
  }
  const p = join(homedir(), ".hermes-web-ui", ".token");
  if (existsSync(p)) return { token: readFileSync(p, "utf8").trim(), source: p };
  return { token: "", source: "missing" };
}

/** 加载 Hermes 端点配置。 */
export function loadHermesEndpoint(): HermesEndpointConfig {
  const { token, source } = resolveToken();
  return {
    baseUrl: resolveBaseUrl(),
    token,
    tokenSource: source,
    profile: process.env.HERMES_PROFILE || "default",
    provider: process.env.IMAGE_PROVIDER || "fun-codex",
    outputDir: process.env.IMAGE_OUTPUT_DIR || join(homedir(), "image-gen-demo"),
  };
}
