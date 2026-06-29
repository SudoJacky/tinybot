import { describe, expect, test, vi } from "vitest";

import { createMcpToolWrapper, McpToolCallCancelledError } from "./mcpToolWrapper";
import type { McpToolSession } from "./mcpToolWrapper";

function fakeSession(handler: McpToolSession["callTool"]): McpToolSession {
  return { callTool: handler };
}

describe("createMcpToolWrapper", () => {
  test("wraps an MCP tool as a high-risk external TinyBot tool", async () => {
    const session = fakeSession(vi.fn(async () => ({
      content: [
        { type: "text", text: "first line" },
        { type: "image", data: "abc", mimeType: "image/png" },
      ],
    })));

    const tool = createMcpToolWrapper({
      session,
      serverName: "remote.docs",
      rawTool: {
        name: "read-file",
        description: "Read a remote file",
        inputSchema: {
          type: "object",
          properties: { path: { type: ["string", "null"] } },
        },
      },
      toolTimeout: 30,
    });

    expect(tool).toMatchObject({
      name: "mcp_remote_docs_read_file",
      description: "Read a remote file",
      requiresApproval: true,
      approvalCategory: "mcp",
      approvalRisk: "high",
      readOnly: false,
      capabilities: ["mcp"],
    });
    expect(tool.parameters).toEqual({
      type: "object",
      properties: { path: { type: "string", nullable: true } },
      required: [],
    });

    const result = await tool.execute({ path: "README.md" }, { runId: "run-1", traceId: "trace-1" });

    expect(session.callTool).toHaveBeenCalledWith(
      "read-file",
      { path: "README.md" },
      { runId: "run-1", traceId: "trace-1" },
    );
    expect(result.content).toContain("first line");
    expect(result.content).toContain("[MCP content:image]");
    expect(result.metadata).toMatchObject({
      source: "mcp",
      serverName: "remote.docs",
      rawToolName: "read-file",
    });
  });

  test("uses the raw tool name as fallback description and returns no-output text", async () => {
    const tool = createMcpToolWrapper({
      session: fakeSession(async () => ({ content: [] })),
      serverName: "local",
      rawTool: { name: "echo", inputSchema: null },
      toolTimeout: 5,
    });

    expect(tool.description).toBe("echo");
    await expect(tool.execute({}, { runId: "run-1" })).resolves.toMatchObject({
      content: "(no output)",
    });
  });

  test("formats timeout, cancellation, and failure as model-visible text", async () => {
    const timeoutTool = createMcpToolWrapper({
      session: fakeSession(() => new Promise(() => undefined)),
      serverName: "slow",
      rawTool: { name: "wait" },
      toolTimeout: 0.01,
    });
    await expect(timeoutTool.execute({}, { runId: "run-1" })).resolves.toMatchObject({
      content: "(MCP tool call timed out after 0.01s)",
    });

    const cancelledTool = createMcpToolWrapper({
      session: fakeSession(async () => {
        throw new McpToolCallCancelledError();
      }),
      serverName: "cancel",
      rawTool: { name: "stop" },
      toolTimeout: 5,
    });
    await expect(cancelledTool.execute({}, { runId: "run-1" })).resolves.toMatchObject({
      content: "(MCP tool call was cancelled)",
    });

    const failedTool = createMcpToolWrapper({
      session: fakeSession(async () => {
        throw new TypeError("boom");
      }),
      serverName: "bad",
      rawTool: { name: "explode" },
      toolTimeout: 5,
    });
    await expect(failedTool.execute({}, { runId: "run-1" })).resolves.toMatchObject({
      content: "(MCP tool call failed: TypeError)",
    });
  });
});
