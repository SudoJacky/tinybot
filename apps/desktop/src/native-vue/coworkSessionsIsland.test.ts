// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import type { DesktopCoworkSessionRow } from "../desktopCowork";
import { mountCoworkSessionsIsland } from "./coworkSessionsIsland";

const sessionRows: DesktopCoworkSessionRow[] = [
  {
    id: "cowork-1",
    title: "Desktop migration",
    goal: "Move Cowork into a desktop cockpit",
    status: "blocked",
    workflow: "Adaptive Starter",
    agentCount: 2,
    activeAgentCount: 1,
    taskProgress: { total: 3, completed: 1, failed: 1, blocked: 1 },
    attention: {
      total: 2,
      blockers: 1,
      pendingReplies: 1,
      taskIssues: 0,
      workUnitIssues: 0,
      agentIssues: 0,
      approvals: 0,
      interventions: 0,
      tone: "attention",
      label: "Needs attention",
    },
    finalOutput: "",
    updatedAt: "2026-06-01T09:00:00Z",
    meta: "blocked / Adaptive Starter / 2 agents / 1/3 tasks",
    raw: { id: "cowork-1" },
  },
];

describe("cowork sessions Vue island", () => {
  test("renders session rows with desktop entity hooks and forwards selection", () => {
    const host = document.createElement("section");
    const selected: string[] = [];

    const mounted = mountCoworkSessionsIsland(host, {
      sessions: sessionRows,
      onSelect: (session) => selected.push(session.id),
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("cowork-sessions");
    expect(host.className).toContain("desktop-cowork-sessions");
    expect(host.querySelector("h2")?.textContent).toBe("Sessions");
    const row = host.querySelector<HTMLButtonElement>('[data-desktop-cowork-session="cowork-1"]');
    expect(row?.className).toContain("desktop-cowork-session-row");
    expect(row?.getAttribute("data-desktop-entity-module")).toBe("cowork");
    expect(row?.getAttribute("data-desktop-entity-id")).toBe("cowork-1");
    expect(row?.textContent).toContain("Desktop migration: blocked / Adaptive Starter / 2 agents / 1/3 tasks");
    expect(row?.textContent).toContain("Needs attention");

    row?.click();

    expect(selected).toEqual(["cowork-1"]);

    mounted.unmount();
    expect(host.textContent).toBe("");
  });

  test("renders the existing empty sessions copy", () => {
    const host = document.createElement("section");

    const mounted = mountCoworkSessionsIsland(host, { sessions: [] });

    expect(host.textContent).toContain("No Cowork sessions loaded.");

    mounted.unmount();
  });
});
