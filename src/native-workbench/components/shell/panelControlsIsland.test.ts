// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { mountPanelControlsIsland } from "./panelControlsIsland";

describe("panel controls Vue island", () => {
  test("renders accessible panel controls and dispatches toggle actions", () => {
    const host = document.createElement("div");
    const toggled: string[] = [];

    const mounted = mountPanelControlsIsland(host, {
      controls: [
        {
          panel: "sidebar",
          label: "Sidebar",
          ariaLabel: "Toggle sidebar panel",
          visible: true,
          shortcut: "Ctrl+B",
        },
        {
          panel: "inspector",
          label: "Run Chain",
          ariaLabel: "Toggle Run Chain panel",
          visible: true,
        },
        {
          panel: "bottom",
          label: "Tasks",
          ariaLabel: "Toggle task and runtime panel",
          visible: false,
        },
      ],
      onToggle: (panel) => toggled.push(panel),
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("panel-controls");
    expect(host.className).toContain("desktop-panel-controls");
    expect(host.getAttribute("aria-label")).toBe("Workbench panel controls");

    const controls = [...host.querySelectorAll<HTMLButtonElement>(".desktop-panel-control")];
    expect(controls.map((node) => node.getAttribute("data-desktop-panel-control"))).toEqual(["sidebar", "inspector", "bottom"]);
    expect(controls.map((node) => node.getAttribute("aria-label"))).toEqual([
      "Toggle sidebar panel",
      "Toggle Run Chain panel",
      "Toggle task and runtime panel",
    ]);
    expect(controls.map((node) => node.textContent)).toEqual(["Sidebar", "Run Chain", "Tasks"]);
    expect(controls.map((node) => node.getAttribute("aria-pressed"))).toEqual(["true", "true", "false"]);
    expect(controls[0].getAttribute("aria-keyshortcuts")).toBe("Ctrl+B");

    controls[1].click();
    controls[2].dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));

    expect(toggled).toEqual(["inspector", "bottom"]);

    mounted.unmount();
    expect(host.textContent).toBe("");
  });
});
