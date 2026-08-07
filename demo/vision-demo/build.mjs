/**
 * 打包脚本 —— 用 esbuild 将 vision-demo 打成独立 ZIP 便携包。
 *
 *   node build.mjs
 */
import { build } from "esbuild";
import { writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(__dirname, "dist");

if (existsSync(distDir)) {
  execSync(`rm -rf "${distDir}"`, { cwd: __dirname, shell: true });
}
mkdirSync(distDir, { recursive: true });

const commonOptions = {
  bundle: true,
  platform: "node",
  target: "node18",
  format: "esm",
  sourcemap: false,
  minify: true,
  treeShaking: true,
  external: [],
  banner: {
    js: `import { createRequire } from 'module'; const require = createRequire(import.meta.url);`,
  },
};

console.log("[build] Bundling serve entry...");
await build({
  ...commonOptions,
  entryPoints: [resolve(__dirname, "src/serve.ts")],
  outfile: resolve(distDir, "vision-demo-serve.js"),
});

console.log("[build] Bundling MCP stdio entry...");
await build({
  ...commonOptions,
  entryPoints: [resolve(__dirname, "src/mcp.ts")],
  outfile: resolve(distDir, "vision-demo-mcp.js"),
});

writeFileSync(
  resolve(distDir, "start.bat"),
  `@echo off
title vision-demo
echo Starting vision-demo server...
echo.
node vision-demo-serve.js %*
pause
`,
  "utf-8",
);

writeFileSync(
  resolve(distDir, "start.sh"),
  `#!/bin/bash
echo "Starting vision-demo server..."
echo
exec node vision-demo-serve.js "$@"
`,
  "utf-8",
);

writeFileSync(
  resolve(distDir, "README.txt"),
  `vision-demo v1.0.0 — 图像识别分析 agent 便携包
========================================

要求：Node.js >= 18

启动方式：
  Windows:  双击 start.bat 或运行 node vision-demo-serve.js
  Linux:    chmod +x start.sh && ./start.sh

默认端口 8791，环境变量覆盖：
  PORT=9000 node vision-demo-serve.js

接入方式：
  HTTP REST:         POST http://localhost:8791/analyze
  MCP HTTP:          http://localhost:8791/mcp
  MCP stdio:         node vision-demo-mcp.js

可用工具：
  analyze_image    — 分析图片（URL/路径/base64），带思考过程
  compare_images   — 对比多张图片
  extract_text     — 提取图片文字（OCR）
  describe_image   — 按视角描述（general/ui/chart/document/scene/code）
  agent_chat       — 委派子 agent 多步分析
  agent_status     — 查看状态

视觉模型配置（环境变量）：
  VISION_API_KEY       — API key（或 PAPERHUB_API_KEY）
  VISION_BASE_URL      — OpenAI 兼容 /v1 端点
  VISION_MODEL         — 视觉模型名（默认 doubao-seed-1-6-vision）
  REASONING_ENABLED    — 思考过程开关（默认 1）

Agent 模型配置（可选，多步推理用）：
  AGENT_MODEL_KEY      — LLM API key
  AGENT_MODEL_BASE     — LLM base URL
  AGENT_MODEL_NAME     — LLM 模型名

Claude Code 配置（.mcp.json）：
  {
    "mcpServers": {
      "vision-demo": {
        "command": "node",
        "args": ["path/to/vision-demo-mcp.js"],
        "env": {
          "VISION_API_KEY": "sk-xxx",
          "VISION_BASE_URL": "https://tc-paperhub.diezhi.net/v1",
          "VISION_MODEL": "doubao-seed-1-6-vision"
        }
      }
    }
  }
`,
  "utf-8",
);

const zipFile = resolve(__dirname, "vision-demo.zip");
if (existsSync(zipFile)) unlinkSync(zipFile);

try {
  execSync(`7z a -tzip "${zipFile}" "${distDir}/*"`, { stdio: "pipe" });
  console.log(`[build] ZIP created: vision-demo.zip (7z)`);
} catch {
  try {
    execSync(
      `powershell -Command "Compress-Archive -Path '${distDir}/*' -DestinationPath '${zipFile}'"`,
      { stdio: "pipe" },
    );
    console.log(`[build] ZIP created: vision-demo.zip (PowerShell)`);
  } catch {
    try {
      execSync(`cd "${distDir}" && zip -r "${zipFile}" .`, { stdio: "pipe", shell: true });
      console.log(`[build] ZIP created: vision-demo.zip (zip)`);
    } catch {
      console.log(`[build] ⚠ ZIP 工具不可用，dist/ 目录已就绪，请手动压缩`);
    }
  }
}

console.log("[build] Done!");
