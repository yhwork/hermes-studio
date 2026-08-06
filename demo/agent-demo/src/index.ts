import { startServer } from "./server.js";
import { loadAgentConfig } from "./agent.js";

const { url, mode } = startServer();
const cfg = loadAgentConfig();

// eslint-disable-next-line no-console
console.log(`[agent-demo] v1.0.0 listening on ${url} (mode: ${mode})`);
if (mode === "local") {
  // eslint-disable-next-line no-console
  console.log("[agent-demo]   local mode — 在 /config 页配置独立模型，或确保 hermes config.yaml 有主 agent 模型配置");
} else {
  // eslint-disable-next-line no-console
  console.log(`[agent-demo]   LLM mode — source=${cfg.apiMode ? cfg.apiMode : "openai"}  base=${cfg.baseURL}  model=${cfg.model}`);
}
// eslint-disable-next-line no-console
console.log(`[agent-demo]   HTTP:  ${url}/chat (POST { message })`);
// eslint-disable-next-line no-console
console.log(`[agent-demo]   HTTP:  ${url}/rpc  (POST, JSON-RPC 2.0: agent.talk ...)`);
// eslint-disable-next-line no-console
console.log(`[agent-demo]   WS:    ${url.replace("http", "ws")}/ws   (JSON-RPC 2.0 + agent event stream)`);
