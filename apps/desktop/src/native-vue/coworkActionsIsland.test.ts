// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import type { DesktopCoworkCockpitView } from "../desktopCowork";
import { mountCoworkActionsIsland } from "./coworkActionsIsland";

const cockpitView: Pick<DesktopCoworkCockpitView, "header" | "agents"> = {
  header: {
    id: "cowork-1",
    title: "Desktop migration",
    goal: "Move Cowork into a desktop cockpit",
    status: "running",
    workflow: "Adaptive Starter",
    updatedAt: "2026-06-01T09:00:00Z",
  },
  agents: [
    {
      id: "agent-1",
      label: "Planner",
      roleOrTask: "architect",
      status: "running",
      latestActivity: "",
      attention: { state: "normal", label: "OK", tone: "normal" },
      meta: "",
      raw: {},
    },
  ],
};

describe("cowork actions Vue island", () => {
  test("renders controls and forwards session actions from current input values", () => {
    const host = document.createElement("section");
    const events: Array<Record<string, unknown>> = [];

    const mounted = mountCoworkActionsIsland(host, {
      sessionId: "cowork-1",
      agents: cockpitView.agents,
      actionStatus: "Running session",
      summaryText: "Summary text",
      blueprintDiagnostics: "Valid / 1 warning(s)",
      onAction: (event) => events.push(event),
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("cowork-actions");
    expect(host.className).toContain("desktop-cowork-actions");
    expect(host.getAttribute("aria-label")).toBe("Cowork actions");
    expect(host.textContent).toContain("Running session");
    expect(host.textContent).toContain("Summary: Summary text");
    expect(host.textContent).toContain("Blueprint: Valid / 1 warning(s)");
    expect(Array.from(host.querySelectorAll(".desktop-cowork-action")).map((button) => button.getAttribute("data-desktop-cowork-action"))).toEqual([
      "blueprintValidate",
      "blueprintPreview",
      "create",
      "run",
      "pause",
      "resume",
      "emergencyStop",
      "delete",
      "message",
      "summary",
      "blueprint",
      "trace",
      "dag",
      "artifacts",
      "organization",
      "queues",
      "branches",
      "updateBudget",
      "addTask",
    ]);

    const goal = host.querySelector<HTMLTextAreaElement>('[data-desktop-cowork-input="goal"]');
    const message = host.querySelector<HTMLTextAreaElement>('[data-desktop-cowork-input="message"]');
    const blueprint = host.querySelector<HTMLTextAreaElement>('[data-desktop-cowork-input="blueprint"]');
    const budgetMaxRounds = host.querySelector<HTMLInputElement>('[data-desktop-cowork-input="budgetMaxRounds"]');
    const taskTitle = host.querySelector<HTMLInputElement>('[data-desktop-cowork-input="taskTitle"]');
    const assignedAgent = host.querySelector<HTMLInputElement>('[data-desktop-cowork-input="assignedAgentId"]');
    expect(assignedAgent?.getAttribute("aria-label")).toBe("Cowork assigned agent id");
    if (goal) goal.value = "Create a desktop run";
    if (message) message.value = "Continue with next unit";
    if (blueprint) blueprint.value = "{\"agents\":[]}";
    if (budgetMaxRounds) budgetMaxRounds.value = "7";
    if (taskTitle) taskTitle.value = "Write migration notes";
    if (assignedAgent) assignedAgent.value = "agent-1";

    host.querySelector<HTMLButtonElement>('[data-desktop-cowork-action="blueprintValidate"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-desktop-cowork-action="blueprintPreview"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-desktop-cowork-action="create"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-desktop-cowork-action="message"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-desktop-cowork-action="run"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-desktop-cowork-action="blueprint"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-desktop-cowork-action="trace"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-desktop-cowork-action="dag"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-desktop-cowork-action="artifacts"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-desktop-cowork-action="organization"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-desktop-cowork-action="queues"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-desktop-cowork-action="branches"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-desktop-cowork-action="updateBudget"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-desktop-cowork-action="addTask"]')?.click();

    expect(events).toEqual([
      { action: "validateBlueprint", blueprintText: "{\"agents\":[]}", preview: false },
      { action: "validateBlueprint", blueprintText: "{\"agents\":[]}", preview: true },
      { action: "createSession", goal: "Create a desktop run" },
      { action: "sendMessage", sessionId: "cowork-1", message: "Continue with next unit" },
      { action: "runSession", sessionId: "cowork-1" },
      { action: "loadBlueprint", sessionId: "cowork-1" },
      { action: "loadTrace", sessionId: "cowork-1" },
      { action: "loadDag", sessionId: "cowork-1" },
      { action: "loadArtifacts", sessionId: "cowork-1" },
      { action: "loadOrganization", sessionId: "cowork-1" },
      { action: "loadQueues", sessionId: "cowork-1" },
      { action: "loadBranches", sessionId: "cowork-1" },
      { action: "updateBudget", sessionId: "cowork-1", maxRounds: 7 },
      { action: "addTask", sessionId: "cowork-1", taskTitle: "Write migration notes", assignedAgentId: "agent-1" },
    ]);

    mounted.unmount();
    expect(host.textContent).toBe("");
  });

  test("disables session-bound actions when no session is selected", () => {
    const host = document.createElement("section");
    const events: unknown[] = [];

    mountCoworkActionsIsland(host, {
      sessionId: "",
      agents: [],
      onAction: (event) => events.push(event),
    });

    expect(host.querySelector<HTMLButtonElement>('[data-desktop-cowork-action="run"]')?.disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>('[data-desktop-cowork-action="addTask"]')?.disabled).toBe(true);
    host.querySelector<HTMLButtonElement>('[data-desktop-cowork-action="run"]')?.click();

    expect(events).toEqual([]);
  });
});
