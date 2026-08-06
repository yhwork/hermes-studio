import { startServer } from "./server.js";
import { loadAgentConfig } from "./agent.js";

const { url, mode } = startServer();
const cfg = loadAgentConfig();

console.log(`[news-demo] v1.0.0 listening on ${url} (mode: ${mode})`);
if (mode === "local") {
  console.log("[news-demo]   local mode — 在 /config 页配置独立模型，或确保 hermes config.yaml 有主 agent 模型配置");
} else {
  console.log(`[news-demo]   LLM mode — source=${cfg.apiMode ?? "openai"}  base=${cfg.baseURL}  model=${cfg.model}`);
}
console.log(`[news-demo]   HTTP: ${url}/hot     (POST { platform?, count? })`);
console.log(`[news-demo]   HTTP: ${url}/search  (POST { keyword, count? })`);
console.log(`[news-demo]   HTTP: ${url}/summary (POST { url? | title? + content? })`);
console.log(`[news-demo]   HTTP: ${url}/agent   (POST { message, maxSteps? })`);
console.log(`[news-demo]   HTTP: ${url}/config  (工具描述编辑页)`);
