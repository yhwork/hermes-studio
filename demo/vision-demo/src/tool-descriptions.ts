import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 工具描述注册表 —— 单一事实来源。
 * - mcp.ts 启动时读这里，把描述喂给 Hermes 的 LLM 工具表。
 * - /config 页面通过 GET/PUT /api/tool-descriptions 编辑覆盖项。
 */

const HERE = typeof __dirname !== "undefined" ? __dirname : process.cwd();
const OVERRIDES_FILE = join(HERE, "..", "descriptions.json");

export const DEFAULT_DESCRIPTIONS: Record<string, string> = {
  analyze_image:
    "Analyze one or more images with a question. Supports image URLs, local file paths, and base64. Returns detailed analysis with optional reasoning/thinking process. Use for any image understanding task: what's in the image, answer questions about content, identify objects/text/scenes/people.",
  compare_images:
    "Compare 2 or more images and identify similarities and differences. Pass multiple image URLs/paths. Returns comparative analysis covering content, style, and detail differences.",
  extract_text:
    "Extract all text from an image (OCR). Preserves structure and hierarchy. Tables become markdown tables. Use for screenshots of documents, code, UI text, signs, receipts, etc.",
  describe_image:
    "Describe an image from a specific perspective. aspect: 'general' (default, overall description), 'ui' (UX analysis of screenshots), 'chart' (data/chart analysis), 'document' (structured text extraction), 'scene' (photo/scene description), 'code' (code screenshot extraction).",
  agent_chat:
    "Delegate a complex or multi-step image analysis task to an autonomous vision sub-agent. The agent has its own LLM reasoning, can call analyze_image / compare_images / extract_text / describe_image multiple times, and returns the final synthesized result. Use for tasks that need planning across multiple images or multi-step analysis.",
  agent_status: "Get the current vision agent configuration and status.",
};

export function loadOverrides(): Record<string, string> {
  try {
    if (!existsSync(OVERRIDES_FILE)) return {};
    const raw = readFileSync(OVERRIDES_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
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
