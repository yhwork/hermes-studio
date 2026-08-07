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
  generate_cases:
    "Generate a complete hierarchical test case tree (Markdown) from requirement text or a local document (.docx/.xlsx/.txt/.md). Applies the built-in game test case methodology: 功能域 → 场景 → 前置条件 → 操作 → 预期结果. Use for first-time full generation or full regeneration when the user explicitly asks. Do NOT use this for partial edits — use edit_cases instead.",
  edit_cases:
    "Edit an existing Markdown case tree with a natural-language instruction (e.g. '补充弱网场景', '优化措辞', '删除登录节点'). Returns the full modified tree, only changing what the instruction asks. Prefer this over generate_cases for supplemental / optimization / rewording tasks.",
  read_requirement:
    "Read and extract plain text from a local requirement document (.docx/.xlsx/.txt/.md/.json). Returns the text content (truncated if very long). Use this before generate_cases when the user provides a file.",
  validate_cases:
    "Validate a Markdown case tree against the methodology: checks tree depth, leaf node length, '操作：/预期：' anti-patterns, and missing L2 domains. Returns issues, warnings, and stats (node count, max depth, leaf count, L2 domains).",
  export_xmind:
    "Export a Markdown case tree to an .xmind file. Writes to outputPath and returns the absolute path + stats. Requires markdown and outputPath.",
  agent_chat:
    "Delegate a complex or multi-step case generation task to an autonomous case sub-agent. The agent has its own LLM reasoning, can call generate_cases / edit_cases / read_requirement / validate_cases / export_xmind multiple times, and returns the final synthesized result. Use for tasks that need planning across multiple steps (e.g. read doc → generate → validate → fix → export).",
  agent_status: "Get the current case agent configuration and status.",
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
