// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import type { DesktopCoworkCockpitView } from "../desktopCowork";
import { mountCoworkInspectorIsland } from "./coworkInspectorIsland";

const baseView: DesktopCoworkCockpitView = {
  header: {
    id: "cowork-1",
    title: "Desktop migration",
    goal: "Move Cowork into a desktop cockpit",
    status: "blocked",
    workflow: "Adaptive Starter",
    updatedAt: "2026-06-01T09:00:00Z",
  },
  agents: [
    {
      id: "agent-1",
      label: "Planner",
      roleOrTask: "architect",
      status: "running",
      latestActivity: "Mapping helpers",
      attention: { state: "normal", label: "OK", tone: "normal" },
      meta: "",
      raw: {},
    },
    {
      id: "agent-2",
      label: "Reviewer",
      roleOrTask: "reviewer",
      status: "idle",
      latestActivity: "",
      attention: { state: "normal", label: "OK", tone: "normal" },
      meta: "",
      raw: {},
    },
  ],
  tasks: [],
  mailbox: [],
  threads: [],
  trace: [],
  branches: [
    { branchId: "branch-a", resultId: "result-a", title: "Use helpers", status: "ready", selected: false, meta: "", raw: {} },
    { branchId: "branch-b", resultId: "result-b", title: "Use controllers", status: "ready", selected: false, meta: "", raw: {} },
  ],
  artifacts: [],
  workUnits: [],
  graph: { nodes: [], edges: [], caption: "" },
  observabilityPanels: [],
  inspector: {
    type: "task",
    id: "task-1",
    title: "Map helpers",
    body: "Task detail",
    rows: [
      { label: "Status", value: "failed" },
      { label: "Owner", value: "agent-1" },
    ],
    payloadText: "payload text",
    raw: {},
  },
  taskCenterItems: [],
  raw: {},
};

describe("cowork inspector Vue island", () => {
  test("renders selected task details and dispatches task actions with assigned agent", () => {
    const host = document.createElement("section");
    const events: Array<Record<string, unknown>> = [];

    const mounted = mountCoworkInspectorIsland(host, {
      view: baseView,
      onAction: (event) => events.push(event),
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("cowork-inspector");
    expect(host.className).toContain("desktop-cowork-inspector");
    expect(host.querySelector("h2")?.textContent).toBe("Selected: Map helpers");
    expect(host.textContent).toContain("Task detail");
    expect(host.textContent).toContain("Status: failed");
    expect(host.textContent).toContain("Payload: payload text");

    const agent = host.querySelector<HTMLInputElement>('[data-desktop-cowork-input="assignedAgentId"]');
    expect(agent?.getAttribute("aria-label")).toBe("Assign task to agent");
    if (agent) {
      agent.value = "agent-2";
    }
    host.querySelector<HTMLButtonElement>('[data-desktop-cowork-entity-action="assignTask"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-desktop-cowork-entity-action="retryTask"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-desktop-cowork-entity-action="reviewTask"]')?.click();

    expect(events).toEqual([
      { action: "task", sessionId: "cowork-1", taskId: "task-1", taskAction: "assign", assignedAgentId: "agent-2" },
      { action: "task", sessionId: "cowork-1", taskId: "task-1", taskAction: "retry" },
      { action: "task", sessionId: "cowork-1", taskId: "task-1", taskAction: "review" },
    ]);

    mounted.unmount();
    expect(host.textContent).toBe("");
  });

  test("dispatches work-unit and branch actions from selected entity details", () => {
    const host = document.createElement("section");
    const events: Array<Record<string, unknown>> = [];

    mountCoworkInspectorIsland(host, {
      view: {
        ...baseView,
        inspector: { ...baseView.inspector, type: "workUnit", id: "wu-1", title: "Extract projections", rows: [], payloadText: "" },
      },
      onAction: (event) => events.push(event),
    });

    host.querySelector<HTMLButtonElement>('[data-desktop-cowork-entity-action="retryWorkUnit"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-desktop-cowork-entity-action="skipWorkUnit"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-desktop-cowork-entity-action="cancelWorkUnit"]')?.click();

    mountCoworkInspectorIsland(host, {
      view: {
        ...baseView,
        inspector: { ...baseView.inspector, type: "branch", id: "branch-a", title: "Use helpers", rows: [], payloadText: "" },
      },
      onAction: (event) => events.push(event),
    });

    host.querySelector<HTMLButtonElement>('[data-desktop-cowork-entity-action="selectBranch"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-desktop-cowork-entity-action="deriveBranch"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-desktop-cowork-entity-action="selectBranchResult"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-desktop-cowork-entity-action="mergeBranchResults"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-desktop-cowork-entity-action="selectFinalResult"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-desktop-cowork-entity-action="mergeFinalResult"]')?.click();

    expect(events).toEqual([
      { action: "workUnit", sessionId: "cowork-1", workUnitId: "wu-1", workUnitAction: "retry" },
      { action: "workUnit", sessionId: "cowork-1", workUnitId: "wu-1", workUnitAction: "skip" },
      { action: "workUnit", sessionId: "cowork-1", workUnitId: "wu-1", workUnitAction: "cancel" },
      { action: "selectBranch", sessionId: "cowork-1", branchId: "branch-a" },
      { action: "deriveBranch", sessionId: "cowork-1", sourceBranchId: "branch-a", targetArchitecture: "swarm" },
      { action: "selectBranchResult", sessionId: "cowork-1", branchId: "branch-a", resultId: "result-a" },
      { action: "mergeBranchResults", sessionId: "cowork-1", branchIds: ["branch-a", "branch-b"] },
      { action: "selectFinalResult", sessionId: "cowork-1", branchId: "branch-a", resultId: "result-a" },
      { action: "mergeFinalResult", sessionId: "cowork-1", branchIds: ["branch-a", "branch-b"] },
    ]);
  });

  test("dispatches agent activity action from selected agent details", () => {
    const host = document.createElement("section");
    const events: Array<Record<string, unknown>> = [];

    mountCoworkInspectorIsland(host, {
      view: {
        ...baseView,
        raw: {
          agent_steps: [{
            agent_id: "agent-1",
            tool_observations: [{ id: "toolobs-1", detail_ref: "detail-1" }],
          }],
        },
        inspector: { ...baseView.inspector, type: "agent", id: "agent-1", title: "Planner", rows: [], payloadText: "" },
      },
      onAction: (event) => events.push(event),
    });

    host.querySelector<HTMLButtonElement>('[data-desktop-cowork-entity-action="loadAgentActivity"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-desktop-cowork-entity-action="loadObservation"]')?.click();

    expect(events).toEqual([
      { action: "loadAgentActivity", sessionId: "cowork-1", agentId: "agent-1", limit: 20 },
      { action: "loadObservation", sessionId: "cowork-1", detailRef: "detail-1", requesterAgentId: "agent-1" },
    ]);
  });
});
