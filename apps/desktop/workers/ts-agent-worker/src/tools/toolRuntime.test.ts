import { describe, expect, test } from "vitest";

import { ToolRegistry } from "./toolRegistry";
import { ToolRuntime } from "./toolRuntime";

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
});
