import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadAgentConfig, runAgent } from "./agent.js";
import { generateImage } from "./image-tool.js";
import { loadDescriptions } from "./tool-descriptions.js";

/**
 * MCP Server wrapper for image-gen-demo.
 * 暴露 4 个工具：image_gen / image_edit / agent_chat / agent_status。
 * Hermes（或任意 MCP 客户端）注册后即可在对话中调用。
 */

const server = new McpServer({
  name: "image-gen-demo",
  version: "1.0.0",
});

const agentConfig = loadAgentConfig();
const descriptions = loadDescriptions();

// Tool 1: image_gen — text-to-image
server.tool(
  "image_gen",
  descriptions.image_gen,
  {
    prompt: z.string().describe("The image prompt — describe subject, style, composition, lighting."),
    size: z.string().optional().describe("Image size, e.g. 1024x1024, 1536x1024, 2048x2048. Default 1024x1024."),
    output_path: z.string().optional().describe("Absolute output file path. If omitted, saved under IMAGE_OUTPUT_DIR."),
    provider: z.string().optional().describe("Configured provider name in Hermes config.yaml. Default fun-codex."),
    n: z.number().optional().describe("Number of images. Default 1."),
  },
  async ({ prompt, size, output_path, provider, n }) => {
    const result = await generateImage(
      { prompt, mode: "text", size, output_path, provider, n },
      agentConfig.imageApi,
    );
    return toMcpContent(result.ok, result.content, result.data);
  },
);

// Tool 2: image_edit — image-to-image / edit
server.tool(
  "image_edit",
  descriptions.image_edit,
  {
    prompt: z.string().describe("How to transform or edit the reference image."),
    image_path: z.string().describe("Absolute path to the reference/source image."),
    mode: z.enum(["image", "edit"]).optional().describe("'image' = image-to-image (new image from reference); 'edit' = in-place edit. Default 'edit'."),
    size: z.string().optional().describe("Output size. Default 1024x1024."),
    output_path: z.string().optional().describe("Absolute output file path."),
    provider: z.string().optional().describe("Provider name. Default fun-codex."),
  },
  async ({ prompt, image_path, mode, size, output_path, provider }) => {
    const result = await generateImage(
      { prompt, mode: mode || "edit", image_path, size, output_path, provider },
      agentConfig.imageApi,
    );
    return toMcpContent(result.ok, result.content, result.data);
  },
);

// Tool 3: agent_chat — delegate a creative brief to the sub-agent
server.tool(
  "agent_chat",
  descriptions.agent_chat,
  {
    message: z.string().describe("The creative brief or request for the image-generation agent."),
    cwd: z.string().optional().describe("Working directory (unused for image gen, kept for parity)."),
    maxSteps: z.number().optional().describe("Maximum reasoning steps (default 12)."),
  },
  async ({ message, cwd, maxSteps }) => {
    try {
      const result = await runAgent(message, agentConfig, { cwd, maxSteps });
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

// Tool 4: agent_status
server.tool(
  "agent_status",
  descriptions.agent_status,
  {},
  async () => {
    return toMcpContent(true, JSON.stringify({
      name: "image-gen-demo",
      version: "1.0.0",
      mode: agentConfig.mode,
      model: agentConfig.model,
      baseURL: agentConfig.mode === "llm" ? agentConfig.baseURL : null,
      image_api: {
        source: agentConfig.imageApi.source,
        base_url: agentConfig.imageApi.baseURL || null,
        model: agentConfig.imageApi.model || null,
        has_key: Boolean(agentConfig.imageApi.apiKey),
      },
      capabilities: ["text_to_image", "image_to_image", "image_edit", "agent_chat"],
      maxSteps: 12,
    }, null, 2));
  },
);

// Tool 5: test_connection — 测试图片 API 连通性
server.tool(
  "test_connection",
  "Test image API connectivity. Checks if IMAGE_API_KEY and IMAGE_BASE_URL are configured and reachable. Call this to verify the image generation service is properly set up.",
  {},
  async () => {
    const cfg = agentConfig.imageApi;
    const checks: Record<string, unknown> = {
      source: cfg.source,
      has_key: Boolean(cfg.apiKey),
      base_url: cfg.baseURL || null,
      model: cfg.model || null,
    };

    // 1. 检查配置是否存在
    if (!cfg.apiKey || !cfg.baseURL) {
      return toMcpContent(false, JSON.stringify({
        ...checks,
        status: "not_configured",
        message: "图片 API 未配置。请在 MCP 面板编辑 image-gen-demo 的 env：IMAGE_API_KEY + IMAGE_BASE_URL + IMAGE_MODEL",
      }, null, 2));
    }

    // 2. 尝试连接（发一个最小请求测通路，用极小 size 减少消耗）
    const url = `${cfg.baseURL.replace(/\/$/, "")}/images/generations`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${cfg.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model: cfg.model, prompt: "test", n: 1, size: "256x256" }),
        signal: AbortSignal.timeout(30_000),
      });

      if (res.ok) {
        return toMcpContent(true, JSON.stringify({
          ...checks,
          status: "ok",
          http_status: res.status,
          message: `连接成功！API 可用（${url}）`,
        }, null, 2));
      }

      const data = await res.json().catch(() => ({})) as Record<string, unknown>;
      const errMsg = typeof data.error === "object"
        ? (data.error as any)?.message || JSON.stringify(data.error)
        : data.error || data.message || res.statusText;

      // 401/403 = key 无效；404 = endpoint 不对；其他可能是模型不支持
      return toMcpContent(false, JSON.stringify({
        ...checks,
        status: "error",
        http_status: res.status,
        message: `API 返回 ${res.status}: ${errMsg}`,
        hint: res.status === 401 ? "API key 无效或过期" :
              res.status === 403 ? "API key 无权访问此端点" :
              res.status === 404 ? "端点不支持 /images/generations，请确认 IMAGE_BASE_URL 指向正确的服务" :
              "请检查 IMAGE_BASE_URL 和 IMAGE_MODEL 是否正确",
      }, null, 2));
    } catch (err) {
      return toMcpContent(false, JSON.stringify({
        ...checks,
        status: "unreachable",
        message: `无法连接到 ${url}: ${err instanceof Error ? err.message : String(err)}`,
        hint: "请检查网络、代理、或 IMAGE_BASE_URL 是否正确",
      }, null, 2));
    }
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
  console.error("[image-gen-demo-mcp] Server started on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
