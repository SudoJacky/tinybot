import { describe, expect, test, vi } from "vitest";

import { normalizeMcpServersConfig } from "./mcpConfig";
import { McpRuntimeManager } from "./mcpRuntimeManager";
import type { McpClientConnector } from "./mcpRuntimeManager";
import type { McpToolSession } from "./mcpToolWrapper";
import { ToolRegistry } from "../tools/toolRegistry";

function sessionReturning(content: string): McpToolSession {
  return {
    callTool: vi.fn(async () => ({ content: [{ type: "text", text: content }] })),
  };
}

describe("McpRuntimeManager", () => {
  test("registers allowed MCP tools and executes through the wrapped raw tool", async () => {
    const registry = new ToolRegistry();
    const session = sessionReturning("pong");
    const connector: McpClientConnector = {
      connect: vi.fn(async () => ({
        session,
        tools: [
          {
            name: "echo",
            description: "Echo text",
            inputSchema: { type: "object", properties: { text: { type: "string" } } },
          },
          { name: "skip_me", description: "Skipped", inputSchema: { type: "object" } },
        ],
        close: vi.fn(async () => undefined),
      })),
    };
    const manager = new McpRuntimeManager({ registry, connector });

    const result = await manager.connectAll(normalizeMcpServersConfig({
      fake: { command: "node", enabled_tools: ["echo"] },
    }));

    expect(connector.connect).toHaveBeenCalledWith(expect.objectContaining({ name: "fake", type: "stdio" }));
    expect(result.servers[0]).toMatchObject({
      name: "fake",
      transport: "stdio",
      status: "connected",
      registeredTools: ["mcp_fake_echo"],
      skippedTools: ["mcp_fake_skip_me"],
      unmatchedEnabledTools: [],
    });
    expect(registry.toolNames).toContain("mcp_fake_echo");
    expect(registry.toolNames).not.toContain("mcp_fake_skip_me");

    await expect(registry.execute("mcp_fake_echo", { text: "hi" }, { runId: "run-1" })).resolves.toMatchObject({
      content: "pong",
    });
    expect(session.callTool).toHaveBeenCalledWith("echo", { text: "hi" });
  });

  test("matches wrapped allowlist names and reports unmatched entries", async () => {
    const registry = new ToolRegistry();
    const manager = new McpRuntimeManager({
      registry,
      connector: {
        connect: async () => ({
          session: sessionReturning("result"),
          tools: [{ name: "search", inputSchema: { type: "object" } }],
          close: async () => undefined,
        }),
      },
    });

    const result = await manager.connectAll(normalizeMcpServersConfig({
      docs: { command: "node", enabledTools: ["mcp_docs_search", "missing"] },
    }));

    expect(result.servers[0]).toMatchObject({
      registeredTools: ["mcp_docs_search"],
      unmatchedEnabledTools: ["missing"],
    });
    expect(registry.has("mcp_docs_search")).toBe(true);
  });

  test("does not register disabled tool lists and isolates failed servers", async () => {
    const registry = new ToolRegistry();
    const manager = new McpRuntimeManager({
      registry,
      connector: {
        connect: async (server) => {
          if (server.name === "bad") {
            throw new Error("connection refused");
          }
          return {
            session: sessionReturning("ok"),
            tools: [{ name: "ok", inputSchema: { type: "object" } }],
            close: async () => undefined,
          };
        },
      },
    });

    const result = await manager.connectAll(normalizeMcpServersConfig({
      disabled: { command: "node", enabled_tools: [] },
      good: { command: "node" },
      bad: { command: "node" },
    }));

    expect(result.servers).toEqual([
      expect.objectContaining({ name: "disabled", status: "connected", registeredTools: [] }),
      expect.objectContaining({ name: "good", status: "connected", registeredTools: ["mcp_good_ok"] }),
      expect.objectContaining({ name: "bad", status: "failed", error: "connection refused" }),
    ]);
    expect(registry.toolNames).toEqual(["mcp_good_ok"]);
  });

  test("reports wrapped-name collisions without overwriting the existing MCP tool", async () => {
    const registry = new ToolRegistry();
    const manager = new McpRuntimeManager({
      registry,
      connector: {
        connect: async (server) => ({
          session: sessionReturning(server.name),
          tools: [{ name: "echo", inputSchema: { type: "object" } }],
          close: async () => undefined,
        }),
      },
    });

    const result = await manager.connectAll(normalizeMcpServersConfig({
      "foo-bar": { command: "node" },
      foo_bar: { command: "node" },
    }));

    expect(result.servers[0]).toMatchObject({
      name: "foo-bar",
      registeredTools: ["mcp_foo_bar_echo"],
      collisionTools: [],
    });
    expect(result.servers[1]).toMatchObject({
      name: "foo_bar",
      registeredTools: [],
      collisionTools: ["mcp_foo_bar_echo"],
    });
    expect(registry.toolNames).toEqual(["mcp_foo_bar_echo"]);
    await expect(registry.execute("mcp_foo_bar_echo", {}, { runId: "run-1" })).resolves.toMatchObject({
      content: "foo-bar",
    });
  });

  test("reconnect replaces previous MCP registrations while preserving non-MCP tools", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "read_file",
      description: "Read",
      parameters: { type: "object" },
      readOnly: true,
      async execute() {
        return { content: "file" };
      },
    });
    let connectCount = 0;
    const manager = new McpRuntimeManager({
      registry,
      connector: {
        connect: async () => {
          connectCount += 1;
          return {
            session: sessionReturning(`v${connectCount}`),
            tools: [{ name: `tool_${connectCount}`, inputSchema: { type: "object" } }],
            close: async () => undefined,
          };
        },
      },
    });

    await manager.connectAll(normalizeMcpServersConfig({ first: { command: "node" } }));
    await manager.connectAll(normalizeMcpServersConfig({ second: { command: "node" } }));

    expect(registry.toolNames).toEqual(["read_file", "mcp_second_tool_2"]);
    expect(registry.has("mcp_first_tool_1")).toBe(false);
    await expect(registry.execute("mcp_second_tool_2", {}, { runId: "run-1" })).resolves.toMatchObject({
      content: "v2",
    });
  });

  test("close unregisters MCP tools and closes connected sessions", async () => {
    const registry = new ToolRegistry();
    const close = vi.fn(async () => undefined);
    registry.register({
      name: "read_file",
      description: "Read",
      parameters: { type: "object" },
      readOnly: true,
      async execute() {
        return { content: "file" };
      },
    });
    const manager = new McpRuntimeManager({
      registry,
      connector: {
        connect: async () => ({
          session: sessionReturning("ok"),
          tools: [{ name: "ok", inputSchema: { type: "object" } }],
          close,
        }),
      },
    });
    await manager.connectAll(normalizeMcpServersConfig({ good: { command: "node" } }));

    await manager.close();

    expect(close).toHaveBeenCalledOnce();
    expect(registry.toolNames).toEqual(["read_file"]);
  });
});
