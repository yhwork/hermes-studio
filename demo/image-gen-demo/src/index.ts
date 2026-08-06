import { startServer } from "./server.js";
import { loadAgentConfig } from "./agent.js";

const { url, mode } = startServer();
const cfg = loadAgentConfig();

// eslint-disable-next-line no-console
console.log(`[image-gen-demo] v1.0.0 listening on ${url} (mode: ${mode})`);
if (mode === "local") {
  // eslint-disable-next-line no-console
  console.log("[image-gen-demo]   local mode — 在 /config 页配置独立模型，或确保 hermes config.yaml 有主 agent 模型配置");
} else {
  // eslint-disable-next-line no-console
  console.log(`[image-gen-demo]   LLM mode — source=${cfg.apiMode ? cfg.apiMode : "openai"}  base=${cfg.baseURL}  model=${cfg.model}`);
}
// eslint-disable-next-line no-console
console.log(`[image-gen-demo]   HTTP:  ${url}/generate (POST { prompt, mode?, size?, image_path?, output_path? })`);
// eslint-disable-next-line no-console
console.log(`[image-gen-demo]   HTTP:  ${url}/agent   (POST { message, maxSteps? } — delegate to the sub-agent)`);
// eslint-disable-next-line no-console
console.log(`[image-gen-demo]   HTTP:  ${url}/config  (tool description editor page)`);
