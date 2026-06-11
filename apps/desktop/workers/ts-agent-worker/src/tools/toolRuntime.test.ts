import { describe, expect, test } from "vitest";

import { ToolRegistry } from "./toolRegistry";
import { ToolRuntime } from "./toolRuntime";
import { ApprovalRuntime } from "../security/approvalRuntime";

const retryHint = "\n\n[Analyze the error above and try a different approach.]";

describe("ToolRuntime", () => {
  test("returns prepared-call errors as tool results with a retry hint", async () => {
    const runtime = new ToolRuntime(new ToolRegistry());

    await expect(runtime.execute("missing", {}, { runId: "run-1" })).resolves.toEqual({
      ok: false,
      content: `Error: Tool 'missing' not found. Available: ${retryHint}`,
      error: {
        kind: "unknown_tool",
        message: "Tool 'missing' not found.",
      },
    });
  });

  test("wraps thrown tool exceptions as model-visible errors", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "fail",
      description: "Fail",
      parameters: { type: "object" },
      execute: async () => {
        throw new Error("boom");
      },
    });
    const runtime = new ToolRuntime(registry);

    await expect(runtime.execute("fail", {}, { runId: "run-1" })).resolves.toEqual({
      ok: false,
      content: `Error executing fail: boom${retryHint}`,
      error: {
        kind: "exception",
        message: "boom",
      },
    });
  });

  test("adds a retry hint to Error-like tool content while preserving metadata", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "guarded",
      description: "Guarded",
      parameters: { type: "object" },
      execute: async () => ({ content: "Error: blocked", metadata: { blocked: true } }),
    });
    const runtime = new ToolRuntime(registry);

    await expect(runtime.execute("guarded", {}, { runId: "run-1" })).resolves.toEqual({
      ok: false,
      content: `Error: blocked${retryHint}`,
      metadata: { blocked: true },
      error: {
        kind: "native_error",
        message: "Error: blocked",
      },
    });
  });

  test("pauses risky tool execution through approval runtime before side effects run", async () => {
    const registry = new ToolRegistry();
    let executed = false;
    registry.register({
      name: "write_file",
      description: "Write file",
      parameters: { type: "object" },
      execute: async () => {
        executed = true;
        return { content: "wrote file" };
      },
    });
    const requests: unknown[] = [];
    const runtime = new ToolRuntime(registry, {
      approvalRuntime: new ApprovalRuntime({
        bridge: {
          requestApproval: async (payload) => {
            requests.push(payload);
            return {
              content: "Waiting for approval.",
              awaitingUserInput: true,
              stopReason: "awaiting_approval",
              approvalId: "approval-1",
              operation: payload.operation,
              fingerprint: payload.fingerprint,
              sessionFingerprint: payload.sessionFingerprint,
            };
          },
        },
      }),
    });

    await expect(
      runtime.execute("write_file", { path: "notes.md", content: "hello" }, {
        runId: "run-1",
        traceId: "trace-1",
        sessionId: "session-1",
      }),
    ).resolves.toEqual({
      ok: true,
      content: "Waiting for approval.",
      metadata: {
        awaitingUserInput: true,
        stopReason: "awaiting_approval",
        approvalId: "approval-1",
        operation: {
          toolName: "write_file",
          arguments: { path: "notes.md", content: "hello" },
        },
        fingerprint: "write_file:notes.md",
        sessionFingerprint: "write_file:notes.md",
      },
    });
    expect(executed).toBe(false);
    expect(requests).toEqual([
      expect.objectContaining({
        runId: "run-1",
        sessionId: "session-1",
        classification: expect.objectContaining({
          category: "filesystem_write",
          risk: "medium",
        }),
        fingerprint: "write_file:notes.md",
        sessionFingerprint: "write_file:notes.md",
      }),
    ]);
  });

  test("allows read-only tools without approval bridge calls", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "read_file",
      description: "Read file",
      parameters: { type: "object" },
      readOnly: true,
      execute: async (args) => ({ content: `read:${String(args.path)}` }),
    });
    let approvalCalls = 0;
    const runtime = new ToolRuntime(registry, {
      approvalRuntime: new ApprovalRuntime({
        bridge: {
          requestApproval: async () => {
            approvalCalls += 1;
            return { content: "unexpected approval" };
          },
        },
      }),
    });

    await expect(runtime.execute("read_file", { path: "README.md" }, { runId: "run-1" })).resolves.toEqual({
      ok: true,
      content: "read:README.md",
    });
    expect(approvalCalls).toBe(0);
  });
});
