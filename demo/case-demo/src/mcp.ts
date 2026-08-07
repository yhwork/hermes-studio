import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadAgentConfig, runAgent } from "./agent.js";
import {
  generateCases,
  generateCasesFromFile,
  editCases,
  validateCases,
  exportXmind,
} from "./case-tool.js";
import { extractDocument } from "./doc-reader.js";
import { loadModelConfig } from "./model-config.js";
import { loadDescriptions } from "./tool-descriptions.js";

/**
 * MCP stdio 服务 —— case-demo。
 * 暴露 7 个工具：generate_cases / edit_cases / read_requirement / validate_cases /
 * export_xmind / agent_chat / agent_status。
 */

const MAX_STEPS = 12;

const server = new McpServer({
  name: "case-demo",
  version: "1.0.0",
});

const agentConfig = loadAgentConfig();
const descriptions = loadDescriptions();

// ── Tool 1: generate_cases ────────────────────────────────────────────
server.tool(
  "generate_cases",
  descriptions.generate_cases,
  {
    requirement: z.string().optional().describe("需求文本（与 file 二选一）"),
    file: z.string().optional().describe("本地需求文档路径 .docx/.xlsx/.txt/.md，提供时覆盖 requirement"),
    rootTitle: z.string().optional().describe("根节点标题，如「登录功能测试用例」"),
    extraInstructions: z.string().optional().describe("补充指令（侧重、范围、风格）"),
  },
  async ({ requirement, file, rootTitle, extraInstructions }) => {
    try {
      let result;
      if (file) {
        result = await generateCasesFromFile(file, { rootTitle, extraInstructions });
      } else {
        if (!requirement?.trim()) {
          return toMcpContent(false, "requirement 或 file 参数必填", undefined, true);
        }
        result = await generateCases(requirement, { rootTitle, extraInstructions });
      }
      return toMcpContent(true, result.markdown, {
        rootTitle: result.rootTitle,
        stats: result.stats,
        model: result.model,
        source: result.source,
        usage: result.usage,
        document: (result as { document?: Record<string, unknown> }).document,
        finishedAt: result.finishedAt,
      });
    } catch (e) {
      return toMcpContent(false, `生成失败: ${e instanceof Error ? e.message : String(e)}`, undefined, true);
    }
  },
);

// ── Tool 2: edit_cases ────────────────────────────────────────────────
server.tool(
  "edit_cases",
  descriptions.edit_cases,
  {
    currentMarkdown: z.string().describe("当前完整用例树 Markdown"),
    instruction: z.string().describe("修改指令，如「补充弱网场景」「优化措辞」「删除登录节点」"),
  },
  async ({ currentMarkdown, instruction }) => {
    if (!currentMarkdown?.trim() || !instruction?.trim()) {
      return toMcpContent(false, "currentMarkdown 和 instruction 参数必填", undefined, true);
    }
    try {
      const result = await editCases(currentMarkdown, instruction);
      return toMcpContent(true, result.markdown, {
        rootTitle: result.rootTitle,
        stats: result.stats,
        model: result.model,
        finishedAt: result.finishedAt,
      });
    } catch (e) {
      return toMcpContent(false, `编辑失败: ${e instanceof Error ? e.message : String(e)}`, undefined, true);
    }
  },
);

// ── Tool 3: read_requirement ──────────────────────────────────────────
server.tool(
  "read_requirement",
  descriptions.read_requirement,
  {
    path: z.string().describe("本地文件路径"),
    maxChars: z.number().optional().describe("最多返回字符数，默认 30000"),
  },
  async ({ path: filePath, maxChars }) => {
    if (!filePath?.trim()) {
      return toMcpContent(false, "path 参数必填", undefined, true);
    }
    try {
      const doc = extractDocument(filePath, maxChars);
      return toMcpContent(true, doc.textContent, {
        filePath: doc.filePath,
        fileType: doc.fileType,
        paragraphCount: doc.paragraphCount,
        truncated: doc.truncated,
      });
    } catch (e) {
      return toMcpContent(false, `读取失败: ${e instanceof Error ? e.message : String(e)}`, undefined, true);
    }
  },
);

// ── Tool 4: validate_cases ────────────────────────────────────────────
server.tool(
  "validate_cases",
  descriptions.validate_cases,
  {
    markdown: z.string().describe("待校验的用例树 Markdown"),
  },
  async ({ markdown }) => {
    if (!markdown?.trim()) {
      return toMcpContent(false, "markdown 参数必填", undefined, true);
    }
    try {
      const result = validateCases(markdown);
      return toMcpContent(true, JSON.stringify({
        ok: result.ok,
        issues: result.issues,
        warnings: result.warnings,
        stats: result.stats,
      }, null, 2), result);
    } catch (e) {
      return toMcpContent(false, `校验失败: ${e instanceof Error ? e.message : String(e)}`, undefined, true);
    }
  },
);

// ── Tool 5: export_xmind ──────────────────────────────────────────────
server.tool(
  "export_xmind",
  descriptions.export_xmind,
  {
    markdown: z.string().describe("用例树 Markdown"),
    outputPath: z.string().describe("输出 .xmind 路径，如 D:/cases/login.xmind"),
    rootTitle: z.string().optional().describe("可选，覆盖根节点标题"),
  },
  async ({ markdown, outputPath, rootTitle }) => {
    if (!markdown?.trim() || !outputPath?.trim()) {
      return toMcpContent(false, "markdown 和 outputPath 参数必填", undefined, true);
    }
    try {
      const result = exportXmind(markdown, outputPath, rootTitle);
      return toMcpContent(true, `已导出: ${result.path}`, result);
    } catch (e) {
      return toMcpContent(false, `导出失败: ${e instanceof Error ? e.message : String(e)}`, undefined, true);
    }
  },
);

// ── Tool 6: agent_chat ────────────────────────────────────────────────
server.tool(
  "agent_chat",
  descriptions.agent_chat,
  {
    message: z.string().describe("用例生成任务或问题，委派给子 agent 处理"),
    maxSteps: z.number().optional().describe("最大推理步数，默认 12"),
  },
  async ({ message, maxSteps }) => {
    try {
      const result = await runAgent(message, agentConfig, { maxSteps });
      return toMcpContent(true, JSON.stringify({
        response: result.content,
        steps: result.steps,
        toolCalls: result.toolCalls.length,
        mode: result.mode,
        finishedAt: result.finishedAt,
      }, null, 2));
    } catch (error) {
      return toMcpContent(false, error instanceof Error ? error.message : String(error), undefined, true);
    }
  },
);

// ── Tool 7: agent_status ──────────────────────────────────────────────
server.tool(
  "agent_status",
  descriptions.agent_status,
  {},
  async () => {
    const m = loadModelConfig();
    return toMcpContent(true, JSON.stringify({
      name: "case-demo",
      version: "1.0.0",
      agentMode: agentConfig.mode,
      agentModel: agentConfig.mode === "llm" ? agentConfig.model : null,
      llmSource: m.source,
      capabilities: [
        "generate_cases",
        "edit_cases",
        "read_requirement",
        "validate_cases",
        "export_xmind",
        "agent_chat",
      ],
      maxSteps: MAX_STEPS,
    }, null, 2));
  },
);

function toMcpContent(ok: boolean, text: string, data?: unknown, isError = false) {
  return {
    content: [
      {
        type: "text" as const,
        text: data ? JSON.stringify({ ok, text, data }, null, 2) : text,
      },
    ],
    isError: isError || !ok,
  };
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[case-demo-mcp] Server started on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
