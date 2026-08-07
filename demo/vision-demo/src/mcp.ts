import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadAgentConfig, runAgent } from "./agent.js";
import { analyze, compareImages, extractText, describeImage } from "./vision-tool.js";
import { loadVisionApiConfig } from "./vision-config.js";
import { loadDescriptions } from "./tool-descriptions.js";

/**
 * MCP stdio 服务 —— vision-demo。
 * 暴露 6 个工具：analyze_image / compare_images / extract_text / describe_image / agent_chat / agent_status。
 */

const MAX_STEPS = 12;

const server = new McpServer({
  name: "vision-demo",
  version: "1.0.0",
});

const agentConfig = loadAgentConfig();
const visionConfig = loadVisionApiConfig();
const descriptions = loadDescriptions();

// ── Tool 1: analyze_image ─────────────────────────────────────────────
server.tool(
  "analyze_image",
  descriptions.analyze_image,
  {
    image: z.string().optional().describe("单张图片：URL / 本地路径 / base64"),
    images: z.array(z.string()).optional().describe("多张图片（与 image 二选一），用于对比或多图分析"),
    question: z.string().optional().describe("关于图片的问题或指令，默认为通用描述"),
    reasoning: z.boolean().optional().describe("是否启用思考过程，默认 true"),
  },
  async ({ image, images, question, reasoning }) => {
    const imgs = images ?? (image ? [image] : []);
    if (!imgs.length) {
      return toMcpContent(false, "image 或 images 参数必填", undefined, true);
    }
    try {
      const result = await analyze(imgs, question || "请详细描述这张图片的内容。", { reasoning });
      if (!result.content) {
        return toMcpContent(false, "视觉模型未返回内容", result, true);
      }
      const text = result.reasoning
        ? `【思考过程】\n${result.reasoning}\n\n【分析结果】\n${result.content}`
        : result.content;
      return toMcpContent(true, text, result);
    } catch (e) {
      return toMcpContent(false, `分析失败: ${e instanceof Error ? e.message : String(e)}`, undefined, true);
    }
  },
);

// ── Tool 2: compare_images ────────────────────────────────────────────
server.tool(
  "compare_images",
  descriptions.compare_images,
  {
    images: z.array(z.string()).describe("2+ 张图片（URL / 路径 / base64）"),
    question: z.string().optional().describe("自定义对比问题，默认为通用差异分析"),
    reasoning: z.boolean().optional().describe("是否启用思考过程，默认 true"),
  },
  async ({ images, question, reasoning }) => {
    if (!images || images.length < 2) {
      return toMcpContent(false, "对比至少需要 2 张图片", undefined, true);
    }
    try {
      const result = await compareImages(images, question, { reasoning });
      const text = result.reasoning
        ? `【思考过程】\n${result.reasoning}\n\n【对比结果】\n${result.content}`
        : result.content;
      return toMcpContent(true, text, result);
    } catch (e) {
      return toMcpContent(false, `对比失败: ${e instanceof Error ? e.message : String(e)}`, undefined, true);
    }
  },
);

// ── Tool 3: extract_text ──────────────────────────────────────────────
server.tool(
  "extract_text",
  descriptions.extract_text,
  {
    image: z.string().describe("图片 URL / 本地路径 / base64"),
    question: z.string().optional().describe("自定义提取指令，默认为完整文字提取"),
    reasoning: z.boolean().optional().describe("是否启用思考过程，默认 true"),
  },
  async ({ image, question, reasoning }) => {
    if (!image) {
      return toMcpContent(false, "image 参数必填", undefined, true);
    }
    try {
      const result = await extractText(image, question, { reasoning });
      const text = result.reasoning
        ? `【思考过程】\n${result.reasoning}\n\n【提取结果】\n${result.content}`
        : result.content;
      return toMcpContent(true, text, result);
    } catch (e) {
      return toMcpContent(false, `提取失败: ${e instanceof Error ? e.message : String(e)}`, undefined, true);
    }
  },
);

// ── Tool 4: describe_image ────────────────────────────────────────────
server.tool(
  "describe_image",
  descriptions.describe_image,
  {
    image: z.string().describe("图片 URL / 本地路径 / base64"),
    aspect: z
      .enum(["general", "ui", "chart", "document", "scene", "code"])
      .optional()
      .describe("分析视角：general(默认)/ui/chart/document/scene/code"),
    reasoning: z.boolean().optional().describe("是否启用思考过程，默认 true"),
  },
  async ({ image, aspect, reasoning }) => {
    if (!image) {
      return toMcpContent(false, "image 参数必填", undefined, true);
    }
    try {
      const result = await describeImage(image, aspect || "general", { reasoning });
      const text = result.reasoning
        ? `【思考过程】\n${result.reasoning}\n\n【描述结果】\n${result.content}`
        : result.content;
      return toMcpContent(true, text, { ...result, aspect: aspect || "general" });
    } catch (e) {
      return toMcpContent(false, `描述失败: ${e instanceof Error ? e.message : String(e)}`, undefined, true);
    }
  },
);

// ── Tool 5: agent_chat ────────────────────────────────────────────────
server.tool(
  "agent_chat",
  descriptions.agent_chat,
  {
    message: z.string().describe("图像分析任务或问题，委派给子 agent 处理"),
    maxSteps: z.number().optional().describe("最大推理步数，默认 12"),
  },
  async ({ message, maxSteps }) => {
    try {
      const result = await runAgent(message, agentConfig, { maxSteps });
      return toMcpContent(
        true,
        JSON.stringify(
          {
            response: result.content,
            steps: result.steps,
            toolCalls: result.toolCalls.length,
            mode: result.mode,
            finishedAt: result.finishedAt,
          },
          null,
          2,
        ),
      );
    } catch (error) {
      return toMcpContent(
        false,
        error instanceof Error ? error.message : String(error),
        undefined,
        true,
      );
    }
  },
);

// ── Tool 6: agent_status ──────────────────────────────────────────────
server.tool(
  "agent_status",
  descriptions.agent_status,
  {},
  async () => {
    return toMcpContent(
      true,
      JSON.stringify(
        {
          name: "vision-demo",
          version: "1.0.0",
          agentMode: agentConfig.mode,
          agentModel: agentConfig.mode === "llm" ? agentConfig.model : null,
          visionSource: visionConfig.source,
          visionModel: visionConfig.model,
          reasoningEnabled: visionConfig.reasoningEnabled,
          capabilities: ["analyze_image", "compare_images", "extract_text", "describe_image", "agent_chat"],
          maxSteps: MAX_STEPS,
        },
        null,
        2,
      ),
    );
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
  console.error("[vision-demo-mcp] Server started on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
