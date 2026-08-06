# Agent Demo

一个独立的 **测试用子智能体**，直接复用 **Hermes 同款引擎**（[`ekko-agent`](../../packages/ekko-agent) 的 `AgentRuntime`）—— 能思考、对话、执行命令，可通过 **HTTP / WebSocket / JSON-RPC** 调用，也可作为 **MCP 服务器** 被其他 Agent 当作工具调用。

用来端到端验证：**任务派发成功 → 子 Agent 思考并执行 → 结果回传**。

> 这不是手写的迷你循环，而是 Hermes 真正使用的 `AgentRuntime`：同一套系统提示、模型客户端、工具注册表、步数管理与事件流，只是装进了一个独立可运行的服务里。

---

## 目录

- [快速开始](#快速开始)
- [工作模式](#工作模式)
- [项目结构](#项目结构)
- [调用方式](#调用方式)
  - [1. HTTP REST](#1-http-rest)
  - [2. HTTP JSON-RPC](#2-http-json-rpc)
  - [3. WebSocket](#3-websocket)
  - [4. MCP 服务器](#4-mcp-服务器)
- [Agent 工具](#agent-工具)
- [结果回传（回调）](#结果回传回调)
- [配置项](#配置项)
- [在 Hermes Studio 中使用](#在-hermes-studio-中使用)
- [常见问题](#常见问题)

---

## 快速开始

```bash
cd demo/agent-demo
npm install
npm run dev        # tsx 直接运行（HTTP/WS/JSON-RPC 服务）
# 或
npm run mcp        # 以 MCP 服务器（stdio）形式运行
```

默认以 **local 模式**启动（无需 LLM key 即可演示派发与命令执行链路）：

```
[agent-demo] v1.0.0 listening on http://127.0.0.1:8787 (mode: local)
[agent-demo]   HTTP:  http://127.0.0.1:8787/chat (POST { message })
[agent-demo]   HTTP:  http://127.0.0.1:8787/rpc  (POST, JSON-RPC 2.0: agent.talk ...)
[agent-demo]   WS:    ws://127.0.0.1:8787/ws   (JSON-RPC 2.0 + agent event stream)
```

端口默认 `8787`（`PORT=9000` 覆盖），主机 `HOST=0.0.0.0` 覆盖。

> 本服务以 TS 源码经 `tsx` 运行（与 `packages/server` 一致：`tsc --noEmit` 仅做类型检查，不产出 dist）。`npm run build` 即类型检查。

---

## 工作模式

| 模式 | 触发条件 | 行为 |
|---|---|---|
| `llm` | 设置了 `AGENT_MODEL_KEY` | **真正的 Hermes 引擎**：`AgentRuntime` + OpenAI 兼容模型客户端，think → 调工具 → 观察结果 → 再思考 → 给出最终回答 |
| `local` | 未设置 key（默认） | 规则推理兜底：识别到命令就调 `terminal_exec` 执行，否则回声对话。**无需 key，开箱可测**，事件流与工具执行与 LLM 模式完全一致 |

两种模式共用同一套接口与事件流，父 Agent 无需感知差异。

---

## 项目结构

```
agent-demo/
├── package.json          # 依赖 ekko-agent（TS 源码）+ @modelcontextprotocol/sdk + zod
├── tsconfig.json         # commonjs / moduleResolution: node（与 server 一致，消费 ekko TS 源码）
├── src/
│   ├── index.ts          # 入口：启动 HTTP/WS 服务
│   ├── server.ts         # HTTP + WebSocket 路由与事件广播
│   ├── agent.ts          # 智能体核心：复用 ekko-agent 的 AgentRuntime + 本地推理兜底
│   ├── tasks.ts          # 任务管理器（把每次对话包成可追踪任务）
│   ├── jsonrpc.ts        # JSON-RPC 2.0 分发器
│   ├── ws.ts             # 手写 WebSocket（RFC 6455）
│   └── mcp.ts            # MCP 服务器封装（stdio，暴露 5 个工具）
└── README.md
```

`agent.ts` 通过相对路径导入 `../../packages/ekko-agent/src/...`，复用其 `AgentRuntime`、`OpenAICompatibleModelClient`、`createTerminalTools` / `createFileTools`。运行时依赖（`js-tiktoken`、`agent-browser`）由仓库根 `node_modules` 向上解析提供。

---

## 调用方式

### 1. HTTP REST

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 服务信息与端点清单 |
| GET | `/health` | 健康检查（含 `mode`） |
| POST | `/chat` | 与 Agent 对话。body：`{ message, async?, callbackUrl?, cwd?, maxSteps? }`。`async` 默认 `false`，同步返回完成的任务（含 `result`） |
| GET | `/tasks` | 列出全部任务 |
| GET | `/tasks/:id` | 查询单个任务状态/结果 |
| POST | `/tasks/:id/cancel` | 取消未完成任务 |

```bash
curl -sS http://127.0.0.1:8787/chat \
  -H 'content-type: application/json' \
  -d '{"message":"run: `node -e \"console.log(2+2)\"`"}' | jq
```

返回任务对象里 `result.events` 含完整思考链（`agent.thinking` → `agent.tool_call` → `agent.tool_result` → `agent.message`），`result.toolCalls` 列出执行过的工具，`result.content` 是最终回答。

### 2. HTTP JSON-RPC

`POST /rpc` 接受单个请求或批量请求。

```bash
curl -sS http://127.0.0.1:8787/rpc \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"agent.talk","params":{"message":"run: `echo hi`","async":false}}' | jq
```

### 3. WebSocket

连接 `ws://127.0.0.1:8787/ws`：

- 连接后自动收到 `{ event: "ws.connected" }`。
- 发送 JSON-RPC 请求（同 `/rpc` 的 method），服务器按 `id` 回复。
- 每个 WS 客户端自动订阅任务事件流，子 Agent 每一步都会被推送：

```
task.created → task.started → task.agent_event(agent.thinking)
  → task.agent_event(agent.tool_call) → task.agent_event(agent.tool_result)
  → task.agent_event(agent.message) → task.succeeded
```

```js
const ws = new WebSocket("ws://127.0.0.1:8787/ws");
ws.onmessage = (e) => console.log("<-", JSON.parse(e.data).result ?? JSON.parse(e.data).error);
ws.onopen = () => ws.send(JSON.stringify({
  jsonrpc: "2.0", id: 1, method: "agent.talk",
  params: { message: "run: `echo ws-from-parent`", async: true },
}));
```

### 4. MCP 服务器

`npm run mcp` 以 stdio 启动一个 MCP 服务器，把 Agent 的能力暴露成 5 个工具，供 Hermes 或任何 MCP 客户端调用：

| 工具 | 参数 | 说明 |
|---|---|---|
| `agent_chat` | `{ message, cwd?, maxSteps? }` | 与 Agent 对话，返回回答 + 步数 + 工具调用数 |
| `agent_run_command` | `{ command, cwd? }` | 通过 Agent 推理循环执行 shell 命令 |
| `agent_read_file` | `{ path, cwd? }` | 通过 Agent 读文件 |
| `agent_write_file` | `{ path, content, cwd? }` | 通过 Agent 写文件 |
| `agent_status` | — | 返回 Agent 配置与能力 |

在 Hermes Studio 的 MCP 面板注册：

```json
{
  "mcpServers": {
    "agent-demo": {
      "command": "npx",
      "args": ["tsx", "d:/qaweb/qaweb_tools/tools/hermes-studio/demo/agent-demo/src/mcp.ts"]
    }
  }
}
```

---

## JSON-RPC 方法一览

| 方法 | 参数 | 说明 |
|---|---|---|
| `ping` | — | `{ server, version, mode, pong }` |
| `echo` | `{ message }` | 原样回传 |
| `agent.talk` | `{ message, async?, callbackUrl?, cwd?, maxSteps? }` | 与 Agent 对话 |
| `agent.get_task` | `{ id }` | 查询任务 |
| `agent.list_tasks` | — | 列出全部任务 |
| `agent.cancel_task` | `{ id }` | 取消任务 |

---

## Agent 工具

子 Agent 的工具来自 ekko-agent（与 Hermes 同源）：

| 工具 | 参数 | 行为 |
|---|---|---|
| `terminal_exec` | `{ command, cwd? }` | 执行 shell 命令，返回 stdout/stderr/exitCode |
| `read_file` | `{ path, cwd? }` | 读取文件文本 |
| `write_file` | `{ path, content, cwd? }` | 写入文件 |

LLM 模式下由模型自行决定调用哪个工具；local 模式下由规则匹配触发 `terminal_exec`。

---

## 结果回传（回调）

派发任务时可带 `callbackUrl`。任务终结时（成功或失败），本服务会向该 URL `POST`：

```jsonc
{
  "agent": { "name": "agent-demo", "version": "1.0.0" },
  "event": "task.succeeded",   // 或 task.failed
  "task": { /* 完整任务对象，含 result.content / result.toolCalls / error */ }
}
```

这是「子 Agent 执行成功后主动回传结果」的端到端证明。

---

## 配置项

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8787` | HTTP/WS 监听端口 |
| `HOST` | `127.0.0.1` | 监听地址 |
| `AGENT_MODEL_KEY` | — | LLM API key（设置后进入 `llm` 模式）。回退读 `OPENAI_API_KEY` |
| `AGENT_MODEL_BASE` | `https://api.openai.com/v1` | OpenAI 兼容 base URL。回退读 `OPENAI_BASE_URL` |
| `AGENT_MODEL_NAME` | `gpt-4o-mini` | 模型名。回退读 `OPENAI_MODEL` |
| `AGENT_MODEL_PROVIDER` | `openai` | 提供商标识（影响请求风格推断） |

切到 LLM 模式示例：

```bash
AGENT_MODEL_KEY=sk-xxx AGENT_MODEL_BASE=https://api.deepseek.com/v1 AGENT_MODEL_NAME=deepseek-chat npm run dev
```

---

## 在 Hermes Studio 中使用

本服务有两种集成姿势：

1. **作为子 Agent 通过 HTTP/WS 调用**：父 Agent / 工作流向 `POST /chat` 或 `POST /rpc` 派发任务，通过轮询 `GET /tasks/:id`、订阅 `ws://.../ws`、或等待 `callbackUrl` 回调拿结果。
2. **作为 MCP 工具调用**：`npm run mcp` 启动 stdio MCP 服务器，在 Hermes Studio MCP 面板注册（见上），即可在对话中调用 `agent_chat` 等工具。

---

## 常见问题

**Q: 这和 `mcp-server-demo` 有什么区别？**
`mcp-server-demo` 是一组无状态的 MCP 工具（echo/add/delay 等），用于测 MCP 链路。本服务是一个**有状态的智能体**——复用 Hermes 的 `AgentRuntime`，能多步推理、跨步记忆、按需调用工具。

**Q: 默认 local 模式能证明什么？**
完整验证"派发 → 思考事件 → 工具调用 → 命令执行 → 结果回传"链路。local 模式用规则代替 LLM 做决策，其余（工具执行、事件流、回调）与 LLM 模式完全一致。设 `AGENT_MODEL_KEY` 即切换到真正的 Hermes 引擎。

**Q: 启动有点慢？**
首次 `tsx` 需编译 ekko-agent 的 TS 源码（含 tiktoken、agent-browser 等依赖图），冷启 2–3 秒属正常。

**Q: `npm run build` 不产出 dist？**
本服务与 `packages/server` 一致：`tsc --noEmit` 仅做类型检查，运行走 `tsx`（源码）。`bin` 字段为占位，实际通过 `npm run dev` / `npm start` 运行。

**Q: 命令执行有安全限制吗？**
`terminal_exec` 经 ekko-agent 的 `path-safety` 解析 cwd。这是一个**测试用**子 Agent，默认信任调用方；生产环境请自行加沙箱/白名单。
