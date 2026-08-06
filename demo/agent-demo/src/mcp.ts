import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadAgentConfig, runAgent } from "./agent.js";
import { loadDescriptions } from "./tool-descriptions.js";

// 工具描述来自 tool-descriptions.ts 注册表（默认值 + descriptions.json 覆盖）。
// 通过 /config 页面编辑、Hermes Studio MCP 面板重载即生效。
const descriptions = loadDescriptions();

/**
 * MCP Server wrapper for agent-demo
 * Exposes the agent's capabilities as MCP tools for Hermes to call
 */

const server = new McpServer({
  name: "agent-demo",
  version: "1.0.0",
});

// Load agent configuration
const agentConfig = loadAgentConfig();

// Tool 1: agent_chat - Send a message to the agent and get a response
server.tool(
  "agent_chat",
  descriptions.agent_chat,
  {
    message: z.string().describe("The message to send to the agent"),
    cwd: z.string().optional().describe("Working directory for command execution"),
    maxSteps: z.number().optional().describe("Maximum reasoning steps (default: 12)"),
  },
  async ({ message, cwd, maxSteps }) => {
    try {
      const result = await runAgent(message, agentConfig, {
        cwd,
        maxSteps,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                response: result.content,
                steps: result.steps,
                toolCalls: result.toolCalls.length,
                mode: result.mode,
                finishedAt: result.finishedAt,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: error instanceof Error ? error.message : String(error),
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }
  }
);

// Tool 2: agent_run_command - Execute a shell command through the agent
server.tool(
  "agent_run_command",
  descriptions.agent_run_command,
  {
    command: z.string().describe("The shell command to execute"),
    cwd: z.string().optional().describe("Working directory"),
  },
  async ({ command, cwd }) => {
    try {
      // Wrap the command in a request format the agent understands
      const message = `Please run this command: \`${command}\``;
      const result = await runAgent(message, agentConfig, {
        cwd,
        maxSteps: 3, // Commands should be quick
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                response: result.content,
                steps: result.steps,
                mode: result.mode,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: error instanceof Error ? error.message : String(error),
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }
  }
);

// Tool 3: agent_read_file - Read a file through the agent
server.tool(
  "agent_read_file",
  descriptions.agent_read_file,
  {
    path: z.string().describe("Path to the file to read"),
    cwd: z.string().optional().describe("Working directory"),
  },
  async ({ path, cwd }) => {
    try {
      const message = `Please read the file: ${path}`;
      const result = await runAgent(message, agentConfig, {
        cwd,
        maxSteps: 2,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                response: result.content,
                steps: result.steps,
                mode: result.mode,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: error instanceof Error ? error.message : String(error),
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }
  }
);

// Tool 4: agent_write_file - Write content to a file through the agent
server.tool(
  "agent_write_file",
  descriptions.agent_write_file,
  {
    path: z.string().describe("Path to the file to write"),
    content: z.string().describe("Content to write to the file"),
    cwd: z.string().optional().describe("Working directory"),
  },
  async ({ path, content, cwd }) => {
    try {
      const message = `Please write the following content to ${path}:\n\n${content}`;
      const result = await runAgent(message, agentConfig, {
        cwd,
        maxSteps: 2,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                response: result.content,
                steps: result.steps,
                mode: result.mode,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: error instanceof Error ? error.message : String(error),
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }
  }
);

// Tool 5: agent_status - Get agent configuration and status
server.tool(
  "agent_status",
  descriptions.agent_status,
  {},
  async () => {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              name: "agent-demo",
              version: "1.0.0",
              mode: agentConfig.mode,
              model: agentConfig.model,
              baseURL: agentConfig.baseURL,
              capabilities: [
                "chat",
                "run_command",
                "read_file",
                "write_file",
              ],
              maxSteps: 12,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[agent-demo-mcp] Server started on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
