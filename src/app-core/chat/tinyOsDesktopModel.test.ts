import { describe, expect, it } from "vitest";
import type { ChatStep } from "./chatRunModel";
import { projectTinyOsDesktop, tinyOsAppForStep, type TinyOsTimelineEntry } from "./tinyOsDesktopModel";

function step(id: string, overrides: Partial<ChatStep> = {}): ChatStep {
  return {
    agentContext: { id: "main", title: "Tinybot", type: "main" },
    id,
    kind: "tool_call",
    sequence: 0,
    status: "completed",
    title: id,
    ...overrides,
  };
}

function entry(turnId: string, value: ChatStep): TinyOsTimelineEntry {
  return { step: value, turnId };
}

describe("TinyOS desktop projector", () => {
  it("reuses one window per app and focuses the latest canonical app", () => {
    const snapshot = projectTinyOsDesktop([
      entry("turn-1", step("read-1", { toolCall: { id: "read-1", name: "workspace.read_file" } })),
      entry("turn-1", step("read-2", { toolCall: { id: "read-2", name: "workspace.read_file" } })),
      entry("turn-1", step("shell-1", { status: "running", toolCall: { id: "shell-1", name: "shell.exec" } })),
    ], { mode: "live_follow" });

    expect(snapshot.activeAppId).toBe("terminal");
    expect(snapshot.windows.map((window) => window.appId)).toEqual(["files", "terminal"]);
    expect(snapshot.windows[0].sourceItemIds).toEqual(["read-1", "read-2"]);
    expect(snapshot.operations.map((operation) => operation.title)).toEqual([
      "workspace.read_file",
      "shell.exec",
    ]);
  });

  it("replays history only through the selected canonical identity", () => {
    const entries = [
      entry("turn-1", step("read", { toolCall: { id: "read", name: "workspace.read_file" } })),
      entry("turn-1", step("shell", { toolCall: { id: "shell", name: "shell.exec" } })),
      entry("turn-2", step("plan", { kind: "plan", plan: { completed: 0, steps: [], total: 0 } })),
    ];

    const snapshot = projectTinyOsDesktop(entries, { itemId: "shell", mode: "history", turnId: "turn-1" });

    expect(snapshot.cursorItemId).toBe("shell");
    expect(snapshot.windows.map((window) => window.appId)).toEqual(["files", "terminal"]);
    expect(snapshot.windows.some((window) => window.appId === "plan")).toBe(false);
  });

  it("projects blocking requests as dialogs and failures as notifications", () => {
    const approval = step("approval", {
      approval: { approvalId: "approval-1", actions: ["approveOnce", "deny"] },
      kind: "approval",
      status: "blocked",
      title: "Run tests",
    });
    const failure = step("failure", {
      error: { message: "Tests failed" },
      kind: "error",
      status: "failed",
      title: "Test failure",
    });

    const snapshot = projectTinyOsDesktop([
      entry("turn-1", approval),
      entry("turn-1", failure),
    ], { mode: "live_follow" });

    expect(snapshot.dialog).toMatchObject({ kind: "approval", entry: { step: { id: "approval" } } });
    expect(snapshot.notifications).toEqual([
      expect.objectContaining({ kind: "error", message: "Tests failed" }),
    ]);
  });

  it("routes browser artifacts and ignores conversational rows", () => {
    expect(tinyOsAppForStep(step("reasoning", { kind: "reasoning" }))).toBeUndefined();
    expect(tinyOsAppForStep(step("browser", {
      artifacts: [{ id: "capture", kind: "browser_snapshot", title: "Preview" }],
      kind: "artifact",
    }))).toBe("browser");
    expect(tinyOsAppForStep(step("plan-tool", {
      toolCall: { id: "plan-tool", name: "update_plan" },
    }))).toBe("plan");
    expect(tinyOsAppForStep(step("tool-search", {
      toolCall: { id: "tool-search", name: "tool_search" },
    }))).toBe("inspector");
  });
});
