// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { nextTick } from "vue";
import type { DesktopCoworkGraphView, DesktopCoworkSelectionType } from "../desktopCowork";
import { mountCoworkGraphIsland } from "./coworkGraphIsland";

const graph: DesktopCoworkGraphView = {
  caption: "60 nodes / 40 edges",
  nodes: Array.from({ length: 30 }, (_, index) => ({
    id: index === 0 ? "agent-1" : `task-${index + 1}`,
    label: index === 0 ? "Planner" : `Task ${index + 1}`,
    kind: index === 0 ? "agent" : "task",
    status: index === 0 ? "running" : "ready",
    raw: {},
  })),
  edges: Array.from({ length: 15 }, (_, index) => ({
    id: `edge-${index + 1}`,
    source: "agent-1",
    target: `task-${index + 1}`,
    label: index === 0 ? "owns" : "",
    raw: {},
  })),
};

describe("cowork graph Vue island", () => {
  test("renders bounded graph nodes and edges and forwards selected entities", async () => {
    const host = document.createElement("section");
    const selections: Array<{ type: DesktopCoworkSelectionType; id: string; label: string }> = [];

    const mounted = mountCoworkGraphIsland(host, {
      graph,
      onSelect: (selection) => selections.push(selection),
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("cowork-graph");
    expect(host.className).toContain("desktop-cowork-graph");
    expect(host.querySelector("h2")?.textContent).toBe("Graph");
    expect(host.textContent).toContain("60 nodes / 40 edges");
    expect(host.querySelectorAll(".desktop-cowork-graph-node")).toHaveLength(24);
    expect(host.querySelector(".desktop-cowork-graph")?.textContent ?? host.textContent).not.toContain("Task 25");
    expect(host.textContent).toContain("Showing 24 of 30 nodes");
    expect(host.textContent).toContain("Showing 12 of 15 edges");
    expect(host.textContent).toContain("agent-1 -> task-1 / owns");

    const planner = host.querySelector<HTMLButtonElement>('[data-desktop-cowork-entity="agent-1"]');
    expect(planner?.getAttribute("data-desktop-cowork-kind")).toBe("agent");
    expect(planner?.textContent).toContain("Planner: agent / running");
    planner?.click();
    await nextTick();

    expect(planner?.getAttribute("aria-selected")).toBe("true");
    expect(selections).toEqual([{ type: "agent", id: "agent-1", label: "Planner" }]);

    mounted.unmount();
    expect(host.textContent).toBe("");
  });

  test("ignores graph node kinds that cannot be mapped to cowork selections", () => {
    const host = document.createElement("section");
    const selections: unknown[] = [];

    mountCoworkGraphIsland(host, {
      graph: {
        caption: "1 node",
        nodes: [{ id: "unknown-1", label: "Unknown", kind: "unknown", status: "", raw: {} }],
        edges: [],
      },
      onSelect: (selection) => selections.push(selection),
    });

    host.querySelector<HTMLButtonElement>('[data-desktop-cowork-entity="unknown-1"]')?.click();

    expect(selections).toEqual([]);
  });
});
