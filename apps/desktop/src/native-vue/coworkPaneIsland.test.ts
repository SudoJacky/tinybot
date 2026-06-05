// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { nextTick } from "vue";
import { buildDesktopCoworkCockpitView, buildDesktopCoworkSessionRows } from "../desktopCowork";
import type { DesktopCoworkActionEvent, DesktopCoworkPaneModel } from "../desktopWorkbenchShell";
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
  test("renders the Cowork cockpit and forwards actions", async () => {
    const host = document.createElement("section");
    const selectedSessions: string[] = [];
    const graphSelections: string[] = [];
    const actions: string[] = [];

    const mounted = mountCoworkPaneIsland(host, {
      pane,
      onCoworkAction: (event: DesktopCoworkActionEvent) => {
        if (event.action === "task") {
          actions.push(`${event.action}:${event.taskAction}:${event.taskId}:${event.assignedAgentId ?? ""}`);
          return;
        }
        actions.push(`${event.action}:${event.sessionId ?? ""}:${event.goal ?? ""}`);
      },
      onGraphSelect: (selection) => graphSelections.push(`${selection.type}:${selection.id}:${selection.label}`),
      onSessionSelect: (row) => selectedSessions.push(row.id),
    });

    expect(host.className).toBe("desktop-workbench-section desktop-cowork-cockpit");
    expect(host.getAttribute("data-desktop-vue-island")).toBe("cowork-pane");
    expect(host.getAttribute("data-desktop-module-surface")).toBe("cowork");
    expect(host.getAttribute("aria-label")).toBe("Cowork cockpit");
    expect(host.textContent).toContain("Cowork");

    expect(host.querySelector('[data-desktop-cowork-session="cowork-1"]')?.textContent).toContain("Desktop migration");
    expect(host.querySelector(".desktop-cowork-header")?.textContent).toContain("Desktop migration");
    expect(host.querySelector(".desktop-cowork-actions")?.textContent).toContain("Blueprint ready");
    expect(host.querySelector('[data-desktop-cowork-entity="task-1"]')?.textContent).toContain("Map helpers");
    expect(host.querySelector(".desktop-cowork-observability")?.textContent).toContain("Observability");
    expect(host.querySelector(".desktop-cowork-inspector")?.textContent).toContain("Selected: Review blocker");
    expect(host.querySelector(".desktop-cowork-task-feed")?.textContent).toContain("agents");

    host.querySelector<HTMLButtonElement>('[data-desktop-cowork-session="cowork-1"]')?.click();
    const goal = host.querySelector<HTMLTextAreaElement>('[data-desktop-cowork-input="goal"]');
    goal!.value = "Create native shell";
    host.querySelector<HTMLButtonElement>('[data-desktop-cowork-action="create"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-desktop-cowork-action="run"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-desktop-cowork-entity="task-1"]')?.click();
    await nextTick();
    const assignee = host.querySelector<HTMLInputElement>('.desktop-cowork-inspector [data-desktop-cowork-input="assignedAgentId"]');
    assignee!.value = "agent-2";
    assignee?.dispatchEvent(new Event("input", { bubbles: true }));
    host.querySelector<HTMLButtonElement>('[data-desktop-cowork-entity-action="assignTask"]')?.click();

    expect(selectedSessions).toEqual(["cowork-1"]);
    expect(graphSelections).toEqual(["task:task-1:Map helpers"]);
    expect(actions).toEqual([
      "createSession::Create native shell",
      "runSession:cowork-1:",
      "task:assign:task-1:agent-2",
    ]);

    mounted.unmount();
    expect(host.textContent).toBe("");
  });
});
