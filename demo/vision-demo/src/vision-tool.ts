import { existsSync, readFileSync } from "node:fs";
import { extname, resolve, isAbsolute } from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult } from "../../../packages/ekko-agent/src/tools/types";
import { loadVisionApiConfig, type VisionApiConfig } from "./vision-config.js";

/**
 * 图像识别分析核心工具 —— 调用 OpenAI 兼容的视觉模型（如 doubao-seed-1-6-vision）。
 *
 * 支持：
 *   - 图片 URL（http/https/data URI）
 *   - 本地文件路径（自动读 base64 转 data URI）
 *   - 思考过程（reasoning_content），流式输出
 *   - 多图对比（多张 image_url 放一条 message）
 *
 * API 格式：OpenAI chat.completions + vision content parts
 *   { model, messages: [{ role: "user", content: [{type:"text"},{type:"image_url"}] }], stream: true }
 * 思考过程通过 delta.reasoning_content 字段返回（非标准 OpenAI 字段，豆包/通义等支持）。
 */

// ── MIME detection ────────────────────────────────────────────────────

const MIME_MAP: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".tiff": "image/tiff",
  ".tif": "image/tiff",
};

function mimeType(filePath: string): string {
  return MIME_MAP[extname(filePath).toLowerCase()] || "image/png";
}

/** 把图片输入（URL / 本地路径 / base64 / data URI）统一转成 OpenAI vision content part。 */
async function toImageContent(image: string): Promise<{ type: "image_url"; image_url: { url: string } }> {
  // data URI — 直接传给视觉 API
  if (/^data:image\//i.test(image)) {
    return { type: "image_url", image_url: { url: image } };
  }
  // HTTP URL — 本地 fetch 后转 base64 data URI
  // 远程视觉 API 无法访问 localhost / 内网地址，必须本地下载
  if (/^https?:\/\//i.test(image)) {
    try {
      const res = await fetch(image, { signal: AbortSignal.timeout(30_000), redirect: "follow" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const mime = (res.headers.get("content-type") || "image/png").split(";")[0].trim();
      const b64 = buf.toString("base64");
      return { type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } };
    } catch (err) {
      throw new Error(`下载图片失败 (${image}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // base64 raw（不带 data: 前缀，按 png 兜底）
  if (/^[A-Za-z0-9+/=\s]{100,}$/.test(image) && !image.includes("/")) {
    return { type: "image_url", image_url: { url: `data:image/png;base64,${image.replace(/\s/g, "")}` } };
  }
  // 本地文件
  const abs = isAbsolute(image) ? image : resolve(process.cwd(), image);
  if (!existsSync(abs)) {
    throw new Error(`图片文件不存在: ${abs}`);
  }
  const buf = readFileSync(abs);
  const b64 = buf.toString("base64");
  const mime = mimeType(abs);
  return { type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } };
}

// ── Types ─────────────────────────────────────────────────────────────

export interface VisionResult {
  content: string;
  reasoning: string;
  usage: Record<string, unknown> | null;
  model: string;
  mode: string;
  imageCount: number;
  finishedAt: string;
}

export interface AnalyzeImageInput extends Record<string, unknown> {
  image?: string;
  images?: string[];
  question?: string;
  reasoning?: boolean;
}

export interface CompareImagesInput extends Record<string, unknown> {
  images: string[];
  question?: string;
  reasoning?: boolean;
}

export interface ExtractTextInput extends Record<string, unknown> {
  image: string;
  question?: string;
  reasoning?: boolean;
}

export interface DescribeImageInput extends Record<string, unknown> {
  image: string;
  aspect?: string;
  reasoning?: boolean;
}

export interface VisionChunk {
  content?: string;
  reasoning?: string;
}

// ── Prompt templates ──────────────────────────────────────────────────

const ASPECT_PROMPTS: Record<string, string> = {
  general: "请详细描述这张图片的内容，包括主体、场景、颜色、构图等关键信息。",
  ui: "这是一张 UI 截图。请从用户体验角度分析：布局结构、视觉层次、交互元素、色彩搭配、可用性问题。列出所有可见的 UI 组件和文本。",
  chart: "这是一张图表/数据可视化。请分析：图表类型、数据趋势、关键数值、坐标轴含义、数据对比结论。把所有数值尽可能精确提取出来。",
  document: "这是一份文档/截图。请完整提取所有文字内容，保持原有的结构和层级。如果是表格，用 markdown 表格格式输出。",
  scene: "这是一张照片/场景图。请描述：场景类型、人物/物体、动作、环境、光线、氛围、可能的拍摄地点和时间。",
  code: "这是一张代码/技术截图。请提取所有代码内容，用 markdown 代码块输出，并解释代码的功能和逻辑。",
};

// ── Core API call ─────────────────────────────────────────────────────

export interface AnalyzeOptions {
  reasoning?: boolean;
  onChunk?: (chunk: VisionChunk) => void;
  signal?: AbortSignal;
}

export async function analyzeImage(
  images: string | string[],
  question: string,
  config: VisionApiConfig = loadVisionApiConfig(),
  opts: AnalyzeOptions = {},
): Promise<VisionResult> {
  if (config.source === "none" || !config.apiKey || !config.baseURL) {
    throw new Error(
      "视觉模型未配置。请在 MCP 面板编辑 vision-demo 的 env，填入 VISION_API_KEY（或 PAPERHUB_API_KEY）和 VISION_BASE_URL（指向 OpenAI 兼容的 /v1 端点）。或确保主 agent 的 hermes config.yaml 配了有效的 provider。",
    );
  }

  const imageList = Array.isArray(images) ? images : [images];
  if (!imageList.length) throw new Error("至少需要一张图片");

  const content: Array<Record<string, unknown>> = [];
  if (question) content.push({ type: "text", text: question });
  for (const img of imageList) {
    content.push(await toImageContent(img));
  }

  const url = `${config.baseURL.replace(/\/$/, "")}/chat/completions`;
  const reasoningEnabled = opts.reasoning ?? config.reasoningEnabled;
  const body: Record<string, unknown> = {
    model: config.model,
    messages: [{ role: "user", content }],
    stream: true,
    stream_options: { include_usage: true },
  };
  if (reasoningEnabled) {
    body.reasoning = { enabled: true };
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: opts.signal ?? AbortSignal.timeout(120_000),
    });
  } catch (err) {
    throw new Error(`视觉 API 不可达 (${url}): ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    let errMsg = errText;
    try {
      const j = JSON.parse(errText);
      errMsg = j.error?.message || j.message || errText;
    } catch { /* not json */ }
    throw new Error(`视觉 API 失败 (${res.status}): ${errMsg}`);
  }

  // 解析 SSE 流
  const contentParts: string[] = [];
  const reasoningParts: string[] = [];
  let usage: Record<string, unknown> | null = null;

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") continue;

      try {
        const chunk = JSON.parse(data) as Record<string, unknown>;
        if (chunk.usage) usage = chunk.usage as Record<string, unknown>;
        const choices = chunk.choices as unknown[];
        if (choices && choices.length > 0) {
          const delta = (choices[0] as Record<string, unknown>).delta as Record<string, unknown> | undefined;
          if (delta) {
            const c = typeof delta.content === "string" ? delta.content : "";
            const r = typeof delta.reasoning_content === "string" ? delta.reasoning_content : "";
            if (c) {
              contentParts.push(c);
              opts.onChunk?.({ content: c });
            }
            if (r) {
              reasoningParts.push(r);
              opts.onChunk?.({ reasoning: r });
            }
          }
        }
      } catch { /* ignore parse errors on partial chunks */ }
    }
  }

  return {
    content: contentParts.join(""),
    reasoning: reasoningParts.join(""),
    usage,
    model: config.model,
    mode: reasoningEnabled ? "vision+reasoning" : "vision",
    imageCount: imageList.length,
    finishedAt: new Date().toISOString(),
  };
}

// ── 便捷函数 ──────────────────────────────────────────────────────────

/** 分析图片（通用）。 */
export async function analyze(
  images: string | string[],
  question: string,
  opts: AnalyzeOptions = {},
): Promise<VisionResult> {
  return analyzeImage(images, question, loadVisionApiConfig(), opts);
}

/** 对比多张图片。 */
export async function compareImages(
  images: string[],
  question: string = "请对比这几张图片的异同，包括内容、风格、细节差异。",
  opts: AnalyzeOptions = {},
): Promise<VisionResult> {
  if (images.length < 2) throw new Error("对比至少需要 2 张图片");
  return analyzeImage(images, question, loadVisionApiConfig(), opts);
}

/** 提取图片中的文字（OCR）。 */
export async function extractText(
  image: string,
  question: string = "请提取图片中的所有文字内容，保持原有结构和层级。表格用 markdown 表格输出。",
  opts: AnalyzeOptions = {},
): Promise<VisionResult> {
  return analyzeImage(image, question, loadVisionApiConfig(), opts);
}

/** 按视角描述图片。aspect: general/ui/chart/document/scene/code。 */
export async function describeImage(
  image: string,
  aspect: string = "general",
  opts: AnalyzeOptions = {},
): Promise<VisionResult> {
  const prompt = ASPECT_PROMPTS[aspect] || ASPECT_PROMPTS.general;
  return analyzeImage(image, prompt, loadVisionApiConfig(), opts);
}

// ── AgentTool classes（供 ekko-agent 多步推理注册） ────────────────────

export class AnalyzeImageTool implements AgentTool<AnalyzeImageInput> {
  readonly definition = {
    name: "analyze_image",
    description:
      "Analyze one or more images with a question. Supports image URLs, local file paths, and base64. Returns detailed analysis with optional reasoning. Use for any image understanding task: what's in the image, answer questions about content, identify objects/text/scenes.",
    parameters: {
      type: "object",
      properties: {
        image: { type: "string", description: "Single image: URL, local file path, or base64 string" },
        images: {
          type: "array",
          items: { type: "string" },
          description: "Multiple images (alternative to 'image'). Use for comparison or multi-image analysis.",
        },
        question: { type: "string", description: "The question or instruction about the image(s). Defaults to general description." },
        reasoning: { type: "boolean", description: "Enable reasoning/thinking process. Default: true." },
      },
      additionalProperties: false,
    },
  };

  async execute(input: AnalyzeImageInput, _ctx: AgentToolContext = {}): Promise<AgentToolResult> {
    const imgs = input.images ?? (input.image ? [input.image] : []);
    if (!imgs.length) {
      return { ok: false, content: "image 或 images 参数必填", error: "missing_image" };
    }
    try {
      const result = await analyze(imgs, input.question || "请详细描述这张图片的内容。", {
        reasoning: input.reasoning,
      });
      if (!result.content) {
        return { ok: false, content: "视觉模型未返回内容", error: "empty_response", data: result };
      }
      return {
        ok: true,
        content: result.content,
        data: {
          reasoning: result.reasoning,
          model: result.model,
          mode: result.mode,
          imageCount: result.imageCount,
          usage: result.usage,
        },
      };
    } catch (e) {
      return { ok: false, content: `分析失败: ${e instanceof Error ? e.message : String(e)}`, error: "api_error" };
    }
  }
}

export class CompareImagesTool implements AgentTool<CompareImagesInput> {
  readonly definition = {
    name: "compare_images",
    description:
      "Compare 2+ images and identify similarities and differences. Pass multiple image URLs/paths. Returns comparative analysis.",
    parameters: {
      type: "object",
      properties: {
        images: {
          type: "array",
          items: { type: "string" },
          description: "2+ images to compare (URLs, file paths, or base64)",
        },
        question: { type: "string", description: "Custom comparison question. Defaults to general diff analysis." },
        reasoning: { type: "boolean", description: "Enable reasoning. Default: true." },
      },
      required: ["images"],
      additionalProperties: false,
    },
  };

  async execute(input: CompareImagesInput, _ctx: AgentToolContext = {}): Promise<AgentToolResult> {
    if (!input.images || input.images.length < 2) {
      return { ok: false, content: "对比至少需要 2 张图片", error: "need_2_images" };
    }
    try {
      const result = await compareImages(input.images, input.question, { reasoning: input.reasoning });
      return {
        ok: true,
        content: result.content,
        data: { reasoning: result.reasoning, model: result.model, imageCount: result.imageCount },
      };
    } catch (e) {
      return { ok: false, content: `对比失败: ${e instanceof Error ? e.message : String(e)}`, error: "api_error" };
    }
  }
}

export class ExtractTextTool implements AgentTool<ExtractTextInput> {
  readonly definition = {
    name: "extract_text",
    description:
      "Extract all text from an image (OCR). Preserves structure and hierarchy. Tables become markdown tables. Use for screenshots of documents, code, UI text, signs, etc.",
    parameters: {
      type: "object",
      properties: {
        image: { type: "string", description: "Image URL, local file path, or base64" },
        question: { type: "string", description: "Custom extraction instruction. Defaults to full text extraction." },
        reasoning: { type: "boolean", description: "Enable reasoning. Default: true." },
      },
      required: ["image"],
      additionalProperties: false,
    },
  };

  async execute(input: ExtractTextInput, _ctx: AgentToolContext = {}): Promise<AgentToolResult> {
    if (!input.image) {
      return { ok: false, content: "image 参数必填", error: "missing_image" };
    }
    try {
      const result = await extractText(input.image, input.question, { reasoning: input.reasoning });
      return {
        ok: true,
        content: result.content,
        data: { reasoning: result.reasoning, model: result.model },
      };
    } catch (e) {
      return { ok: false, content: `提取失败: ${e instanceof Error ? e.message : String(e)}`, error: "api_error" };
    }
  }
}

export class DescribeImageTool implements AgentTool<DescribeImageInput> {
  readonly definition = {
    name: "describe_image",
    description:
      "Describe an image from a specific perspective. aspect: 'general' (default), 'ui' (UX analysis of screenshots), 'chart' (data/chart analysis), 'document' (text extraction), 'scene' (photo/scene description), 'code' (code screenshot extraction).",
    parameters: {
      type: "object",
      properties: {
        image: { type: "string", description: "Image URL, local file path, or base64" },
        aspect: {
          type: "string",
          enum: ["general", "ui", "chart", "document", "scene", "code"],
          description: "Analysis perspective. Default: 'general'.",
        },
        reasoning: { type: "boolean", description: "Enable reasoning. Default: true." },
      },
      required: ["image"],
      additionalProperties: false,
    },
  };

  async execute(input: DescribeImageInput, _ctx: AgentToolContext = {}): Promise<AgentToolResult> {
    if (!input.image) {
      return { ok: false, content: "image 参数必填", error: "missing_image" };
    }
    try {
      const result = await describeImage(input.image, input.aspect || "general", {
        reasoning: input.reasoning,
      });
      return {
        ok: true,
        content: result.content,
        data: { reasoning: result.reasoning, model: result.model, aspect: input.aspect || "general" },
      };
    } catch (e) {
      return { ok: false, content: `描述失败: ${e instanceof Error ? e.message : String(e)}`, error: "api_error" };
    }
  }
}
