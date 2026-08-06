# Image Gen Demo

一个独立的 **生图子智能体**，复用 **Hermes 同款引擎**（[`ekko-agent`](../../packages/ekko-agent) 的 `AgentRuntime`）—— 能理解创意简报、构造 prompt、调用 `generate_image` 工具生图/改图，并给出最终答复。可通过 **HTTP** 或 **MCP** 调用，可作为子 agent 被 Hermes Studio 派发任务。

图片生成统一走 **Hermes Web UI media 端点**（`POST /api/hermes/media/apikey-image-generate`，见 [`apikey-image-gen` skill](../../packages/skills/apikey-image-gen/SKILL.md)），由 Hermes 侧按 profile 的 `config.yaml` 选 provider（默认 `fun-codex`）。本服务不直接打上游图片 API。

---

## 快速开始

```bash
cd demo/image-gen-demo
npm install
npm run dev        # tsx 直接运行 HTTP 服务（默认 http://127.0.0.1:8789）
# 或
npm run mcp        # 以 MCP 服务器（stdio）形式运行
```

默认 **local 模式**启动（无需 LLM key，把输入当 prompt 直接生图，验证派发链路）：

```
[image-gen-demo] v1.0.0 listening on http://127.0.0.1:8789 (mode: local)
[image-gen-demo]   HTTP:  http://127.0.0.1:8789/generate (POST { prompt, mode?, size?, image_path?, output_path? })
[image-gen-demo]   HTTP:  http://127.0.0.1:8789/agent   (POST { message, maxSteps? } — delegate to the sub-agent)
[image-gen-demo]   HTTP:  http://127.0.0.1:8789/config  (tool description editor page)
```

端口默认 `8789`（`PORT=9000` 覆盖），主机 `HOST=0.0.0.0` 覆盖。

---

## 工作模式

| 模式 | 触发条件 | 行为 |
|---|---|---|
| `llm` | 设置了 `AGENT_MODEL_KEY` | **真 Hermes 引擎**：`AgentRuntime` + OpenAI 兼容模型客户端，think → 构造 prompt → `generate_image` → 观察结果 → 再思考 → 给最终答复 |
| `local` | 未设置 key（默认） | 把用户输入当 prompt 直接调 `generate_image`，回传结果。**无需 key，开箱可测**，事件流与工具执行与 LLM 模式一致 |

> ⚠ agent-demo 的模型客户端是 OpenAI 兼容协议（`chat_completions`）。若你的 LLM 入口是 Anthropic 协议（如 cc-switch 的 `https://tc-paperhub.diezhi.net/anthropic`），需经一个 OpenAI 兼容适配层接入，或给本 demo 加 Anthropic 客户端。

---

## 环境变量

### LLM（可选，未设则 local 模式）

| 变量 | 说明 |
|---|---|
| `AGENT_MODEL_KEY` | LLM API key（也可用 `OPENAI_API_KEY`） |
| `AGENT_MODEL_BASE` | OpenAI 兼容 base URL（也可用 `OPENAI_BASE_URL`） |
| `AGENT_MODEL_NAME` | 模型名（也可用 `OPENAI_MODEL`） |
| `AGENT_MODEL_PROVIDER` | provider 类型，默认 `openai` |

### Hermes Web UI（生图工具用）

| 变量 | 说明 |
|---|---|
| `HERMES_WEB_UI_URL` | Hermes Web UI base URL，默认 `http://127.0.0.1:8647`（dev 后端） |
| `AUTH_TOKEN` | Hermes Web UI server token（生图端点鉴权用）。未设则按顺序读 `HERMES_WEB_UI_HOME/.token` → `HERMES_WEBUI_STATE_DIR/.token` → `~/.hermes-web-ui/.token` |
| `HERMES_PROFILE` | Hermes profile 名，默认 `default`（作为 `X-Hermes-Profile` 头） |
| `IMAGE_PROVIDER` | config.yaml 里配置的 custom provider 名，默认 `fun-codex` |
| `IMAGE_OUTPUT_DIR` | 默认输出目录，默认 `~/image-gen-demo` |

---

## HTTP 调用

### 直接生图

```bash
curl -X POST http://127.0.0.1:8789/generate -H "Content-Type: application/json" \
  -d '{"prompt":"A cinematic 4K photo of a silver robot hand holding a glowing cube","size":"1536x1024"}'
```

响应：

```jsonc
{ "ok": true, "content": "Generated 1 image(s) via fun-codex (text mode). Saved: .../img-xxx.png",
  "data": { "mode": "text", "output_paths": [".../img-xxx.png"], "provider": "fun-codex", ... } }
```

### 委派给子 agent（LLM 模式下会自主推理）

```bash
curl -X POST http://127.0.0.1:8789/agent -H "Content-Type: application/json" \
  -d '{"message":"帮我画一张赛博朋克风格的猫咪，要霓虹灯","maxSteps":12}'
```

---

## MCP 接入

### 方式一：页面操作

1. 打开 Hermes Studio（`http://localhost:8649`）
2. 进入 **设置 → MCP 服务器** 面板
3. 点击 **+ 添加服务器**
4. 选择 JSON 或 YAML 格式输入配置

**stdio 模式（JSON）：**

```json
{
  "image-gen-demo": {
    "command": "C:\\nvm4w\\nodejs\\node.exe",
    "args": [
      "d:/qaweb/qaweb_tools/tools/hermes-studio/demo/image-gen-demo/node_modules/tsx/dist/cli.mjs",
      "d:/qaweb/qaweb_tools/tools/hermes-studio/demo/image-gen-demo/src/mcp.ts"
    ],
    "env": {
      "IMAGE_API_KEY": "sk-xxx",
      "IMAGE_BASE_URL": "https://api.openai.com/v1",
      "IMAGE_MODEL": "gpt-image-2"
    }
  }
}
```

**URL 模式（JSON，需先 `npm start`）：**

```json
{
  "image-gen-demo": {
    "url": "http://localhost:8789/mcp"
  }
}
```

**YAML 格式同样支持：**

```yaml
image-gen-demo:
  command: C:\nvm4w\nodejs\node.exe
  args:
    - d:/qaweb/qaweb_tools/tools/hermes-studio/demo/image-gen-demo/node_modules/tsx/dist/cli.mjs
    - d:/qaweb/qaweb_tools/tools/hermes-studio/demo/image-gen-demo/src/mcp.ts
  env:
    IMAGE_API_KEY: sk-xxx
    IMAGE_BASE_URL: https://api.openai.com/v1
    IMAGE_MODEL: gpt-image-2
```

5. 保存 → 点「获取工具列表」验证连通

### 方式二：手动编辑 config.yaml

文件位置：`C:\Users\<用户名>\AppData\Local\hermes\config.yaml`

**stdio 模式：**

```yaml
mcp_servers:
  image-gen-demo:
    command: C:\nvm4w\nodejs\node.exe
    args:
      - d:/qaweb/qaweb_tools/tools/hermes-studio/demo/image-gen-demo/node_modules/tsx/dist/cli.mjs
      - d:/qaweb/qaweb_tools/tools/hermes-studio/demo/image-gen-demo/src/mcp.ts
    env:
      IMAGE_API_KEY: sk-xxx
      IMAGE_BASE_URL: https://api.openai.com/v1
      IMAGE_MODEL: gpt-image-2
```

**URL 模式：**

```yaml
mcp_servers:
  image-gen-demo:
    url: http://localhost:8789/mcp
```

> ⚠ stdio 模式必须用**绝对路径**（node.exe + tsx cli + mcp.ts）。hermes-agent 网关 spawn 时固定以 hermes-studio 根为 CWD，bare specifier 会失败。

### 方式三：其他平台 Agent 远程调用

**HTTP REST：**

```bash
# 文生图
curl -X POST http://<host>:8789/generate -H "Content-Type: application/json" \
  -d '{"prompt":"a cat","size":"1024x1024"}'

# 委派子 agent
curl -X POST http://<host>:8789/agent -H "Content-Type: application/json" \
  -d '{"message":"画一张赛博朋克猫"}'
```

**远程 hermes 实例：**

```yaml
mcp_servers:
  image-gen-demo:
    url: http://10.10.135.197:8789/mcp
```

**Node.js MCP Client：**

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const transport = new StreamableHTTPClientTransport(new URL("http://localhost:8789/mcp"));
const client = new Client({ name: "my-app", version: "1.0.0" });
await client.connect(transport);
const result = await client.callTool({ name: "image_gen", arguments: { prompt: "a cat" } });
```

### 调试

```bash
# 测试 stdio 连通
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' | npx tsx src/mcp.ts

# 测试 HTTP MCP
curl -X POST http://localhost:8789/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream, application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'
```

---

## MCP 工具

| 工具 | 参数 | 说明 |
|---|---|---|
| `image_gen` | `{ prompt, size?, output_path?, provider?, n? }` | 文生图 |
| `image_edit` | `{ prompt, image_path, mode?, size?, output_path?, provider? }` | 图生图 / 编辑（`mode`: `image`/`edit`） |
| `agent_chat` | `{ message, cwd?, maxSteps? }` | 委派创意简报给子 agent（LLM 模式下自主推理 + 多步） |
| `agent_status` | — | 返回 agent 配置与能力 |

---

## 项目结构

```
src/
├── index.ts             # HTTP 服务入口
├── server.ts            # HTTP 路由：/generate /agent /config /api/tool-descriptions /health
├── mcp.ts               # MCP 服务器封装（stdio，暴露 4 个工具）
├── agent.ts             # AgentRuntime 集成 + LLM/local 模式
├── image-tool.ts        # generate_image 工具（调 Hermes media 端点）
├── tool-descriptions.ts # 工具描述注册表 + Hermes 端点配置
└── config-page.ts       # /config HTML 编辑页
```

---

## 安全提示

`generate_image` 经 Hermes Web UI 端点调用，鉴权用 server token。这是一个**测试用**子 agent，默认信任调用方；生产环境请自行加沙箱/白名单/输出路径校验。
