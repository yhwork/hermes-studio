import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult } from "../../../packages/ekko-agent/src/tools/types";
import { loadModelConfig } from "./model-config.js";
import { extractDocument } from "./doc-reader.js";
import {
  parseMarkdownToTree,
  treeToMarkdown,
  validateTree,
  treeStats,
  treeToXmindBuffer,
  type MarkdownNode,
} from "./markdown-tree.js";
import {
  CASE_SYSTEM_PROMPT,
  GAME_CASE_METHODOLOGY_PROMPT,
  GENERATE_OUTPUT_RULES,
  EDIT_OUTPUT_RULES,
} from "./prompts.js";

/**
 * 用例生成核心 —— 调 OpenAI 兼容 chat/completions，把需求文本 + 方法论 → 层级化 Markdown 用例树。
 *
 * 与 aibox CaseGenerateAgent 的区别：
 *   - aibox 用 LangChain 多轮 agent loop + 大量内部工具（P4/飞书/TAPD/知识库/XMind 客户端工具）。
 *   - 本 demo 蒸馏为「单次 LLM 调用 + 方法论 prompt」的极简形态，加上树校验和 .xmind 导出，
 *     独立可跑，不依赖任何内部系统。多步推理形态见 agent.ts（ekko-agent）。
 */

export interface CaseResult {
  markdown: string;
  rootTitle: string;
  stats: ReturnType<typeof treeStats>;
  model: string;
  source: string;
  usage: Record<string, unknown> | null;
  finishedAt: string;
}

export interface GenerateOptions {
  rootTitle?: string;
  extraInstructions?: string;
  maxChars?: number;
  signal?: AbortSignal;
}

export interface EditOptions {
  signal?: AbortSignal;
}

// ── LLM 调用 ──────────────────────────────────────────────────────────

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

async function chatComplete(
  messages: ChatMessage[],
  opts: { signal?: AbortSignal } = {},
): Promise<{ content: string; usage: Record<string, unknown> | null; model: string }> {
  const cfg = loadModelConfig();
  if (cfg.mode !== "llm" || !cfg.apiKey) {
    throw new Error(
      "用例生成 LLM 未配置。请在 /config 页填入 API Key + Base URL + Model，或设置 AGENT_MODEL_KEY / OPENAI_API_KEY 环境变量，或确保 hermes config.yaml 已配置主 agent 模型。",
    );
  }

  // 兼容 anthropic_messages 协议端点：自动转 /v1
  let baseURL = cfg.baseURL;
  if (baseURL.endsWith("/anthropic")) {
    baseURL = baseURL.slice(0, -"/anthropic".length) + "/v1";
  }
  const url = `${baseURL.replace(/\/$/, "")}/chat/completions`;

  const body: Record<string, unknown> = {
    model: cfg.model,
    messages,
    stream: false,
    temperature: 0.4,
  };

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${cfg.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: opts.signal ?? AbortSignal.timeout(180_000),
    });
  } catch (err) {
    throw new Error(`LLM 不可达 (${url}): ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    let msg = errText;
    try {
      const j = JSON.parse(errText);
      msg = j.error?.message || j.message || errText;
    } catch {
      /* not json */
    }
    throw new Error(`LLM 失败 (${res.status}): ${msg}`);
  }

  const data = (await res.json()) as Record<string, unknown>;
  const choices = data.choices as Array<Record<string, unknown>> | undefined;
  const message = choices && choices.length > 0 ? (choices[0].message as Record<string, unknown> | undefined) : undefined;
  const content =
    typeof message?.content === "string"
      ? message.content.trim()
      : Array.isArray(message?.content)
      ? (message!.content as Array<Record<string, unknown>>)
          .map((p) => (typeof p?.text === "string" ? p.text : ""))
          .join("")
          .trim()
      : "";
  const usage = (data.usage as Record<string, unknown>) ?? null;
  return { content, usage, model: cfg.model };
}

// ── 提取 LLM 输出里的 Markdown ────────────────────────────────────────

function extractMarkdown(raw: string): string {
  let s = raw.trim();
  // 去掉可能的 ```markdown 围栏
  const fence = s.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/);
  if (fence) s = fence[1].trim();
  return s;
}

// ── 生成完整用例树 ────────────────────────────────────────────────────

export async function generateCases(
  requirement: string,
  options: GenerateOptions = {},
): Promise<CaseResult> {
  const system = [
    CASE_SYSTEM_PROMPT,
    GAME_CASE_METHODOLOGY_PROMPT,
    GENERATE_OUTPUT_RULES,
    options.extraInstructions ? `\n## 用户补充指令\n${options.extraInstructions}` : "",
  ].join("\n\n");

  const userParts: string[] = [];
  if (options.rootTitle) {
    userParts.push(`根节点标题要求：${options.rootTitle}`);
  }
  userParts.push(`## 需求文档\n${requirement}`);
  userParts.push("请基于以上需求生成完整测试用例树。");

  const { content, usage, model } = await chatComplete(
    [
      { role: "system", content: system },
      { role: "user", content: userParts.join("\n\n") },
    ],
    { signal: options.signal },
  );

  const markdown = extractMarkdown(content);
  if (!markdown) throw new Error("LLM 未返回有效 Markdown");

  // 解析校验，提取根标题和统计
  const tree = parseMarkdownToTree(markdown, options.rootTitle);
  const stats = treeStats(tree);
  const cfg = loadModelConfig();

  return {
    markdown,
    rootTitle: tree.title,
    stats,
    model,
    source: cfg.source,
    usage,
    finishedAt: new Date().toISOString(),
  };
}

// ── 从文件生成 ────────────────────────────────────────────────────────

export async function generateCasesFromFile(
  filePath: string,
  options: GenerateOptions = {},
): Promise<CaseResult & { document: { fileType: string; paragraphCount: number; truncated: boolean } }> {
  const doc = extractDocument(filePath, options.maxChars);
  const result = await generateCases(doc.textContent, options);
  return {
    ...result,
    document: {
      fileType: doc.fileType,
      paragraphCount: doc.paragraphCount,
      truncated: doc.truncated,
    },
  };
}

// ── 局部编辑 ──────────────────────────────────────────────────────────

export async function editCases(
  currentMarkdown: string,
  instruction: string,
  options: EditOptions = {},
): Promise<CaseResult> {
  const system = [
    CASE_SYSTEM_PROMPT,
    GAME_CASE_METHODOLOGY_PROMPT,
    EDIT_OUTPUT_RULES,
  ].join("\n\n");

  const user = `## 当前用例树（Markdown）\n${currentMarkdown}\n\n## 修改指令\n${instruction}\n\n请输出修改后的完整用例树。`;

  const { content, usage, model } = await chatComplete(
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    { signal: options.signal },
  );

  const markdown = extractMarkdown(content);
  if (!markdown) throw new Error("LLM 未返回有效 Markdown");

  const tree = parseMarkdownToTree(markdown);
  const stats = treeStats(tree);
  const cfg = loadModelConfig();

  return {
    markdown,
    rootTitle: tree.title,
    stats,
    model,
    source: cfg.source,
    usage,
    finishedAt: new Date().toISOString(),
  };
}

// ── 校验 ──────────────────────────────────────────────────────────────

export function validateCases(markdown: string): ReturnType<typeof validateTree> & { markdown: string } {
  const tree = parseMarkdownToTree(markdown);
  return { ...validateTree(tree), markdown };
}

// ── 导出 .xmind ───────────────────────────────────────────────────────

export function exportXmind(markdown: string, outputPath: string, rootTitle?: string): {
  path: string;
  rootTitle: string;
  stats: ReturnType<typeof treeStats>;
} {
  const tree = parseMarkdownToTree(markdown, rootTitle);
  const buffer = treeToXmindBuffer(tree);
  const abs = resolve(process.cwd(), outputPath);
  writeFileSync(abs, buffer);
  return { path: abs, rootTitle: tree.title, stats: treeStats(tree) };
}

// ── AgentTool classes（供 ekko-agent 多步推理注册） ────────────────────

export class GenerateCasesTool implements AgentTool<GenerateCasesInput> {
  readonly definition = {
    name: "generate_cases",
    description:
      "Generate a complete hierarchical test case tree (Markdown) from a requirement text. Applies the built-in game test case methodology: 功能域 -> 场景 -> 前置条件 -> 操作 -> 预期结果. Use for first-time full generation or full regeneration when the user explicitly asks.",
    parameters: {
      type: "object",
      properties: {
        requirement: {
          type: "string",
          description: "Requirement text. The single source of truth — do not invent features not stated here.",
        },
        file: {
          type: "string",
          description: "Optional local file path (.docx/.xlsx/.txt/.md) — if provided, overrides `requirement` by reading the file.",
        },
        rootTitle: { type: "string", description: "Optional root node title, e.g. '某某功能测试用例'." },
        extraInstructions: { type: "string", description: "Optional extra instructions (focus, scope, style)." },
      },
      additionalProperties: false,
    },
  };

  async execute(input: GenerateCasesInput, _ctx: AgentToolContext = {}): Promise<AgentToolResult> {
    try {
      let result: CaseResult & { document?: Record<string, unknown> };
      if (input.file) {
        const r = await generateCasesFromFile(input.file, {
          rootTitle: input.rootTitle,
          extraInstructions: input.extraInstructions,
        });
        result = {
          markdown: r.markdown,
          rootTitle: r.rootTitle,
          stats: r.stats,
          model: r.model,
          source: r.source,
          usage: r.usage,
          finishedAt: r.finishedAt,
          document: {
            fileType: r.document.fileType,
            paragraphCount: r.document.paragraphCount,
            truncated: r.document.truncated,
          },
        };
      } else {
        if (!input.requirement?.trim()) {
          return { ok: false, content: "requirement 或 file 参数必填", error: "missing_input" };
        }
        result = await generateCases(input.requirement, {
          rootTitle: input.rootTitle,
          extraInstructions: input.extraInstructions,
        });
      }
      return {
        ok: true,
        content: result.markdown,
        data: {
          rootTitle: result.rootTitle,
          stats: result.stats,
          model: result.model,
          source: result.source,
          usage: result.usage,
          document: result.document,
          finishedAt: result.finishedAt,
        },
      };
    } catch (e) {
      return { ok: false, content: `生成失败: ${e instanceof Error ? e.message : String(e)}`, error: "llm_error" };
    }
  }
}

export interface GenerateCasesInput extends Record<string, unknown> {
  requirement?: string;
  file?: string;
  rootTitle?: string;
  extraInstructions?: string;
}

export class EditCasesTool implements AgentTool<EditCasesInput> {
  readonly definition = {
    name: "edit_cases",
    description:
      "Edit an existing test case tree (Markdown) with a natural-language instruction. Returns the full modified tree. Only changes what the instruction asks — does not rewrite unrelated nodes. Prefer this over regenerate for supplemental / optimization / rewording tasks.",
    parameters: {
      type: "object",
      properties: {
        currentMarkdown: { type: "string", description: "The current full Markdown case tree." },
        instruction: { type: "string", description: "What to change, e.g. '补充弱网场景' / '优化措辞' / '删除某节点'." },
      },
      required: ["currentMarkdown", "instruction"],
      additionalProperties: false,
    },
  };

  async execute(input: EditCasesInput, _ctx: AgentToolContext = {}): Promise<AgentToolResult> {
    if (!input.currentMarkdown?.trim() || !input.instruction?.trim()) {
      return { ok: false, content: "currentMarkdown 和 instruction 参数必填", error: "missing_input" };
    }
    try {
      const result = await editCases(input.currentMarkdown, input.instruction);
      return {
        ok: true,
        content: result.markdown,
        data: {
          rootTitle: result.rootTitle,
          stats: result.stats,
          model: result.model,
          finishedAt: result.finishedAt,
        },
      };
    } catch (e) {
      return { ok: false, content: `编辑失败: ${e instanceof Error ? e.message : String(e)}`, error: "llm_error" };
    }
  }
}

export interface EditCasesInput extends Record<string, unknown> {
  currentMarkdown: string;
  instruction: string;
}

export class ReadRequirementTool implements AgentTool<ReadRequirementInput> {
  readonly definition = {
    name: "read_requirement",
    description:
      "Read and extract text from a local requirement document (.docx/.xlsx/.txt/.md/.json). Returns the plain text content (truncated if very long). Use this before generate_cases when the user provides a file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Local file path." },
        maxChars: { type: "number", description: "Max chars to return. Default 30000." },
      },
      required: ["path"],
      additionalProperties: false,
    },
  };

  async execute(input: ReadRequirementInput, _ctx: AgentToolContext = {}): Promise<AgentToolResult> {
    if (!input.path?.trim()) {
      return { ok: false, content: "path 参数必填", error: "missing_path" };
    }
    try {
      const doc = extractDocument(input.path, input.maxChars);
      return {
        ok: true,
        content: doc.textContent,
        data: {
          filePath: doc.filePath,
          fileType: doc.fileType,
          paragraphCount: doc.paragraphCount,
          truncated: doc.truncated,
        },
      };
    } catch (e) {
      return { ok: false, content: `读取失败: ${e instanceof Error ? e.message : String(e)}`, error: "read_error" };
    }
  }
}

export interface ReadRequirementInput extends Record<string, unknown> {
  path: string;
  maxChars?: number;
}

export class ValidateCasesTool implements AgentTool<ValidateCasesInput> {
  readonly definition = {
    name: "validate_cases",
    description:
      "Validate a Markdown case tree against the methodology: checks depth, leaf length, '操作：/预期：' anti-patterns, missing L2 domains. Returns issues, warnings, and stats.",
    parameters: {
      type: "object",
      properties: {
        markdown: { type: "string", description: "The Markdown case tree to validate." },
      },
      required: ["markdown"],
      additionalProperties: false,
    },
  };

  async execute(input: ValidateCasesInput, _ctx: AgentToolContext = {}): Promise<AgentToolResult> {
    if (!input.markdown?.trim()) {
      return { ok: false, content: "markdown 参数必填", error: "missing_input" };
    }
    try {
      const result = validateCases(input.markdown);
      return {
        ok: result.ok,
        content: JSON.stringify(
          { ok: result.ok, issues: result.issues, warnings: result.warnings, stats: result.stats },
          null,
          2,
        ),
        data: result,
      };
    } catch (e) {
      return { ok: false, content: `校验失败: ${e instanceof Error ? e.message : String(e)}`, error: "parse_error" };
    }
  }
}

export interface ValidateCasesInput extends Record<string, unknown> {
  markdown: string;
}

export class ExportXmindTool implements AgentTool<ExportXmindInput> {
  readonly definition = {
    name: "export_xmind",
    description:
      "Export a Markdown case tree to an .xmind file. Writes to outputPath and returns the absolute path + stats.",
    parameters: {
      type: "object",
      properties: {
        markdown: { type: "string", description: "The Markdown case tree." },
        outputPath: { type: "string", description: "Output .xmind file path, e.g. D:/cases/login.xmind." },
        rootTitle: { type: "string", description: "Optional override for the root node title." },
      },
      required: ["markdown", "outputPath"],
      additionalProperties: false,
    },
  };

  async execute(input: ExportXmindInput, _ctx: AgentToolContext = {}): Promise<AgentToolResult> {
    if (!input.markdown?.trim() || !input.outputPath?.trim()) {
      return { ok: false, content: "markdown 和 outputPath 参数必填", error: "missing_input" };
    }
    try {
      const result = exportXmind(input.markdown, input.outputPath, input.rootTitle);
      return {
        ok: true,
        content: `已导出: ${result.path}`,
        data: result,
      };
    } catch (e) {
      return { ok: false, content: `导出失败: ${e instanceof Error ? e.message : String(e)}`, error: "export_error" };
    }
  }
}

export interface ExportXmindInput extends Record<string, unknown> {
  markdown: string;
  outputPath: string;
  rootTitle?: string;
}

// ── 导出便捷函数 ──────────────────────────────────────────────────────

export { parseMarkdownToTree, treeToMarkdown, treeStats, type MarkdownNode };
