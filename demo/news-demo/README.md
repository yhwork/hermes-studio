# news-demo

新闻热点 sub-agent —— 获取各平台热搜/热榜，支持关键词搜索、内容摘要、AI 分析。

基于 Hermes 同款引擎（ekko-agent AgentRuntime），提供三种接入方式：
- **MCP stdio**：Hermes Studio 本地注册
- **MCP Streamable HTTP**：远程 MCP 客户端
- **HTTP REST**：其他平台 agent 调用

## 支持平台

| 平台 | ID | API 来源 |
|------|----|----------|
| 微博热搜 | `weibo` | weibo.com/ajax/side/hotSearch |
| 知乎热榜 | `zhihu` | zhihu.com API v3 |
| 百度热搜 | `baidu` | top.baidu.com board |
| 抖音热点 | `douyin` | douyin.com hot search list |
| 36氪快讯 | `36kr` | 36kr.com newsflash API |

## 快速启动

```bash
# 安装依赖（第一次）
npm install

# 启动统一服务（REST + MCP HTTP + 交互式 IO），端口 8790
npm start
# 或
npx tsx src/serve.ts

# 仅 MCP stdio（Hermes Studio spawn 方式）
npm run mcp
# 或
npx tsx src/mcp.ts

# 仅 REST HTTP，不启动交互式 IO
npx tsx src/serve.ts --no-interactive
```

## MCP 工具

### hot_news
获取热搜/热榜。

```json
{
  "platform": "weibo",   // 可选：weibo/zhihu/baidu/douyin/36kr/all（默认 all）
  "count": 20            // 可选：每平台条目数，默认 20
}
```

### news_search
按关键词搜索最新新闻（百度新闻 RSS）。

```json
{
  "keyword": "人工智能",  // 必填
  "count": 10            // 可选，默认 10
}
```

### news_summary
对指定新闻生成摘要（抓取正文）。

```json
{
  "url": "https://example.com/news/...",  // URL 优先
  "title": "新闻标题",                    // 或者提供 title+content
  "content": "新闻正文..."
}
```

### agent_chat
委派给子 agent 做 AI 分析（需配置 LLM）。

```json
{
  "message": "总结今天微博热搜的主要话题",
  "maxSteps": 12
}
```

### agent_status
查看当前配置状态。

## HTTP REST API

服务默认跑在 `http://localhost:8790`。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/` 或 `/info` | 服务信息 |
| GET | `/health` | 健康检查 |
| POST | `/hot` | 获取热榜 |
| POST | `/search` | 搜索新闻 |
| POST | `/summary` | 生成摘要 |
| POST | `/agent` | 委派给 agent |
| GET | `/config` | 配置页（HTML） |
| GET/PUT | `/api/tool-descriptions` | 工具描述管理 |
| GET/PUT/DELETE | `/api/model-config` | 子 agent 模型配置 |

### 示例请求

```bash
# 获取微博热搜 Top 10
curl -X POST http://localhost:8790/hot \
  -H "Content-Type: application/json" \
  -d '{"platform":"weibo","count":10}'

# 搜索"AI芯片"相关新闻
curl -X POST http://localhost:8790/search \
  -H "Content-Type: application/json" \
  -d '{"keyword":"AI芯片","count":5}'

# 委派 agent 分析
curl -X POST http://localhost:8790/agent \
  -H "Content-Type: application/json" \
  -d '{"message":"分析今天的科技热点趋势"}'
```

## 模型配置

子 agent 模型优先级（从高到低）：

1. **页面配置**：访问 `http://localhost:8790/config` 在线设置
2. **环境变量**：`AGENT_MODEL_KEY` / `AGENT_MODEL_BASE` / `AGENT_MODEL_NAME`
3. **继承主 agent**：自动读取 Hermes `config.yaml`（默认）
4. **local 兜底**：无 LLM，直接调用新闻工具

```bash
# 通过环境变量配置
AGENT_MODEL_KEY=sk-xxx \
AGENT_MODEL_BASE=https://api.openai.com/v1 \
AGENT_MODEL_NAME=gpt-4o-mini \
npx tsx src/serve.ts
```

## MCP 接入

### 方式一：页面操作

1. 打开 Hermes Studio（`http://localhost:8649`）
2. 进入 **设置 → MCP 服务器** 面板
3. 点击 **+ 添加服务器**
4. 选择 JSON 或 YAML 格式输入配置

**stdio 模式（JSON）：**

```json
{
  "news-demo": {
    "command": "C:\\nvm4w\\nodejs\\node.exe",
    "args": [
      "d:/qaweb/qaweb_tools/tools/hermes-studio/demo/news-demo/node_modules/tsx/dist/cli.mjs",
      "d:/qaweb/qaweb_tools/tools/hermes-studio/demo/news-demo/src/mcp.ts"
    ]
  }
}
```

**URL 模式（JSON，需先 `npm start`）：**

```json
{
  "news-demo": {
    "url": "http://localhost:8790/mcp"
  }
}
```

**YAML 格式同样支持：**

```yaml
news-demo:
  command: C:\nvm4w\nodejs\node.exe
  args:
    - d:/qaweb/qaweb_tools/tools/hermes-studio/demo/news-demo/node_modules/tsx/dist/cli.mjs
    - d:/qaweb/qaweb_tools/tools/hermes-studio/demo/news-demo/src/mcp.ts
```

5. 保存 → 点「获取工具列表」验证连通

### 方式二：手动编辑 config.yaml

文件位置：`C:\Users\<用户名>\AppData\Local\hermes\config.yaml`

**stdio 模式：**

```yaml
mcp_servers:
  news-demo:
    command: C:\nvm4w\nodejs\node.exe
    args:
      - d:/qaweb/qaweb_tools/tools/hermes-studio/demo/news-demo/node_modules/tsx/dist/cli.mjs
      - d:/qaweb/qaweb_tools/tools/hermes-studio/demo/news-demo/src/mcp.ts
```

**URL 模式：**

```yaml
mcp_servers:
  news-demo:
    url: http://localhost:8790/mcp
```

> ⚠ stdio 模式必须用**绝对路径**（node.exe + tsx cli + mcp.ts）。hermes-agent 网关 spawn 时固定以 hermes-studio 根为 CWD，bare specifier 会失败。

### 方式三：其他平台 Agent 远程调用

**HTTP REST（任意语言）：**

```bash
# 获取微博热搜
curl -X POST http://<host>:8790/hot -H "Content-Type: application/json" \
  -d '{"platform":"weibo","count":10}'

# 搜索新闻
curl -X POST http://<host>:8790/search -H "Content-Type: application/json" \
  -d '{"keyword":"AI芯片"}'
```

**Python：**

```python
import requests
resp = requests.post("http://localhost:8790/hot", json={"platform": "all"})
print(resp.json())
```

**远程 hermes 实例（MCP Streamable HTTP）：**

```yaml
mcp_servers:
  news-demo:
    url: http://10.10.135.197:8790/mcp
```

**Node.js MCP Client：**

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const transport = new StreamableHTTPClientTransport(new URL("http://localhost:8790/mcp"));
const client = new Client({ name: "my-app", version: "1.0.0" });
await client.connect(transport);
const result = await client.callTool({ name: "hot_news", arguments: { platform: "weibo" } });
```

### 调试

```bash
# 测试 stdio 连通
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' | npx tsx src/mcp.ts

# 测试 HTTP MCP
curl -X POST http://localhost:8790/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream, application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'
```

## 交互式 IO

服务启动后自动进入交互模式：

```
输入关键词搜索新闻，或使用命令：
  /hot [platform]    获取热榜
  /status            查看配置
  /agent <message>   委派给 agent
  /quit              退出
```

示例：
```
> 人工智能
搜索"人工智能"...
"人工智能" 结果 (10 条):
  1. ...

> /hot weibo
正在获取 weibo 热榜...

> /agent 总结今日科技热点
agent 处理中...
```
