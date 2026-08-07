/**
 * 打包脚本 —— 用 esbuild 将 case-demo 打成独立 ZIP 便携包。
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
  outfile: resolve(distDir, "case-demo-serve.js"),
});

console.log("[build] Bundling MCP stdio entry...");
await build({
  ...commonOptions,
  entryPoints: [resolve(__dirname, "src/mcp.ts")],
  outfile: resolve(distDir, "case-demo-mcp.js"),
});

writeFileSync(
  resolve(distDir, "start.bat"),
  `@echo off
title case-demo
echo Starting case-demo server...
echo.
node case-demo-serve.js %*
pause
`,
  "utf-8",
);

writeFileSync(
  resolve(distDir, "start.sh"),
  `#!/bin/bash
echo "Starting case-demo server..."
echo
exec node case-demo-serve.js "$@"
`,
  "utf-8",
);

writeFileSync(
  resolve(distDir, "README.txt"),
  `case-demo v1.0.0 — 测试用例生成 agent 便携包
========================================

要求：Node.js >= 18

启动方式：
  Windows:  双击 start.bat 或运行 node case-demo-serve.js
  Linux:    chmod +x start.sh && ./start.sh

默认端口 8792，环境变量覆盖：
  PORT=9100 node case-demo-serve.js

接入方式：
  HTTP REST:         POST http://localhost:8792/generate
  MCP HTTP:          http://localhost:8792/mcp
  MCP stdio:         node case-demo-mcp.js

可用工具：
  generate_cases   — 从需求文本/文档生成完整用例树（Markdown）
  edit_cases       — 按指令局部编辑用例树
  read_requirement — 读取 .docx/.xlsx/.txt/.md 需求文档
  validate_cases   — 校验用例树结构是否符合方法论
  export_xmind     — 导出为 .xmind 文件
  agent_chat       — 委派子 agent 多步处理
  agent_status     — 查看状态

LLM 模型配置（环境变量，或访问 /config 页面配置）：
  AGENT_MODEL_KEY      — LLM API key（或 OPENAI_API_KEY）
  AGENT_MODEL_BASE     — LLM base URL（或 OPENAI_BASE_URL）
  AGENT_MODEL_NAME     — LLM 模型名（或 OPENAI_MODEL）
  AGENT_MODEL_PROVIDER — provider（默认 openai）

也可直接继承 hermes 主 agent 的 config.yaml 配置（无需重复设置）。

Claude Code 配置（.mcp.json）：
  {
    "mcpServers": {
      "case-demo": {
        "command": "node",
        "args": ["path/to/case-demo-mcp.js"],
        "env": {
          "AGENT_MODEL_KEY": "sk-xxx",
          "AGENT_MODEL_BASE": "https://api.openai.com/v1",
          "AGENT_MODEL_NAME": "gpt-4o-mini"
        }
      }
    }
  }
`,
  "utf-8",
);

const zipFile = resolve(__dirname, "case-demo.zip");
if (existsSync(zipFile)) unlinkSync(zipFile);

try {
  execSync(`7z a -tzip "${zipFile}" "${distDir}/*"`, { stdio: "pipe" });
  console.log(`[build] ZIP created: case-demo.zip (7z)`);
} catch {
  try {
    execSync(
      `powershell -Command "Compress-Archive -Path '${distDir}/*' -DestinationPath '${zipFile}'"`,
      { stdio: "pipe" },
    );
    console.log(`[build] ZIP created: case-demo.zip (PowerShell)`);
  } catch {
    try {
      execSync(`cd "${distDir}" && zip -r "${zipFile}" .`, { stdio: "pipe", shell: true });
      console.log(`[build] ZIP created: case-demo.zip (zip)`);
    } catch {
      console.log(`[build] ⚠ ZIP 工具不可用，dist/ 目录已就绪，请手动压缩`);
    }
  }
}

console.log("[build] Done!");
