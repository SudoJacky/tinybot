import { describe, expect, test } from "vitest";

import type { Tool } from "./tool";
import { filterToolsByPolicy, registerToolsByPolicy } from "./toolPolicy";
import { ToolRegistry } from "./toolRegistry";

function tool(name: string, capabilities: string[] = []): Tool {
  return {
    name,
    description: name,
    parameters: { type: "object" },
    capabilities,
    execute: async () => ({ content: name }),
  };
}

describe("toolPolicy", () => {
  test("filters tools whose required capabilities are missing", () => {
    const tools = [
      tool("read_file", ["fs.workspace.read"]),
      tool("write_file", ["fs.workspace.write"]),
      tool("exec", ["shell.execute"]),
      tool("local", []),
    ];

    expect(filterToolsByPolicy(tools, { capabilities: ["fs.workspace.read"] }).map((item) => item.name)).toEqual([
      "read_file",
      "local",
    ]);
  });

  test("keeps form tools only for channels that can render forms", () => {
    const formTool = tool("request_form", ["form.request"]);

    expect(filterToolsByPolicy([formTool], { capabilities: ["form.request"], channel: "agent_ui" })).toEqual([
      formTool,
    ]);
    expect(filterToolsByPolicy([formTool], { capabilities: ["form.request"], channel: "stdio" })).toEqual([]);
  });

  test("filters approval-gated tools when approval capability is missing", () => {
    const writeTool = {
      ...tool("write_file", ["fs.workspace.write"]),
      requiresApproval: true,
    };

    expect(filterToolsByPolicy([writeTool], { capabilities: ["fs.workspace.write"], channel: "agent_ui" })).toEqual([]);
    expect(filterToolsByPolicy([writeTool], {
      capabilities: ["fs.workspace.write", "approval.request"],
      channel: "agent_ui",
    })).toEqual([writeTool]);
  });

  test("keeps approval tools only for channels that can resolve approvals", () => {
    const approvalTool = tool("request_approval", ["approval.request"]);

    expect(filterToolsByPolicy([approvalTool], { capabilities: ["approval.request"], channel: "agent_ui" })).toEqual([
      approvalTool,
    ]);
    expect(filterToolsByPolicy([approvalTool], { capabilities: ["approval.request"], channel: "stdio" })).toEqual([]);
  });

  test("registers only policy-enabled tools", () => {
    const registry = new ToolRegistry();

    registerToolsByPolicy(registry, [tool("read_file", ["fs.workspace.read"]), tool("exec", ["shell.execute"])], {
      capabilities: ["fs.workspace.read"],
    });

    expect(registry.toolNames).toEqual(["read_file"]);
  });
});
