/**
 * 打包脚本 —— 用 esbuild 将 news-demo 打成独立 ZIP 便携包。
 *
 * 产出：
 *   dist/
 *     news-demo-serve.js   — 统一服务入口（REST + MCP HTTP + 交互式 IO）
 *     news-demo-mcp.js     — MCP stdio 入口
 *     start.bat            — Windows 一键启动
 *     start.sh             — Linux/macOS 一键启动
 *     README.txt           — 使用说明
 *   news-demo.zip          — 上述打包成 ZIP
 *
 * 用法：
 *   node build.mjs
 */
import { build } from "esbuild";
import { writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(__dirname, "dist");

// Clean
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
  // Mark Node.js built-ins as external
  external: [],
  banner: {
    js: `import { createRequire } from 'module'; const require = createRequire(import.meta.url);`,
  },
};

console.log("[build] Bundling serve entry...");
await build({
  ...commonOptions,
  entryPoints: [resolve(__dirname, "src/serve.ts")],
  outfile: resolve(distDir, "news-demo-serve.js"),
});

console.log("[build] Bundling MCP stdio entry...");
await build({
  ...commonOptions,
  entryPoints: [resolve(__dirname, "src/mcp.ts")],
  outfile: resolve(distDir, "news-demo-mcp.js"),
});

// ─── start.bat ───────────────────────────────────────────────────────
writeFileSync(
  resolve(distDir, "start.bat"),
  `@echo off
title news-demo
echo Starting news-demo server...
echo.
node news-demo-serve.js %*
pause
`,
  "utf-8",
);

// ─── start.sh ────────────────────────────────────────────────────────
writeFileSync(
  resolve(distDir, "start.sh"),
  `#!/bin/bash
echo "Starting news-demo server..."
echo
exec node news-demo-serve.js "$@"
`,
  "utf-8",
);

// ─── README.txt ──────────────────────────────────────────────────────
writeFileSync(
  resolve(distDir, "README.txt"),
  `news-demo v2.0.0 — 新闻热点 sub-agent 便携包
========================================

要求：Node.js >= 18

启动方式：
  Windows:  双击 start.bat 或运行 node news-demo-serve.js
  Linux:    chmod +x start.sh && ./start.sh

默认端口 8790，环境变量覆盖：
  PORT=9000 node news-demo-serve.js

接入方式：
  HTTP REST:         POST http://localhost:8790/hot
  MCP HTTP:          http://localhost:8790/mcp
  MCP stdio:         node news-demo-mcp.js

可用工具：
  hot_news       — 获取热搜（微博/知乎/百度/抖音/36氪）
  news_search    — 关键词搜索新闻
  news_summary   — 新闻摘要
  agent_chat     — 委派子 agent 分析
  agent_status   — 查看状态

Claude Code 配置（.mcp.json）：
  {
    "mcpServers": {
      "news-demo": {
        "command": "node",
        "args": ["path/to/news-demo-mcp.js"]
      }
    }
  }

环境变量（可选）：
  PORT              — HTTP 端口（默认 8790）
  HOST              — 监听地址（默认 0.0.0.0）
  AGENT_MODEL_KEY   — LLM API key（启用 AI 分析）
  AGENT_MODEL_BASE  — LLM API base URL
  AGENT_MODEL_NAME  — LLM 模型名
`,
  "utf-8",
);

// ─── ZIP ─────────────────────────────────────────────────────────────
const zipFile = resolve(__dirname, "news-demo.zip");
if (existsSync(zipFile)) unlinkSync(zipFile);

try {
  // Try 7z first (common on Windows)
  execSync(`7z a -tzip "${zipFile}" "${distDir}/*"`, { stdio: "pipe" });
  console.log(`[build] ZIP created: news-demo.zip (7z)`);
} catch {
  try {
    // Fallback to PowerShell on Windows
    execSync(
      `powershell -Command "Compress-Archive -Path '${distDir}/*' -DestinationPath '${zipFile}'"`,
      { stdio: "pipe" },
    );
    console.log(`[build] ZIP created: news-demo.zip (PowerShell)`);
  } catch {
    try {
      // Fallback to zip command (Linux/macOS)
      execSync(`cd "${distDir}" && zip -r "${zipFile}" .`, { stdio: "pipe", shell: true });
      console.log(`[build] ZIP created: news-demo.zip (zip)`);
    } catch {
      console.log(`[build] ⚠ ZIP 工具不可用，dist/ 目录已就绪，请手动压缩`);
    }
  }
}

console.log("[build] Done!");
console.log(`  dist/news-demo-serve.js  — 统一服务`);
console.log(`  dist/news-demo-mcp.js    — MCP stdio`);
console.log(`  dist/start.bat           — Windows 启动`);
console.log(`  dist/start.sh            — Linux/macOS 启动`);
