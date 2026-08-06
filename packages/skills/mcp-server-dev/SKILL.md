---
name: mcp-server-dev
description: "Create MCP (Model Context Protocol) server plugins from scratch. Generates stdio or HTTP transport servers with tool definitions, input validation, and proper JSON-RPC handling. Supports TypeScript and Python implementations."
version: 1.0.0
author: Ekko
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [mcp, server, plugin, tool, development, scaffold]
prerequisites:
  commands: [node, npm]
---

# MCP Server Development

Use this skill when the user wants to create a new MCP server, MCP plugin, MCP tool, or extend an existing MCP server with new capabilities.

## What is MCP

MCP (Model Context Protocol) is a JSON-RPC 2.0 based protocol for AI agents to discover and invoke external tools. An MCP server exposes tools that agents can call during conversations.

## Transport Types

| Type | Use Case | How It Works |
|------|----------|--------------|
| **stdio** | Local tools, CLI wrappers, file operations | Agent spawns server process, communicates via stdin/stdout |
| **HTTP (Streamable)** | Remote services, shared servers, web APIs | Agent connects via HTTP POST to a URL endpoint |
| **SSE** | Legacy remote servers | Server-Sent Events transport (deprecated in favor of HTTP) |

**Default to stdio** unless the user explicitly needs a remote/shared server.

## Project Structure

```
my-mcp-server/
├── package.json
├── tsconfig.json          # TypeScript only
├── src/
│   └── index.ts           # Entry point
└── README.md
```

## Scaffold: TypeScript stdio Server

### package.json

```json
{
  "name": "mcp-server-<name>",
  "version": "1.0.0",
  "type": "module",
  "bin": {
    "mcp-server-<name>": "./dist/index.js"
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsx src/index.ts",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.0"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "tsx": "^4.19.0",
    "@types/node": "^22.0.0"
  }
}
```

### tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*"]
}
```

### src/index.ts (Minimal)

```typescript
#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "my-server",
  version: "1.0.0",
});

// Define tools
server.tool(
  "tool_name",
  "Description of what this tool does",
  {
    param1: z.string().describe("Description of param1"),
    param2: z.number().optional().describe("Optional numeric param"),
  },
  async ({ param1, param2 }) => {
    // Tool implementation
    const result = `Processed: ${param1}`;
    return {
      content: [{ type: "text", text: result }],
    };
  }
);

// Start server
const transport = new StdioServerTransport();
await server.connect(transport);
```

## Scaffold: Python stdio Server

```python
#!/usr/bin/env python3
"""MCP Server - <description>"""

from mcp.server.fastmcp import FastMCP

mcp = FastMCP("my-server")


@mcp.tool()
def tool_name(param1: str, param2: int = 0) -> str:
    """Description of what this tool does.

    Args:
        param1: Description of param1
        param2: Optional numeric param
    """
    return f"Processed: {param1}"


if __name__ == "__main__":
    mcp.run(transport="stdio")
```

Dependencies: `pip install mcp[cli]`

## Scaffold: HTTP Transport (TypeScript)

```typescript
#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";

const app = express();
app.use(express.json());

const server = new McpServer({
  name: "my-http-server",
  version: "1.0.0",
});

server.tool(
  "tool_name",
  "Description",
  { query: z.string() },
  async ({ query }) => ({
    content: [{ type: "text", text: `Result for: ${query}` }],
  })
);

const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
await server.connect(transport);

app.post("/mcp", async (req, res) => {
  await transport.handleRequest(req, res, req.body);
});

app.listen(3000, () => {
  console.error("MCP HTTP server running on http://localhost:3000/mcp");
});
```

## Tool Definition Rules

1. **Name**: lowercase, snake_case, descriptive (`search_files`, `run_query`, `get_weather`)
2. **Description**: one clear sentence of what the tool does, written for an AI agent
3. **Parameters**: use Zod schemas (TS) or type hints (Python) with descriptions on every field
4. **Return**: always return `{ content: [{ type: "text", text: "..." }] }` for text results
5. **Errors**: throw errors or return `{ content: [...], isError: true }` for failures
6. **Side effects**: document clearly if a tool modifies state (files, databases, APIs)

## Return Types

```typescript
// Text result
return { content: [{ type: "text", text: "result" }] };

// Image result
return { content: [{ type: "image", data: base64String, mimeType: "image/png" }] };

// Error result
return { content: [{ type: "text", text: "Error: ..." }], isError: true };

// Multiple content blocks
return {
  content: [
    { type: "text", text: "Summary: ..." },
    { type: "image", data: chartBase64, mimeType: "image/png" },
  ],
};
```

## Resources (Optional)

Expose read-only data sources the agent can browse:

```typescript
server.resource(
  "config",
  "config://app",
  async (uri) => ({
    contents: [{ uri: uri.href, text: JSON.stringify(config), mimeType: "application/json" }],
  })
);
```

## Prompts (Optional)

Expose reusable prompt templates:

```typescript
server.prompt(
  "summarize",
  { text: z.string() },
  ({ text }) => ({
    messages: [{ role: "user", content: { type: "text", text: `Summarize: ${text}` } }],
  })
);
```

## Registration in Hermes Studio

After building the server, register it in Hermes Studio MCP panel:

**stdio server:**

```json
{
  "my-server": {
    "command": "node",
    "args": ["/absolute/path/to/dist/index.js"],
    "env": {
      "API_KEY": "optional-env-var"
    }
  }
}
```

**HTTP server:**

```json
{
  "my-server": {
    "url": "http://localhost:3000/mcp"
  }
}
```

For development with `tsx` (no build step):

```json
{
  "my-server": {
    "command": "npx",
    "args": ["tsx", "/path/to/src/index.ts"]
  }
}
```

## Workflow

1. Ask the user what tools the MCP server should provide
2. Determine transport type (default: stdio)
3. Determine language (default: TypeScript)
4. Generate the project scaffold with package.json, tsconfig, and entry point
5. Implement each tool with proper parameter validation and error handling
6. Add a README documenting each tool's purpose and parameters
7. Provide the Hermes Studio registration config snippet
8. If the user wants to test, run with `npx tsx src/index.ts` and register in MCP panel

## Best Practices

- Keep each tool focused — one tool, one job
- Validate inputs early, return clear error messages
- Use `console.error()` for debug logs (stdout is reserved for JSON-RPC in stdio mode)
- Set reasonable timeouts for external API calls
- Document required environment variables in README
- Never hardcode secrets — use env vars or config files
- For file operations, always validate paths to prevent directory traversal
- Return structured data (JSON) in text content when the result is complex
- Add `description` to every parameter — agents rely on these to use tools correctly
