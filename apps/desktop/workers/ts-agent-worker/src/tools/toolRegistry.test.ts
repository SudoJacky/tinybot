import { describe, expect, test } from "vitest";

import type { Tool } from "./tool";
import { ToolRegistry } from "./toolRegistry";

function echoTool(overrides: Partial<Tool> = {}): Tool {
  return {
    name: "echo",
    description: "Echo text",
    parameters: {
      type: "object",
      properties: { text: { type: "string" }, count: { type: "integer" } },
      required: ["text"],
    },
    execute: async (args) => ({ content: `echo:${String(args.text)}:${String(args.count)}` }),
    ...overrides,
  };
}

describe("ToolRegistry", () => {
  test("supports register, get, has, and unregister", () => {
    const registry = new ToolRegistry();
    const tool = echoTool();

    registry.register(tool);

    expect(registry.has("echo")).toBe(true);
    expect(registry.get("echo")).toBe(tool);

    registry.unregister("echo");

    expect(registry.has("echo")).toBe(false);
    expect(registry.get("echo")).toBeUndefined();
  });

  test("definitions omit internal tool metadata", () => {
    const registry = new ToolRegistry();
    registry.register(echoTool({
      readOnly: true,
      exclusive: true,
      concurrencySafe: true,
      capabilities: ["fs.workspace.read"],
      requiresApproval: true,
    }));

    expect(registry.definitions()).toEqual([
      {
        name: "echo",
        description: "Echo text",
        parameters: {
          type: "object",
          properties: { text: { type: "string" }, count: { type: "integer" } },
          required: ["text"],
        },
      },
    ]);
  });

  test("filtered returns a registry that shares included tool instances", () => {
    const registry = new ToolRegistry();
    const echo = echoTool();
    const hidden = echoTool({ name: "hidden" });
    registry.register(echo);
    registry.register(hidden);

    const filtered = registry.filtered({ exclude: new Set(["hidden"]) });

    expect(filtered).not.toBe(registry);
    expect(filtered.get("echo")).toBe(echo);
    expect(filtered.has("hidden")).toBe(false);
  });

  test("prepareCall returns a model-visible error for unknown tools", () => {
    const registry = new ToolRegistry();
    registry.register(echoTool());

    expect(registry.prepareCall("missing", { text: "hello" })).toEqual({
      ok: false,
      args: { text: "hello" },
      content: "Error: Tool 'missing' not found. Available: echo",
      error: {
        kind: "unknown_tool",
        message: "Tool 'missing' not found.",
      },
    });
  });

  test("prepareCall casts arguments before validating them", () => {
    const registry = new ToolRegistry();
    const tool = echoTool();
    registry.register(tool);

    expect(registry.prepareCall("echo", { text: 12, count: "3" })).toEqual({
      ok: true,
      tool,
      args: { text: "12", count: 3 },
    });
  });

  test("prepareCall returns validation errors without executing the tool", () => {
    const registry = new ToolRegistry();
    registry.register(echoTool());

    expect(registry.prepareCall("echo", { count: "bad" })).toEqual({
      ok: false,
      tool: registry.get("echo"),
      args: { count: "bad" },
      content: "Error: Invalid parameters for tool 'echo': missing required text; count should be integer",
      error: {
        kind: "invalid_params",
        message: "missing required text; count should be integer",
      },
    });
  });
});
