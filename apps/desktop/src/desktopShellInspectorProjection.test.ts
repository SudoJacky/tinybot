import { describe, expect, test } from "vitest";
import {
  buildDesktopShellInspectorProjection,
  createDesktopShellEventDispatcher,
} from "./desktopShellInspectorProjection";

describe("desktop shell inspector projection", () => {
  test("projects persistent shell regions with resize and collapse behavior", () => {
    const projection = buildDesktopShellInspectorProjection({
      activeModule: "chat",
      collapsedRegions: new Set(["right-inspector"]),
      regionSizes: { leftSidebar: 280, rightInspector: 360 },
      events: [],
    });

    expect(projection.regions).toEqual([
      { id: "left-sidebar", label: "Workspace navigation", collapsible: true, collapsed: false, sizePx: 280 },
      { id: "main-workbench", label: "Main workbench", collapsible: false, collapsed: false, sizePx: null },
      { id: "right-inspector", label: "Inspector", collapsible: true, collapsed: true, sizePx: 360 },
      { id: "bottom-composer", label: "Composer", collapsible: true, collapsed: false, sizePx: null },
    ]);
  });

  test("projects toolbar entries for workspace, command palette, model, Knowledge, Gateway, tasks, approvals, and settings", () => {
    const projection = buildDesktopShellInspectorProjection({
      activeModule: "knowledge",
      events: [
        { kind: "task", id: "task-1", state: "active" },
        { kind: "approval", id: "approval-1", state: "pending" },
      ],
    });

    expect(projection.toolbar.map((entry) => [entry.id, entry.active, entry.badge])).toEqual([
      ["workspace", false, null],
      ["command-palette", false, null],
      ["model", false, null],
      ["knowledge", true, null],
      ["gateway", false, null],
      ["tasks", false, "1"],
      ["approvals", false, "1"],
      ["settings", false, null],
    ]);
  });

  test("projects shared inspector tabs with page defaults and badges", () => {
    const projection = buildDesktopShellInspectorProjection({
      activeModule: "files",
      events: [
        { kind: "task", id: "task-1", state: "active" },
        { kind: "approval", id: "approval-1", state: "pending" },
        { kind: "diagnostic", id: "diag-1", state: "error" },
      ],
    });

    expect(projection.inspector.defaultTab).toBe("files");
    expect(projection.inspector.tabs).toEqual([
      { id: "activity", label: "Activity", active: false, badge: "1" },
      { id: "approvals", label: "Approvals", active: false, badge: "1" },
      { id: "files", label: "Files", active: true, badge: null },
      { id: "knowledge", label: "Knowledge", active: false, badge: null },
      { id: "diagnostics", label: "Diagnostics", active: false, badge: "1" },
    ]);
  });

  test("centralizes shell-visible event dispatch into task, approval, gateway, and diagnostic buckets", () => {
    const dispatcher = createDesktopShellEventDispatcher();

    dispatcher.dispatch({ type: "task_started", id: "task-1", title: "Index doc" });
    dispatcher.dispatch({ type: "approval_pending", id: "approval-1", title: "Run shell" });
    dispatcher.dispatch({ type: "gateway_status", id: "gateway", title: "Connected" });
    dispatcher.dispatch({ type: "error", id: "diag-1", title: "Socket closed" });

    expect(dispatcher.snapshot()).toEqual([
      { kind: "task", id: "task-1", state: "active", title: "Index doc" },
      { kind: "approval", id: "approval-1", state: "pending", title: "Run shell" },
      { kind: "gateway", id: "gateway", state: "ready", title: "Connected" },
      { kind: "diagnostic", id: "diag-1", state: "error", title: "Socket closed" },
    ]);
  });
});
