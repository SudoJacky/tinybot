import { describe, expect, test } from "vitest";

import { classifyToolCall } from "./approvalClassifier";
import type { ApprovalClassification } from "./approvalTypes";

function expectRequiresApproval(
  classification: ApprovalClassification,
  expected: Pick<ApprovalClassification, "action" | "category" | "risk">,
): void {
  expect(classification.action).toBe(expected.action);
  expect(classification.category).toBe(expected.category);
  expect(classification.risk).toBe(expected.risk);
}

describe("approvalClassifier", () => {
  test("allows read-only non-MCP tools", () => {
    expect(classifyToolCall({ toolName: "read_file", args: { path: "README.md" }, readOnly: true })).toEqual({
      action: "allow",
    });
  });

  test("requires approval for risky exec commands", () => {
    expectRequiresApproval(
      classifyToolCall({
        toolName: "exec",
        args: { command: "powershell -Command Remove-Item secret.txt" },
      }),
      { action: "require_approval", category: "shell", risk: "high" },
    );
  });

  test("allows low-risk exec commands without shell control operators", () => {
    expect(classifyToolCall({ toolName: "exec", args: { command: "uv run pytest tests/security -q" } })).toEqual({
      action: "allow",
    });
  });

  test("requires approval for direct Python test commands", () => {
    expectRequiresApproval(
      classifyToolCall({
        toolName: "exec",
        args: { command: "python -m pytest tests/security -q" },
      }),
      { action: "require_approval", category: "shell", risk: "high" },
    );
  });

  test("requires approval when a low-risk exec command contains shell control operators", () => {
    expectRequiresApproval(
      classifyToolCall({
        toolName: "exec",
        args: { command: "uv run pytest tests/security -q; Remove-Item secret.txt" },
      }),
      { action: "require_approval", category: "shell", risk: "high" },
    );
  });

  test("allows request_form without treating form input as approval", () => {
    expect(classifyToolCall({ toolName: "request_form", args: { form: { title: "Travel preferences" } } })).toEqual({
      action: "allow",
    });
  });

  test("requires approval for read-only MCP tools", () => {
    expectRequiresApproval(
      classifyToolCall({ toolName: "mcp_filesystem_read", args: { path: "README.md" }, readOnly: true }),
      { action: "require_approval", category: "mcp", risk: "high" },
    );
  });

  test("requires approval for file writes, persistent data, external messages, and unmarked side-effect tools", () => {
    expectRequiresApproval(
      classifyToolCall({ toolName: "write_file", args: { path: "notes.md", content: "hello" } }),
      { action: "require_approval", category: "filesystem_write", risk: "medium" },
    );
    expectRequiresApproval(
      classifyToolCall({ toolName: "save_experience", args: { text: "remember this" } }),
      { action: "require_approval", category: "persistent_data", risk: "medium" },
    );
    expectRequiresApproval(
      classifyToolCall({ toolName: "message", args: { channel: "sms", content: "hello" } }),
      { action: "require_approval", category: "external_message", risk: "medium" },
    );
    expectRequiresApproval(
      classifyToolCall({ toolName: "custom_tool", args: { value: 1 } }),
      { action: "require_approval", category: "tool", risk: "medium" },
    );
  });
});
