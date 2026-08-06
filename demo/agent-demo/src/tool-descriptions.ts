import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 工具描述注册表 —— 单一事实来源。
 *
 * - `mcp.ts` 启动时读这里，把描述喂给 Hermes 的 LLM 工具表。
 * - `server.ts` 的 `/config` 页面通过 `GET/PUT /api/tool-descriptions` 编辑覆盖项。
 *
 * 覆盖项持久化在源码目录上一层的 `descriptions.json`，键为工具名，值为自定义描述。
 * 未覆盖的工具回退到 `DEFAULT_DESCRIPTIONS`。
 *
 * 路径用 `__dirname`（tsx 按 commonjs tsconfig 编译，CJS 下可用），不依赖 `process.cwd()`
 * —— hermes-agent 网关 spawn stdio MCP 时固定以 hermes-studio 根目录为 CWD，cwd 不可靠。
 */

// CJS (tsx + commonjs tsconfig) 提供 __dirname；ESM 兜底仅作防御。
const HERE = typeof __dirname !== "undefined" ? __dirname : process.cwd();
const OVERRIDES_FILE = join(HERE, "..", "descriptions.json");

/** 内置默认描述（原 mcp.ts 各 server.tool() 第二个参数）。 */
export const DEFAULT_DESCRIPTIONS: Record<string, string> = {
  agent_chat:
    "Delegate a task to an autonomous general-purpose sub-agent. Speciality: multi-step shell commands, file operations, code analysis, and complex reasoning. The agent has its own LLM, plans steps, executes commands/reads/writes files, and returns the final result. Use for tasks that require multiple steps, command execution, or file manipulation.",
  agent_run_command: "Execute a shell command through the sub-agent's reasoning loop. Use for running CLI commands with intelligent error handling and retry.",
  agent_read_file: "Read a file through the sub-agent. Use when you need the agent to read and potentially reason about file contents.",
  agent_write_file: "Write content to a file through the sub-agent. Use when the agent should decide file path or content structure.",
  agent_status: "Get the current general-purpose sub-agent configuration and status.",
};

/** 读取持久化的覆盖项（文件不存在或解析失败时返回 {}）。 */
export function loadOverrides(): Record<string, string> {
  try {
    if (!existsSync(OVERRIDES_FILE)) return {};
    const raw = readFileSync(OVERRIDES_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

/** 合并默认 + 覆盖，返回每个工具的生效描述。 */
export function loadDescriptions(): Record<string, string> {
  return { ...DEFAULT_DESCRIPTIONS, ...loadOverrides() };
}

/**
 * 持久化覆盖项。只写入非空且与默认值不同的条目，保持文件精简；
 * 清空某工具的描述即视为"回到默认"。
 */
export function saveOverrides(map: Record<string, string>): void {
  const compact: Record<string, string> = {};
  for (const [name, desc] of Object.entries(map)) {
    const trimmed = (desc ?? "").trim();
    if (trimmed && trimmed !== DEFAULT_DESCRIPTIONS[name]) {
      compact[name] = trimmed;
    }
  }
  writeFileSync(OVERRIDES_FILE, JSON.stringify(compact, null, 2) + "\n", "utf8");
}

/** 覆盖文件路径，供配置页展示。 */
export const overridesFilePath = OVERRIDES_FILE;
