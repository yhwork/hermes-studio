/**
 * HTTP-only 入口 —— 启动 REST + MCP HTTP 服务，不启动交互式 IO。
 * 适合后台部署 / Docker / 无 TTY 环境。
 *
 *   npx tsx src/index.ts
 *   PORT=9000 npx tsx src/index.ts
 */
// serve.ts 已包含完整服务逻辑，这里只需用 --no-interactive 参数调用它
process.argv.push("--no-interactive");
await import("./serve.js");
