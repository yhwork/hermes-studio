/**
 * HTTP-only 入口 —— 启动 REST + MCP HTTP 服务，不启动交互式 IO。
 * 适合后台部署 / Docker / 无 TTY 环境。
 *
 *   npx tsx src/index.ts
 *   PORT=9100 npx tsx src/index.ts
 */
// serve.ts 已包含完整服务逻辑，这里只需用 --no-interactive 参数调用它。
// 用 .then() 而非顶层 await，避免 tsx 在 CJS 格式下不支持顶层 await 的问题。
process.argv.push("--no-interactive");
import("./serve.js").catch((err) => {
  console.error("Failed to start case-demo:", err);
  process.exit(1);
});

export {};
