import { describe, expect, it } from "vitest";
import type { BackendAgentTurnItem, ChatStep } from "./chatTurnModel";
import { filterTinyOsDesktopByAgent, projectKernelBackedTinyOsDesktop, projectTinyOsDesktop, tinyOsAppForStep, type TinyOsTimelineEntry } from "./tinyOsDesktopModel";
import type { TinyOsKernelSnapshot } from "./tinyOsKernelModel";

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

  it("attaches a kernel snapshot without changing the compatibility desktop", () => {
    const entries = [entry("turn-1", step("read-1", { toolCall: { id: "call-1", name: "workspace.read_file" } }))];
    const canonicalItems: BackendAgentTurnItem[] = [{
      schemaVersion: "tinybot.turn_item.v2",
      createdAt: "2026-07-14T00:00:00Z",
      data: {
        args: {},
        name: "workspace.read_file",
        result: null,
        status: "running",
        timing: {},
        toolCallId: "call-1",
        type: "tool_call",
      },
      itemId: "read-1",
      kind: "tool_call",
      revision: 1,
      sequence: 1,
      sessionId: "session-1",
      status: "running",
      turnId: "turn-1",
    }];
    const legacy = projectTinyOsDesktop(entries, { mode: "live_follow" });
    const backed = projectKernelBackedTinyOsDesktop(entries, canonicalItems, { mode: "live_follow" });

    expect({ ...backed, kernel: undefined }).toEqual({ ...legacy, kernel: undefined });
    expect(backed.kernel).toMatchObject({
      cursor: { eventCount: 1, eventIndex: 0, mode: "live" },
      processes: expect.arrayContaining([expect.objectContaining({ kind: "tool_operation", state: "running" })]),
      truth: "derived",
    });
  });

  it("scopes windows, processes, resources, notifications, and operations by canonical Agent ownership", () => {
    const mainEntry = entry("turn-1", step("main-read", {
      agentContext: { id: "main", title: "Tinybot", type: "main" },
      toolCall: { id: "main-read", name: "workspace.read_file" },
    }));
    const childEntry = entry("turn-1", step("child-shell", {
      agentContext: { id: "main", title: "Tinybot", type: "main" },
      status: "failed",
      toolCall: { id: "child-shell", name: "shell.exec" },
    }));
    const desktop = projectTinyOsDesktop([mainEntry, childEntry], { mode: "live_follow" });
    const provenance = { kind: "canonical_event" as const, sourceId: "source" };
    const kernel: TinyOsKernelSnapshot = {
      agentGroups: [{ agentId: "agent-main", id: "group-main", processIds: ["process-main"], provenance, state: "completed", title: "Main" }, {
        agentId: "agent-child", id: "group-child", parentAgentId: "agent-main", processIds: ["process-child"], provenance, state: "failed", title: "Child" },
      ],
      browserSessions: [],
      capabilities: [],
      cursor: { eventCount: 2, eventIndex: 1, mode: "live" },
      discrepancies: [],
      metrics: [],
      notifications: [{ id: "main-note", kind: "info", message: "main", processId: "process-main", provenance, title: "Main" }, {
        id: "child-note", kind: "error", message: "child", processId: "process-child", provenance, resourceId: "resource-child", title: "Child" },
      ],
      processes: [{ correlation: { itemId: "main-read", sessionId: "session-1", turnId: "turn-1" }, id: "process-main", kind: "tool_operation", ownerAgentId: "agent-main", provenance, state: "completed", title: "Main read" }, {
        applicationId: "terminal", correlation: { itemId: "child-shell", sessionId: "session-1", turnId: "turn-1" }, id: "process-child", kind: "tool_operation", ownerAgentId: "agent-child", provenance, state: "failed", title: "Child shell" },
      ],
      resources: [{ access: "read_only", id: "resource-main", kind: "file", provenance, relatedProcessIds: ["process-main"], title: "Main file" }, {
        access: "execute", id: "resource-child", kind: "terminal_execution", provenance, relatedProcessIds: ["process-child"], title: "Child terminal" },
      ],
      truth: "derived",
    };

    const scoped = filterTinyOsDesktopByAgent({ ...desktop, kernel }, "agent-child");

    expect(scoped.windows).toEqual([
      expect.objectContaining({ appId: "terminal", sourceItemIds: ["child-shell"] }),
    ]);
    expect(scoped.operations.map(({ entry }) => entry.step.id)).toEqual(["child-shell"]);
    expect(scoped.notifications.map(({ entry }) => entry.step.id)).toEqual(["child-shell"]);
    expect(scoped.kernel).toMatchObject({
      agentGroups: [{ agentId: "agent-child" }],
      notifications: [{ id: "child-note" }],
      processes: [{ id: "process-child" }],
      resources: [{ id: "resource-child" }],
    });
  });
});
