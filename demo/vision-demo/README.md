# vision-demo

图像识别分析 sub-agent —— 支持图像分析/对比/OCR/描述，带**思考过程**（reasoning）。

基于 OpenAI 兼容的视觉模型（如 `doubao-seed-1-6-vision`），提供三种接入方式：
- **MCP stdio**：Hermes Studio / Claude Code 本地注册
- **MCP Streamable HTTP**：远程 MCP 客户端
- **HTTP REST**：其他平台 agent 调用

---

## 功能

| 工具 | 说明 |
|------|------|
| `analyze_image` | 分析图片（URL/本地路径/base64），回答问题，带思考过程 |
| `compare_images` | 对比 2+ 张图片的异同 |
| `extract_text` | 提取图片中的文字（OCR），保持结构 |
| `describe_image` | 按视角描述：`general` / `ui` / `chart` / `document` / `scene` / `code` |
| `agent_chat` | 委派给子 agent 做多步分析（需配置 LLM） |
| `agent_status` | 查看当前配置状态 |

### 分析视角（`describe_image` 的 `aspect` 参数）

| aspect | 适用场景 |
|--------|----------|
| `general` | 通用描述（默认） |
| `ui` | UI 截图分析：布局、交互元素、可用性 |
| `chart` | 图表/数据可视化：趋势、数值、对比 |
| `document` | 文档截图：结构化文字提取 |
| `scene` | 照片/场景：人物、环境、氛围 |
| `code` | 代码截图：提取代码 + 解释逻辑 |

---

## 快速启动

```bash
cd demo/vision-demo
npm install

# 启动统一服务（REST + MCP HTTP + 交互式 IO），端口 8791
npm start
# 或
npx tsx src/serve.ts

# 仅 MCP stdio（Hermes Studio / Claude Code spawn 方式）
npm run mcp

# 无交互的 headless 模式
npm run serve:headless
```

### 配置视觉模型

**方式一：环境变量（推荐）**

```bash
VISION_API_KEY=sk-xxx \
VISION_BASE_URL=https://tc-paperhub.diezhi.net/v1 \
VISION_MODEL=doubao-seed-1-6-vision \
npm start
```

也支持 `PAPERHUB_API_KEY` 作为 key 的别名。

**方式二：继承主 agent（hermes config.yaml）**

不配环境变量时，自动读取 hermes 的 `config.yaml`：
- 复用主 agent 的 `api_key`
- 自动把 `/anthropic` 端点转成 `/v1`（同一网关支持两种协议）
- 模型默认用 `doubao-seed-1-6-vision`（不继承主 agent 的文本模型）

**方式三：页面配置**

启动后访问 `http://localhost:8791/config`，在线编辑子 agent 模型配置。

### 思考过程

视觉模型默认开启 reasoning（`reasoning_content`），返回结构包含：
```json
{
  "content": "分析结果...",
  "reasoning": "思考过程...",
  "usage": { ... },
  "mode": "vision+reasoning"
}
```

关闭：`REASONING_ENABLED=0`

---

## HTTP REST API

服务默认跑在 `http://localhost:8791`。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/` 或 `/info` | 服务信息 |
| GET | `/health` | 健康检查 |
| POST | `/analyze` | 分析图片 |
| POST | `/compare` | 对比图片 |
| POST | `/extract` | 提取文字 |
| POST | `/describe` | 描述图片 |
| POST | `/agent` | 委派给 agent |
| GET | `/config` | 配置页（HTML） |
| GET/PUT | `/api/tool-descriptions` | 工具描述管理 |
| GET/PUT/DELETE | `/api/model-config` | 子 agent 模型配置 |

### 示例请求

```bash
# 分析图片（URL）
curl -X POST http://localhost:8791/analyze \
  -H "Content-Type: application/json" \
  -d '{"image":"https://example.com/photo.jpg","question":"图里有几个人？"}'

# 分析图片（本地路径）
curl -X POST http://localhost:8791/analyze \
  -H "Content-Type: application/json" \
  -d '{"image":"D:/screenshots/ui.png","question":"分析这个 UI 的布局"}'

# 提取文字（OCR）
curl -X POST http://localhost:8791/extract \
  -H "Content-Type: application/json" \
  -d '{"image":"D:/docs/receipt.png"}'

# UI 截图分析
curl -X POST http://localhost:8791/describe \
  -H "Content-Type: application/json" \
  -d '{"image":"D:/screenshots/dashboard.png","aspect":"ui"}'

# 对比两张图
curl -X POST http://localhost:8791/compare \
  -H "Content-Type: application/json" \
  -d '{"images":["https://a.com/1.png","https://a.com/2.png"],"question":"哪个设计更好？"}'

# 委派 agent 多步分析
curl -X POST http://localhost:8791/agent \
  -H "Content-Type: application/json" \
  -d '{"message":"分析 D:/screenshots/1.png 和 2.png，总结 UI 改进点"}'
```

---

## MCP 接入

### 方式一：Hermes Studio 页面操作

1. 打开 Hermes Studio（`http://localhost:8649`）
2. 进入 **设置 → MCP 服务器** 面板
3. 点击 **+ 添加服务器**

**stdio 模式（JSON）：**

```json
{
  "vision-demo": {
    "command": "C:\\nvm4w\\nodejs\\node.exe",
    "args": [
      "d:/qaweb/qaweb_tools/tools/hermes-studio/demo/vision-demo/node_modules/tsx/dist/cli.mjs",
      "d:/qaweb/qaweb_tools/tools/hermes-studio/demo/vision-demo/src/mcp.ts"
    ],
    "env": {
      "VISION_API_KEY": "sk-xxx",
      "VISION_BASE_URL": "https://tc-paperhub.diezhi.net/v1",
      "VISION_MODEL": "doubao-seed-1-6-vision"
    }
  }
}
```

**URL 模式（JSON，需先 `npm start`）：**

```json
{
  "vision-demo": {
    "url": "http://localhost:8791/mcp"
  }
}
```

4. 保存 → 点「获取工具列表」验证连通

### 方式二：手动编辑 config.yaml

文件位置：`C:\Users\<用户名>\AppData\Local\hermes\config.yaml`

```yaml
mcp_servers:
  vision-demo:
    command: C:\nvm4w\nodejs\node.exe
    args:
      - d:/qaweb/qaweb_tools/tools/hermes-studio/demo/vision-demo/node_modules/tsx/dist/cli.mjs
      - d:/qaweb/qaweb_tools/tools/hermes-studio/demo/vision-demo/src/mcp.ts
    env:
      VISION_API_KEY: sk-xxx
      VISION_BASE_URL: https://tc-paperhub.diezhi.net/v1
      VISION_MODEL: doubao-seed-1-6-vision
```

> ⚠ stdio 模式必须用**绝对路径**（node.exe + tsx cli + mcp.ts）。

### 方式三：Claude Code

在项目根目录 `.mcp.json` 添加：

```json
{
  "mcpServers": {
    "vision-demo": {
      "command": "node",
      "args": [
        "d:/qaweb/qaweb_tools/tools/hermes-studio/demo/vision-demo/node_modules/tsx/dist/cli.mjs",
        "d:/qaweb/qaweb_tools/tools/hermes-studio/demo/vision-demo/src/mcp.ts"
      ],
      "env": {
        "VISION_API_KEY": "sk-xxx",
        "VISION_BASE_URL": "https://tc-paperhub.diezhi.net/v1",
        "VISION_MODEL": "doubao-seed-1-6-vision"
      }
    }
  }
}
```

### 方式四：其他平台 Agent 远程调用

**远程 hermes 实例（MCP Streamable HTTP）：**

```yaml
mcp_servers:
  vision-demo:
    url: http://10.10.135.197:8791/mcp
```

**Node.js MCP Client：**

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const transport = new StreamableHTTPClientTransport(new URL("http://localhost:8791/mcp"));
const client = new Client({ name: "my-app", version: "1.0.0" });
await client.connect(transport);
const result = await client.callTool({
  name: "analyze_image",
  arguments: { image: "https://example.com/photo.jpg", question: "图里有什么？" },
});
```

### 调试

```bash
# 测试 stdio 连通
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' | npx tsx src/mcp.ts

# 测试 HTTP MCP
curl -X POST http://localhost:8791/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream, application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'
```

---

## 打包

```bash
npm run bundle
```

产出 `vision-demo.zip`（解压即用，只需 Node.js ≥ 18）：
- `vision-demo-serve.js` — 统一服务
- `vision-demo-mcp.js` — MCP stdio 入口
- `start.bat` / `start.sh` — 一键启动

---

## 交互式 IO

服务启动后自动进入交互模式：

```
/analyze <image> [question]   分析图片
/extract <image>              提取文字
/describe <image> [aspect]    描述图片
/compare <img1> <img2> [...]  对比图片
/agent <message>              委派给 agent
/status                       查看配置
/quit                         退出
```

---

## 环境变量

### 视觉模型（核心）

| 变量 | 说明 |
|------|------|
| `VISION_API_KEY` | API key（或 `PAPERHUB_API_KEY`） |
| `VISION_BASE_URL` | OpenAI 兼容 `/v1` 端点 |
| `VISION_MODEL` | 视觉模型名（默认 `doubao-seed-1-6-vision`） |
| `REASONING_ENABLED` | 思考过程开关（默认 `1`） |

### Agent 模型（可选，多步推理用）

| 变量 | 说明 |
|------|------|
| `AGENT_MODEL_KEY` | LLM API key |
| `AGENT_MODEL_BASE` | LLM base URL |
| `AGENT_MODEL_NAME` | LLM 模型名 |

### 服务

| 变量 | 说明 |
|------|------|
| `PORT` | HTTP 端口（默认 `8791`） |
| `HOST` | 监听地址（默认 `0.0.0.0`） |
| `HERMES_PROFILE` | hermes profile 名（默认 `default`） |

---

## 项目结构

```
src/
├── index.ts             # HTTP-only 入口（headless）
├── serve.ts             # 统一服务（REST + MCP HTTP + 交互式 IO）
├── mcp.ts               # MCP stdio 服务器（6 个工具）
├── agent.ts             # AgentRuntime 集成 + LLM/local 模式
├── vision-tool.ts       # 核心视觉分析（流式 + reasoning_content）
├── vision-config.ts     # 视觉 API 配置（env > hermes 继承 > none）
├── model-config.ts      # Agent 模型配置
├── hermes-config.ts     # 读取 hermes config.yaml
├── tool-descriptions.ts # 工具描述注册表
└── config-page.ts       # /config HTML 编辑页
```

---

## 安全提示

图片数据经视觉模型 API 处理。这是一个**测试用**子 agent，默认信任调用方；生产环境请自行加沙箱/白名单/路径校验。
