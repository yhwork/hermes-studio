#!/usr/bin/env node
/**
 * MCP Server Demo — a generic MCP server for end-to-end testing of MCP clients.
 *
 * Tools are grouped to exercise the common patterns a real MCP client must handle:
 *
 *   Connection / handshake
 *   - ping            : health check, returns server identity + pong timestamp
 *
 *   Basic tool call (success)
 *   - echo            : string passthrough (simplest call)
 *   - add             : numeric params, returns JSON
 *
 *   Composed / chained tools
 *   - combine         : runs echo + uuid + timestamp in one call, returns merged JSON
 *   - batch           : runs N sub-operations declared by the caller
 *
 *   Data communication / JSON-RPC
 *   - jsonrpc_echo    : reflects the JSON-RPC params envelope back as structured text
 *   - sample_data     : returns canned JSON in various shapes for parsing/render tests
 *
 *   Async / timing
 *   - delay           : resolves after N ms (test async + client timeout handling)
 *
 *   Error paths
 *   - fail            : always returns isError, for negative-path testing
 *
 * Transport: stdio (stdout is reserved for JSON-RPC; logs go to stderr).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const SERVER_NAME = "mcp-server-demo";
const SERVER_VERSION = "1.0.0";

const server = new McpServer({
  name: SERVER_NAME,
  version: SERVER_VERSION,
});

/* ------------------------------------------------------------------ *
 * 1. Connection / handshake
 * ------------------------------------------------------------------ */

server.tool(
  "ping",
  "Health check. Returns server name, version, and a pong timestamp. Use this to verify the client connected to the server successfully.",
  {},
  async () => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          server: SERVER_NAME,
          version: SERVER_VERSION,
          pong: new Date().toISOString(),
        }),
      },
    ],
  })
);

/* ------------------------------------------------------------------ *
 * 2. Basic tool call (success)
 * ------------------------------------------------------------------ */

server.tool(
  "echo",
  "Echo back the provided message exactly as received. The simplest successful tool call — use it to verify the request/response round-trip.",
  {
    message: z.string().describe("The text to echo back."),
  },
  async ({ message }) => ({
    content: [{ type: "text", text: message }],
  })
);

server.tool(
  "add",
  "Add two numbers and return the sum as JSON. Demonstrates numeric parameters and structured output.",
  {
    a: z.number().describe("First addend."),
    b: z.number().describe("Second addend."),
  },
  async ({ a, b }) => ({
    content: [{ type: "text", text: JSON.stringify({ a, b, sum: a + b }) }],
  })
);

/* ------------------------------------------------------------------ *
 * 3. Composed / chained tools
 * ------------------------------------------------------------------ */

server.tool(
  "combine",
  "Run echo + uuid + timestamp in a single tool call and return the merged JSON. Use it to verify a client can handle a tool that composes multiple internal operations.",
  {
    message: z.string().describe("Text passed through the internal echo step."),
  },
  async ({ message }) => {
    const echoed = message;
    const uuid = crypto.randomUUID();
    const now = new Date();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            echoed,
            uuid,
            timestamp: {
              iso: now.toISOString(),
              unixSeconds: Math.floor(now.getTime() / 1000),
            },
          }),
        },
      ],
    };
  }
);

server.tool(
  "batch",
  "Run several sub-operations in one call and return one result block per op. Use it to test a client rendering multiple structured results from a single tool call.",
  {
    ops: z
      .array(
        z.object({
          op: z.enum(["echo", "uuid", "timestamp", "random"]),
          value: z.string().optional().describe("Used by the 'echo' op."),
        })
      )
      .min(1)
      .max(20)
      .describe("List of sub-operations to execute in order."),
  },
  async ({ ops }) => {
    const results = ops.map((item) => {
      switch (item.op) {
        case "echo":
          return { op: "echo", result: item.value ?? "" };
        case "uuid":
          return { op: "uuid", result: crypto.randomUUID() };
        case "timestamp": {
          const now = new Date();
          return {
            op: "timestamp",
            result: {
              iso: now.toISOString(),
              unixSeconds: Math.floor(now.getTime() / 1000),
            },
          };
        }
        case "random":
          return {
            op: "random",
            result: Math.floor(Math.random() * 100),
          };
      }
    });
    return {
      content: [{ type: "text", text: JSON.stringify(results) }],
    };
  }
);

/* ------------------------------------------------------------------ *
 * 4. Data communication / JSON-RPC
 * ------------------------------------------------------------------ */

server.tool(
  "jsonrpc_echo",
  "Reflect the call params back as a JSON envelope: echoes method name, params, and a request id surrogate. Use it to inspect how the client serializes arguments into the JSON-RPC request.",
  {
    method: z.string().describe("A pseudo method name to reflect back."),
    params: z
      .record(z.unknown())
      .default({})
      .describe("Arbitrary JSON object to reflect back verbatim."),
  },
  async ({ method, params }) => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          jsonrpc: "2.0",
          method,
          params,
          echoedAt: new Date().toISOString(),
        }),
      },
    ],
  })
);

server.tool(
  "sample_data",
  "Return sample JSON data of the requested shape, for testing client-side rendering/parsing of structured payloads.",
  {
    shape: z
      .enum(["list", "object", "nested", "large"])
      .describe("Shape of the payload: list | object | nested | large."),
  },
  async ({ shape }) => {
    const payloads: Record<string, unknown> = {
      list: [
        { id: 1, name: "alpha", active: true },
        { id: 2, name: "beta", active: false },
        { id: 3, name: "gamma", active: true },
      ],
      object: {
        id: 1,
        name: "demo",
        tags: ["mcp", "test"],
        meta: { ok: true },
      },
      nested: {
        level: 1,
        child: { level: 2, child: { level: 3, child: null } },
      },
      large: Array.from({ length: 50 }, (_, i) => ({
        id: i,
        name: `item-${i}`,
        active: i % 2 === 0,
      })),
    };
    return {
      content: [{ type: "text", text: JSON.stringify(payloads[shape]) }],
    };
  }
);

/* ------------------------------------------------------------------ *
 * 5. Async / timing
 * ------------------------------------------------------------------ */

server.tool(
  "delay",
  "Resolve after a configurable delay (ms). Use it to test async tool handling and client-side timeout behavior.",
  {
    ms: z
      .number()
      .int()
      .min(0)
      .max(10000)
      .default(500)
      .describe("Milliseconds to wait before resolving (0–10000)."),
  },
  async ({ ms }) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ waitedMs: ms, doneAt: new Date().toISOString() }),
        },
      ],
    };
  }
);

/* ------------------------------------------------------------------ *
 * 6. Error paths
 * ------------------------------------------------------------------ */

server.tool(
  "fail",
  "Always returns an error result (isError: true). Use it for negative-path testing: verify the client surfaces tool errors to the user instead of crashing.",
  {
    reason: z
      .string()
      .default("intentional failure")
      .describe("Message returned in the error block."),
  },
  async ({ reason }) => ({
    content: [{ type: "text", text: `Error: ${reason}` }],
    isError: true,
  })
);

/* ------------------------------------------------------------------ *
 * Start
 * ------------------------------------------------------------------ */

const transport = new StdioServerTransport();
await server.connect(transport);

console.error(`[${SERVER_NAME}] v${SERVER_VERSION} running on stdio`);
