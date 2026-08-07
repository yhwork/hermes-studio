# case-demo — 测试用例生成 agent

> 蒸馏自 [aibox](https://gitlab.papegames.com/ai/traceai/aibox) 的 `CaseGenerateAgent`，做成独立可跑的子 agent demo。
> 读需求文档 → 套用游戏测试用例方法论 → 产出层级化 Markdown 用例树 → 导出 `.xmind`。

## 一、原模块蒸馏

### 源头
aibox `src/main/services/agent/agents/CaseGenerateAgent.ts` 是一个基于 LangChain 的多轮 agent，配 8 个 XMind 客户端工具 + P4/飞书/TAPD/知识库/配置表/uasset 等十几个内部工具，跑在一个 Electron 桌面应用里，把用例直接写进页面的 XMind 编辑器。

### 核心原理（不变量）
1. **方法论即 prompt**：把"游戏测试用例方法论"（优秀用例标准 / 通用拆解方法 / 推荐层级 / 风险检查清单 / 全量与冒烟模板 / 自查清单）整段塞进 system message，作为 LLM 的默认设计标准。这是用例质量的真正来源，不是代码逻辑。
2. **层级化输出**：强制 `功能域 → 场景 → 前置条件/状态 → 操作 → 预期结果` 的多级树，叶子节点只承载一个短判断点，禁止"操作：/预期："长叶子。用 Markdown 的 `#` 标题 + `-` 列表表达父子关系，能被 XMind 直接解析。
3. **严守用户意图**：只做用户要求的事，不自动扩展；局部修改用最小范围工具，整树替换仅限空导图或用户明确要求"重绘整图"。
4. **诚实标注缺口**：信息不足的章节标 `【缺口】xxx`，不脑补；需求文档没有的内容只能进缺口总结，不能写进用例。
5. **资料类型优先于扩展名**：先看资料清单里的 `type` 决定工具，不因为 `.xlsx` 就当配置表（Excel 需求仍是需求）。

### 蒸馏后砍掉的部分
- LangChain 多轮 agent loop → 简化为「单次 LLM 调用 + 方法论 prompt」（核心生成路径）+ 可选 ekko-agent 多步模式（`agent_chat`）。
- XMind 客户端工具（replace/insert/update/delete 节点）→ 简化为 `edit_cases`（按指令局部编辑整树）+ `export_xmind`（导出文件）。
- P4 / 飞书 / TAPD / 知识库 / 配置表 / uasset 等内部工具 → 全部移除。
- Electron / Vue / XMind 编辑器耦合 → 纯 Node 服务，HTTP + MCP 双协议。

### 蒸馏后保留的部分
- ✅ 完整的方法论 prompt（[src/prompts.ts](src/prompts.ts)）
- ✅ 需求文档读取（.docx/.xlsx/.txt/.md，自研极简 zip+xml 解析，[src/doc-reader.ts](src/doc-reader.ts)）
- ✅ Markdown 树解析 / 校验 / 序列化（[src/markdown-tree.ts](src/markdown-tree.ts)）
- ✅ .xmind 导出（自研极简 ZIP 写入器，[src/zip.ts](src/zip.ts)）
- ✅ 用例树结构校验（层级深度、叶子长度、反模式检查）
- ✅ LLM 配置三级回退：页面配置 → 环境变量 → 继承 hermes 主 agent config.yaml

## 二、快速开始

```bash
cd demo/case-demo
npm install

# 启动统一服务（HTTP + MCP HTTP + 交互式 CLI）
npx tsx src/serve.ts
# 默认端口 8792，自定义：PORT=9100 npx tsx src/serve.ts

# 或只跑 MCP stdio（接 Hermes / Claude Code）
npx tsx src/mcp.ts

# 或后台无交互
npx tsx src/serve.ts --no-interactive
```

模型配置（三选一，任一即可）：
1. 浏览器打开 `http://localhost:8792/config` 填表
2. 环境变量：`AGENT_MODEL_KEY` / `AGENT_MODEL_BASE` / `AGENT_MODEL_NAME`
3. 不配 → 自动继承 hermes 主 agent 的 `config.yaml`（同一个 key/endpoint）

## 三、7 个 MCP 工具

| 工具 | 用途 |
|---|---|
| `generate_cases` | 从需求文本或文档生成完整用例树（首次生成/整树重生成） |
| `edit_cases` | 按自然语言指令局部编辑现有用例树（补充/优化/删除） |
| `read_requirement` | 读取 `.docx/.xlsx/.txt/.md` 需求文档纯文本 |
| `validate_cases` | 校验用例树结构是否符合方法论（深度/叶子/反模式） |
| `export_xmind` | 导出为 `.xmind` 文件 |
| `agent_chat` | 委派子 agent 多步处理（读文档→生成→校验→修复→导出） |
| `agent_status` | 查看配置与状态 |

## 四、HTTP REST

| 端点 | 方法 | 入参 |
|---|---|---|
| `/generate` | POST | `{ requirement? \| file?, rootTitle?, extraInstructions?, maxChars? }` |
| `/edit` | POST | `{ currentMarkdown, instruction }` |
| `/read` | POST | `{ path, maxChars? }` |
| `/validate` | POST | `{ markdown }` |
| `/export` | POST | `{ markdown, outputPath, rootTitle? }` |
| `/agent` | POST | `{ message, maxSteps? }` |
| `/health` | GET | — |
| `/info` | GET | — |
| `/config` | GET | 工具描述 + 模型配置页 |
| `/mcp` | POST/GET | MCP Streamable HTTP |

## 五、实测示例

```bash
# 读 docx
curl -X POST http://localhost:8792/read \
  -H "Content-Type: application/json" \
  -d '{"path":"D:/tmp/login-requirement.docx"}'

# 生成用例树
curl -X POST http://localhost:8792/generate \
  -H "Content-Type: application/json" \
  -d '{"file":"D:/tmp/login-requirement.docx","rootTitle":"登录功能测试用例"}'

# 校验
curl -X POST http://localhost:8792/validate \
  -H "Content-Type: application/json" \
  -d '{"markdown":"# ...\n## ..."}'

# 导出 .xmind
curl -X POST http://localhost:8792/export \
  -H "Content-Type: application/json" \
  -d '{"markdown":"# ...","outputPath":"D:/tmp/login.xmind"}'
```

实测结果（qwen3.7-max，继承 hermes 配置）：5 段需求 → 71 节点 / 5 层 / 53 叶子的用例树，含 `【缺口】` 标注，reasoning_tokens 1810。

## 六、接 Claude Code

项目根 `.mcp.json`：

```json
{
  "mcpServers": {
    "case-demo": {
      "command": "node",
      "args": ["d:/qaweb/qaweb_tools/tools/hermes-studio/demo/case-demo/node_modules/tsx/dist/cli.mjs",
               "d:/qaweb/qaweb_tools/tools/hermes-studio/demo/case-demo/src/mcp.ts"]
    }
  }
}
```

## 七、打包便携版

```bash
node build.mjs      # 产出 dist/ + case-demo.zip
```

ZIP 包含 `case-demo-serve.js`（单文件 bundled）+ `case-demo-mcp.js` + `start.bat`/`start.sh` + `README.txt`，目标机器只需 Node ≥ 18。

## 八、端口

`8792`（与其它 demo 不冲突：agent-demo=8787, image-gen-demo=8789, news-demo=8790, vision-demo=8791）。
