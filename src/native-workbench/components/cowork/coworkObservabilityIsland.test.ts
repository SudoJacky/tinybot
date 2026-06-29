// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { nextTick } from "vue";
import type { DesktopCoworkObservabilityPanel } from "../../cowork/desktopCowork";
import { mountCoworkObservabilityIsland } from "./coworkObservabilityIsland";

const panels: DesktopCoworkObservabilityPanel[] = [
  {
    id: "graph",
    label: "Graph",
    summary: "Agent and task graph",
    rows: [
      { label: "Nodes", value: "2" },
      { label: "Edges", value: "1" },
    ],
  },
  {
    id: "trace",
    label: "Trace",
    summary: "Runtime trace rows",
    rows: Array.from({ length: 30 }, (_, index) => ({
      label: `Trace span ${index + 1}`,
      value: index === 29 ? "Selected trace payload" : `Payload ${index + 1}`,
    })),
  },
];

describe("cowork observability Vue island", () => {
  test("renders switchable panels with bounded filtered rows", async () => {
    const host = document.createElement("section");
    const selectedPanels: string[] = [];

    const mounted = mountCoworkObservabilityIsland(host, {
      panels,
      onPanelSelected: (panel) => selectedPanels.push(panel.id),
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("cowork-observability");
    expect(host.className).toContain("desktop-cowork-observability");
    expect(host.getAttribute("aria-label")).toBe("Cowork observability");
    expect(host.querySelector("h2")?.textContent).toBe("Observability");
    expect(Array.from(host.querySelectorAll(".desktop-cowork-observability-tab")).map((tab) => tab.getAttribute("data-desktop-cowork-panel"))).toEqual([
      "graph",
      "trace",
    ]);
    expect(host.querySelector('[data-desktop-cowork-panel="graph"]')?.getAttribute("aria-selected")).toBe("true");
    expect(host.querySelector(".desktop-cowork-observability-panel")?.textContent).toContain("Graph");
    expect(host.querySelector(".desktop-cowork-observability-panel")?.textContent).toContain("Showing 2 of 2 rows");

    host.querySelector<HTMLButtonElement>('[data-desktop-cowork-panel="trace"]')?.click();
    await nextTick();
    expect(host.querySelector('[data-desktop-cowork-panel="trace"]')?.getAttribute("aria-selected")).toBe("true");
    expect(host.querySelectorAll(".desktop-cowork-observability-row")).toHaveLength(24);
    expect(host.querySelector(".desktop-cowork-observability-panel")?.textContent).toContain("Showing 24 of 30 rows");
    expect(host.querySelector(".desktop-cowork-observability-panel")?.textContent).not.toContain("Trace span 25");

    const filter = host.querySelector<HTMLInputElement>('[data-desktop-cowork-filter="observability"]');
    expect(filter?.getAttribute("placeholder")).toBe("Filter current panel");
    if (filter) {
      filter.value = "Trace span 30";
      filter.dispatchEvent(new Event("input", { bubbles: true }));
      await nextTick();
    }

    expect(host.querySelectorAll(".desktop-cowork-observability-row")).toHaveLength(1);
    expect(host.querySelector(".desktop-cowork-observability-panel")?.textContent).toContain("Showing 1 of 1 matching rows (30 total)");
    expect(host.querySelector(".desktop-cowork-observability-panel")?.textContent).toContain("Trace span 30: Selected trace payload");
    expect(selectedPanels).toEqual(["trace"]);

    mounted.unmount();
    expect(host.textContent).toBe("");
  });

  test("renders an empty state when no observability panels are available", () => {
    const host = document.createElement("section");

    const mounted = mountCoworkObservabilityIsland(host, { panels: [] });

    expect(host.querySelector(".desktop-cowork-observability-panel")?.textContent).toContain("No Cowork observability data.");

    mounted.unmount();
  });
});
