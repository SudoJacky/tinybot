import { describe, expect, test } from "vitest";

import { normalizeMcpServersConfig, wrappedMcpToolName } from "./mcpConfig";

describe("normalizeMcpServersConfig", () => {
  test("accepts snake_case and camelCase config while auto-detecting transports", () => {
    const servers = normalizeMcpServersConfig({
      filesystem: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
        env: { ROOT: "." },
        tool_timeout: 15,
        enabled_tools: ["read_file", "mcp_filesystem_list_directory"],
      },
      docs: {
        url: "https://example.test/sse",
        headers: { Authorization: "Bearer token" },
        toolTimeout: 60,
        enabledTools: ["*"],
      },
      "remote.docs": {
        url: "https://example.test/mcp",
      },
    });

    expect(servers.filesystem).toMatchObject({
      name: "filesystem",
      safeName: "filesystem",
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
      env: { ROOT: "." },
      toolTimeout: 15,
      enabledTools: ["read_file", "mcp_filesystem_list_directory"],
    });
    expect(servers.docs).toMatchObject({
      type: "sse",
      url: "https://example.test/sse",
      headers: { Authorization: "Bearer token" },
      toolTimeout: 60,
      enabledTools: ["*"],
    });
    expect(servers["remote.docs"]).toMatchObject({
      safeName: "remote_docs",
      type: "streamableHttp",
      url: "https://example.test/mcp",
      toolTimeout: 30,
      enabledTools: ["*"],
    });
  });

  test("preserves an empty allowlist and rejects incomplete servers", () => {
    expect(normalizeMcpServersConfig({
      disabled: { command: "node", enabled_tools: [] },
    }).disabled.enabledTools).toEqual([]);

    expect(() => normalizeMcpServersConfig({ missing: {} })).toThrow("requires command or url");
    expect(() => normalizeMcpServersConfig({ bad: { type: "stdio", command: "" } })).toThrow("requires command");
    expect(() => normalizeMcpServersConfig({ bad: { type: "streamableHttp", url: "" } })).toThrow("requires url");
    expect(() => normalizeMcpServersConfig({ bad: { command: "node", tool_timeout: 0 } })).toThrow("toolTimeout");
  });
});

describe("wrappedMcpToolName", () => {
  test("uses sanitized server and tool names for model-facing MCP tools", () => {
    expect(wrappedMcpToolName("remote.docs", "read-file")).toBe("mcp_remote_docs_read_file");
  });
});
