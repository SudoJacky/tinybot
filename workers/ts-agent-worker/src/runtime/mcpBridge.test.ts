import { describe, expect, test } from "vitest";

import type { JsonObject } from "../protocol/messages";
import { ToolRegistry } from "../tools/toolRegistry";
import { NativeMcpBridge } from "./mcpBridge";

describe("NativeMcpBridge", () => {
  test("discovers native MCP tools and forwards wrapped calls to mcp.call_tool", async () => {
    const requests: Array<{ traceId: string; method: string; params: JsonObject }> = [];
    const registry = new ToolRegistry();
    const bridge = new NativeMcpBridge({
      registry,
      rpcClient: {
        async request(traceId, method, params) {
          requests.push({ traceId, method, params });
          if (method === "mcp.list_tools") {
            return {
              servers: [
                {
                  name: "docs",
                  tools: [
                    {
                      name: "search",
                      description: "Search docs",
                      inputSchema: {
                        type: "object",
                        properties: { query: { type: "string" } },
                        required: ["query"],
                      },
                    },
                  ],
                },
              ],
            };
          }
          if (method === "mcp.call_tool") {
            return { content: "MCP search result", server: "docs", tool: "search" };
          }
          throw new Error(`unexpected method ${method}`);
        },
      },
    });

    await bridge.ensureConnected("trace-list");
    expect(registry.toolNames).toEqual(["mcp_docs_search"]);
    await expect(
      registry.execute("mcp_docs_search", { query: "agent loop" }, {
        runId: "run-1",
        traceId: "trace-call",
        sessionId: "session-1",
      }),
    ).resolves.toMatchObject({ content: "MCP search result" });
    expect(requests).toEqual([
      { traceId: "trace-list", method: "mcp.list_tools", params: {} },
      {
        traceId: "trace-call",
        method: "mcp.call_tool",
        params: {
          session_id: "session-1",
          server: "docs",
          tool: "search",
          arguments: { query: "agent loop" },
        },
      },
    ]);
  });

  test("applies configured MCP allowlists to native discovery results", async () => {
    const registry = new ToolRegistry();
    const bridge = new NativeMcpBridge({
      registry,
      rpcClient: {
        async request(_traceId, method) {
          if (method === "mcp.list_tools") {
            return {
              servers: [
                {
                  name: "docs",
                  tools: [
                    { name: "search", description: "Search docs", inputSchema: { type: "object" } },
                    { name: "delete", description: "Delete docs", inputSchema: { type: "object" } },
                  ],
                },
              ],
            };
          }
          throw new Error(`unexpected method ${method}`);
        },
      },
    });

    const diagnostics = await bridge.ensureConnected("trace-list", {
      tools: {
        mcpServers: {
          docs: {
            command: "native",
            enabledTools: ["search"],
          },
        },
      },
    });

    expect(registry.toolNames).toEqual(["mcp_docs_search"]);
    expect(registry.has("mcp_docs_delete")).toBe(false);
    expect(diagnostics.servers[0]).toMatchObject({
      name: "docs",
      registeredTools: ["mcp_docs_search"],
      skippedTools: ["mcp_docs_delete"],
      unmatchedEnabledTools: [],
    });
  });
});
