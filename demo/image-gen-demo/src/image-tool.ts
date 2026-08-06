import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { AgentTool, AgentToolContext, AgentToolResult } from "../../../packages/ekko-agent/src/tools/types";
import { loadMainAgentModelConfig } from "./hermes-config.js";

/**
 * generate_image 工具 —— 调用 OpenAI 兼容的 `/images/generations` 端点生图。
 *
 * 配置优先级（跟模型一致）：
 *   1. MCP env 独立配置：IMAGE_API_KEY + IMAGE_BASE_URL + IMAGE_MODEL
 *   2. 继承主 agent：读 hermes config.yaml 的 provider api + api_key，
 *      用同一套 base_url + key 调 /images/generations
 *   3. 都没有 → 清晰报错，让用户去 MCP 面板配
 *
 * 不内置任何默认值，不走 Hermes media 端点。
 */

export interface GenerateImageInput extends Record<string, unknown> {
  prompt: string;
  mode?: "text" | "image" | "edit";
  size?: string;
  image_path?: string;
  output_path?: string;
  model?: string;
  n?: number;
}

export interface ImageApiConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  source: "env" | "hermes" | "none";
}

/** 加载图片 API 配置。优先级：MCP env > 主 agent 继承 > none。 */
export function loadImageApiConfig(): ImageApiConfig {
  // 1. MCP env 独立配置
  const envKey = (process.env.IMAGE_API_KEY ?? "").trim();
  const envBase = (process.env.IMAGE_BASE_URL ?? "").trim();
  if (envKey && envBase) {
    return {
      apiKey: envKey,
      baseURL: envBase,
      model: (process.env.IMAGE_MODEL ?? "gpt-image-2").trim(),
      source: "env",
    };
  }

  // 2. 继承主 agent（hermes config.yaml 的 provider）
  const main = loadMainAgentModelConfig();
  if (main && main.apiKey && main.baseURL) {
    return {
      apiKey: main.apiKey,
      baseURL: main.baseURL,
      model: process.env.IMAGE_MODEL?.trim() || "gpt-image-2",
      source: "hermes",
    };
  }

  // 3. 无配置
  return { apiKey: "", baseURL: "", model: "", source: "none" };
}

export class GenerateImageTool implements AgentTool<GenerateImageInput> {
  readonly definition = {
    name: "generate_image",
    description:
      "Generate or edit an image via OpenAI-compatible /images/generations endpoint. mode: 'text' (text-to-image). Returns saved file path(s).",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The image prompt. Be specific about style, subject, composition, lighting." },
        mode: { type: "string", enum: ["text", "image", "edit"], description: "Generation mode. Defaults to 'text'." },
        size: { type: "string", description: "Image size, e.g. 1024x1024, 1536x1024, 2048x2048. Defaults to 1024x1024." },
        image_path: { type: "string", description: "Reference/source image path (absolute). Required for 'image' and 'edit' modes." },
        output_path: { type: "string", description: "Absolute output file path. If omitted, saved under IMAGE_OUTPUT_DIR." },
        model: { type: "string", description: "Override image model. If omitted, uses IMAGE_MODEL env or default." },
        n: { type: "number", description: "Number of images. Defaults to 1." },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
  };

  constructor(private config: ImageApiConfig = loadImageApiConfig()) {}

  async execute(input: GenerateImageInput, _context: AgentToolContext = {}): Promise<AgentToolResult> {
    if (!input.prompt?.trim()) {
      return { ok: false, content: "prompt is required", error: "missing_prompt" };
    }

    if (this.config.source === "none" || !this.config.apiKey || !this.config.baseURL) {
      return {
        ok: false,
        content: "图片生成未配置。请在 Hermes Studio MCP 面板编辑 image-gen-demo 的 env 字段，填入 IMAGE_API_KEY 和 IMAGE_BASE_URL（指向支持 /images/generations 的 OpenAI 兼容端点）。或确保主 agent 的 hermes config.yaml 配了有效的 provider（api + api_key）。",
        error: "not_configured",
      };
    }

    return this.callImageApi(input);
  }

  private async callImageApi(input: GenerateImageInput): Promise<AgentToolResult> {
    const url = `${this.config.baseURL.replace(/\/$/, "")}/images/generations`;
    const model = input.model || this.config.model;
    const n = input.n || 1;
    const body: Record<string, unknown> = {
      model,
      prompt: input.prompt,
      n,
      size: input.size || "1024x1024",
      quality: "high",
      output_format: "png",
    };

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${this.config.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(180_000),
      });
    } catch (err) {
      return {
        ok: false,
        content: `图片 API 不可达 (${url}): ${err instanceof Error ? err.message : String(err)}。如果当前继承的主 agent 端点不支持图片生成，请在 MCP env 里单独配置 IMAGE_BASE_URL 指向支持 /images/generations 的端点。`,
        error: "fetch_failed",
      };
    }

    const data = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (!res.ok) {
      const errMsg = typeof data.error === "object" ? (data.error as any)?.message || JSON.stringify(data.error) : data.error || data.message || res.statusText;
      return {
        ok: false,
        content: `图片生成失败 (${res.status}): ${errMsg}。当前 source=${this.config.source}，base=${this.config.baseURL}，model=${model}`,
        error: String(res.status),
        data,
      };
    }

    const items = (data.data || []) as Array<{ b64_json?: string; url?: string }>;
    if (!items.length) {
      return { ok: false, content: "API 未返回图片数据", error: "no_image", data };
    }

    const outputDir = process.env.IMAGE_OUTPUT_DIR || join(homedir(), "image-gen-demo");
    if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
    const paths: string[] = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const outPath = (i === 0 && input.output_path) ? input.output_path : join(outputDir, `img-${Date.now()}-${i}.png`);
      try {
        if (it.b64_json) {
          writeFileSync(outPath, Buffer.from(it.b64_json, "base64"));
        } else if (it.url) {
          const r = await fetch(it.url);
          if (!r.ok) throw new Error(`download ${it.url} → ${r.status}`);
          writeFileSync(outPath, Buffer.from(await r.arrayBuffer()));
        } else {
          continue;
        }
        paths.push(outPath);
      } catch (err) {
        return { ok: false, content: `保存图片失败: ${err instanceof Error ? err.message : String(err)}`, error: "save_failed" };
      }
    }

    return {
      ok: true,
      content: `Generated ${paths.length} image(s) (source=${this.config.source}, model=${model}). Saved: ${paths.join(", ")}`,
      data: { output_paths: paths, source: this.config.source, base_url: this.config.baseURL, model },
    };
  }
}

/** 便捷函数：直接生图。 */
export async function generateImage(
  input: GenerateImageInput,
  config: ImageApiConfig = loadImageApiConfig(),
): Promise<AgentToolResult> {
  const tool = new GenerateImageTool(config);
  return tool.execute(input);
}

/** 仅用于 local 模式回声场景：把用户输入当 prompt 直接生图。 */
export function describeInputForLocal(input: string): string {
  return input.trim() || "A simple test image";
}
