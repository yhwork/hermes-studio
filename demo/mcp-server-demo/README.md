# MCP Server Demo

一个简单、通用的 **MCP (Model Context Protocol)** 测试服务器，用于在 Hermes Studio 或任何 MCP 客户端中验证：连接握手、工具调用、组合工具、数据通讯 / JSON-RPC、异步与超时、错误路径等场景。

- **传输方式**：stdio（默认，最适合本地测试）
- **实现语言**：TypeScript + `@modelcontextprotocol/sdk`
- **零外部网络依赖**：所有工具仅用 Node 内置能力

---

## 目录

- [快速开始](#快速开始)
- [项目结构](#项目结构)
- [工具清单](#工具清单)
  - [1. 连接 / 握手](#1-连接--握手)
  - [2. 基础工具调用](#2-基础工具调用)
  - [3. 组合工具](#3-组合工具)
  - [4. 数据通讯 / JSON-RPC](#4-数据通讯--json-rpc)
  - [5. 异步 / 超时](#5-异步--超时)
  - [6. 错误路径](#6-错误路径)
- [在 Hermes Studio 中注册](#在-hermes-studio-中注册)
- [手动调试](#手动调试)
- [常见问题](#常见问题)

---

## 快速开始

```bash
cd demo/mcp-server-demo
npm install
npm run dev        # 直接用 tsx 跑，无需构建
# 或
npm run build && npm start
```

启动成功时 **stderr** 会打印：

```
[mcp-server-demo] v1.0.0 running on stdio
```

> 注意：stdio 模式下 stdout 被占用作 JSON-RPC 通道，所有日志必须输出到 stderr。

---

## 项目结构

```
mcp-server-demo/
├── package.json
├── tsconfig.json
├── src/
│   └── index.ts        # 全部工具定义 + server 启动
└── README.md
```

---

## 工具清单

共 9 个工具，按测试场景分组。

### 1. 连接 / 握手

#### `ping`
健康检查 / 握手验证。客户端连接后调用它即可确认“链路是否通”。

- **参数**：无
- **返回**：`{ server, version, pong }`

```jsonc
// 调用
{}
// 返回
{ "server": "mcp-server-demo", "version": "1.0.0", "pong": "2026-07-30T08:00:00.000Z" }
```

### 2. 基础工具调用

#### `echo`
最简单的成功调用 —— 原样回传字符串，验证请求/响应往返。

- **参数**：
  - `message: string`（必填）—— 要回传的文本
- **返回**：纯文本

#### `add`
两数相加，验证数值型参数 + 结构化 JSON 输出。

- **参数**：
  - `a: number`（必填）
  - `b: number`（必填）
- **返回**：`{ a, b, sum }`

```jsonc
// 调用
{ "a": 2, "b": 3 }
// 返回
{ "a": 2, "b": 3, "sum": 5 }
```

### 3. 组合工具

#### `combine`
单次调用内部串联 `echo + uuid + timestamp`，返回合并 JSON。用来验证客户端能处理“一个工具内部组合多个操作”。

- **参数**：
  - `message: string`（必填）—— 传给内部 echo 步骤的文本
- **返回**：`{ echoed, uuid, timestamp: { iso, unixSeconds } }`

#### `batch`
按调用方声明的顺序执行多个子操作，每个子操作产出一条结构化结果。用来测试客户端渲染“一次调用 → 多条结构化结果”。

- **参数**：
  - `ops: Array<{ op: "echo" | "uuid" | "timestamp" | "random", value?: string }>`（1–20 条）
- **返回**：`Array<{ op, result }>`

```jsonc
// 调用
{
  "ops": [
    { "op": "echo", "value": "hello" },
    { "op": "uuid" },
    { "op": "timestamp" },
    { "op": "random" }
  ]
}
// 返回
[
  { "op": "echo", "result": "hello" },
  { "op": "uuid", "result": "9b1f...-...-...-...-..." },
  { "op": "timestamp", "result": { "iso": "...", "unixSeconds": 1785... } },
  { "op": "random", "result": 42 }
]
```

### 4. 数据通讯 / JSON-RPC

#### `jsonrpc_echo`
把调用参数包装成 JSON-RPC 2.0 信封原样回传，用来观察客户端是如何把参数序列化进 JSON-RPC 请求的。

- **参数**：
  - `method: string`（必填）—— 伪方法名，回传用
  - `params: object`（可选，默认 `{}`）—— 任意 JSON 对象，原样回传
- **返回**：`{ jsonrpc: "2.0", method, params, echoedAt }`

```jsonc
// 调用
{ "method": "demo.lookup", "params": { "q": "mcp", "limit": 3 } }
// 返回
{
  "jsonrpc": "2.0",
  "method": "demo.lookup",
  "params": { "q": "mcp", "limit": 3 },
  "echoedAt": "2026-07-30T08:00:00.000Z"
}
```

#### `sample_data`
返回指定形状的样例 JSON，测试客户端对结构化数据的解析与渲染。

- **参数**：
  - `shape: "list" | "object" | "nested" | "large"`（必填）
- **返回**：对应形状的 JSON
  - `list` —— 对象数组（3 条）
  - `object` —— 单层对象 + meta 子对象
  - `nested` —— 三层嵌套
  - `large` —— 50 条数组，用于体积/性能测试

### 5. 异步 / 超时

#### `delay`
延时 N 毫秒后返回，测试异步工具处理与客户端超时行为。

- **参数**：
  - `ms: number`（int, 0–10000, 默认 500）—— 等待毫秒数
- **返回**：`{ waitedMs, doneAt }`

> 调大 `ms`（如 8000）可观察客户端是否在等待期间阻塞或触发超时。

### 6. 错误路径

#### `fail`
永远返回 `isError: true`，用于负面路径测试 —— 验证客户端能把工具错误优雅地呈现给用户，而不是崩溃。

- **参数**：
  - `reason: string`（可选，默认 `"intentional failure"`）
- **返回**：`content: [{ type: "text", text: "Error: <reason>" }]`, `isError: true`

---

## 在 Hermes Studio 中注册

### 方式 A：开发模式（无需构建）

```json
{
  "mcpServers": {
    "demo": {
      "command": "npx",
      "args": ["tsx", "d:/qaweb/qaweb_tools/tools/hermes-studio/demo/mcp-server-demo/src/index.ts"]
    }
  }
}
```

### 方式 B：构建后运行

```json
{
  "mcpServers": {
    "demo": {
      "command": "node",
      "args": ["d:/qaweb/qaweb_tools/tools/hermes-studio/demo/mcp-server-demo/dist/index.js"]
    }
  }
}
```

注册后进入 Hermes Studio 的 MCP 面板，确认 `demo` 服务“连接成功”，工具列表里应能看到 `ping`、`echo`、`add`、`combine`、`batch`、`jsonrpc_echo`、`sample_data`、`delay`、`fail` 共 9 个工具。

---

## 手动调试

### 用 MCP Inspector 调试

```bash
cd demo/mcp-server-demo
npx @modelcontextprotocol/inspector npm run dev
```

会打开一个本地 Web UI，可逐个手动调用工具并查看 JSON-RPC 原始报文。

### 直接发 JSON-RPC 报文

stdio 服务也可以从命令行手动发送 JSON-RPC 验证数据通讯：

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"manual","version":"0.0.0"}}}' | npm run dev
```

> 因为 initialize 之后还要 `notifications/initialized`，且 stdio 会等待更多输入，建议用 Inspector 做完整调试；上面命令主要用于快速看握手响应。

---

## 常见问题

**Q: 启动后看不到任何输出？**
stdout 被 JSON-RPC 占用，启动日志在 stderr。用 Inspector 或在 MCP 客户端的日志面板里查看。

**Q: 工具调用失败提示“找不到工具”？**
确认客户端已收到 `tools/list` 的响应；若用构建产物，确认已 `npm run build`。

**Q: `delay` 调用一直挂着？**
检查客户端是否设置了比 `ms` 更短的工具超时；本工具上限 10 秒。

**Q: 想加自定义工具？**
在 [src/index.ts](src/index.ts) 里仿照现有 `server.tool(name, description, schema, handler)` 形式添加即可，无需改其它文件。
