// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { buildDesktopCoworkCockpitView, buildDesktopCoworkSessionRows } from "../../cowork/desktopCowork";
import type { DesktopCoworkPaneModel } from "../../shell/desktopWorkbenchShell";
import { mountCoworkPaneIsland } from "./coworkPaneIsland";

const session = {
  id: "cowork-1",
  title: "Desktop migration",
  goal: "Move WebUI modules into desktop panes",
  status: "blocked",
  architecture: "adaptive_starter",
  updated_at: "2026-05-31T09:00:00Z",
  agents: [
    {
      id: "agent-1",
      name: "Planner",
      role: "architect",
      status: "running",
      current_task_id: "task-1",
      current_task_title: "Map helpers",
    },
    {
      id: "agent-2",
      role: "reviewer",
      lifecycle_status: "waiting",
      pending_reply_count: 1,
    },
  ],
  tasks: [
    {
      id: "task-1",
      title: "Map helpers",
      status: "in_progress",
      assigned_agent_id: "agent-1",
      description: "Find reusable Cowork projections.",
    },
    {
      id: "task-2",
      title: "Review blocker",
      status: "failed",
      assigned_agent_id: "agent-2",
      result_data: { answer: "Need action routing." },
      confidence: 0.74,
    },
  ],
  mailbox: [{
    id: "mail-1",
    sender_id: "agent-2",
    recipient_ids: ["agent-1"],
    status: "delivered",
    content: "Need endpoint parity.",
    requires_reply: true,
    updated_at: "2026-05-31T09:05:00Z",
  }],
  branch_results: [
    { branch_id: "branch-a", result_id: "result-a", status: "ready", summary: "Use helpers" },
    { branch_id: "branch-b", result_id: "result-b", status: "ready", summary: "Use controllers" },
  ],
  artifact_index: [{
    id: "artifact-1",
    kind: "file",
    path_or_url: "docs/plan.md",
    summary: "Plan",
    source_task_id: "task-1",
    source_agent_id: "agent-1",
    status: "created",
  }],
  completion_decision: {
    blocked: [{ id: "mail-1", request_type: "reply", content: "Need endpoint parity." }],
    next_action: "wait_for_reply",
  },
  graph: {
    nodes: [
      { id: "agent-1", label: "Planner", kind: "agent" },
      { id: "task-1", label: "Map helpers", kind: "task" },
    ],
    edges: [{ id: "edge-1", source: "agent-1", target: "task-1", kind: "owns" }],
  },
  run_metrics: [{ label: "Round efficiency", value: "82%" }],
  outputs: [{ id: "output-1", title: "Draft output", content: "Desktop adaptation notes" }],
  final_draft: "Ship the desktop Cowork cockpit.",
  evaluation_results: [{ id: "eval-1", status: "passed", score: 0.91, summary: "Coverage OK" }],
};

const pane: DesktopCoworkPaneModel = {
  sessionRows: buildDesktopCoworkSessionRows({ items: [session] }),
  cockpitView: buildDesktopCoworkCockpitView(session, { selected: { type: "task", id: "task-2" } }),
  actionStatus: "Blueprint ready",
  summaryText: "Summary loaded",
  blueprintDiagnostics: "Valid blueprint",
};

describe("cowork pane Vue island", () => {
  test("renders an unavailable placeholder while Cowork is under construction", () => {
    const host = document.createElement("section");

    const mounted = mountCoworkPaneIsland(host, {
      pane,
    });

    expect(host.className).toBe("desktop-workbench-section desktop-cowork-cockpit");
    expect(host.getAttribute("data-desktop-vue-island")).toBe("cowork-pane");
    expect(host.getAttribute("data-desktop-module-surface")).toBe("cowork");
    expect(host.getAttribute("aria-label")).toBe("Cowork unavailable");
    expect(host.querySelector(".desktop-cowork-unavailable")).not.toBeNull();
    expect(host.textContent).toContain("Cowork is under construction");
    expect(host.textContent).toContain("This page is temporarily unavailable.");
    expect(host.textContent).toContain("暂不开放");
    expect(host.querySelector(".desktop-cowork-sessions")).toBeNull();
    expect(host.querySelector(".desktop-cowork-actions")).toBeNull();
    expect(host.querySelector(".desktop-cowork-graph")).toBeNull();

    mounted.unmount();
    expect(host.textContent).toBe("");
  });
});
