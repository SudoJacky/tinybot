// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { mountHeaderPanelControlIsland } from "./headerPanelControlIsland";

describe("header panel control Vue island", () => {
  test("renders sidebar icon control and dispatches toggle", () => {
    const host = document.createElement("button");
    const toggled: string[] = [];

    const mounted = mountHeaderPanelControlIsland(host, {
      panel: "sidebar",
      visible: true,
      label: "Sidebar",
      pressedLabel: "Collapse session list",
      unpressedLabel: "Expand session list",
      onToggle: (panel) => toggled.push(panel),
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("header-panel-control");
    expect(host.className).toContain("desktop-chat-header-panel-button");
    expect(host.getAttribute("type")).toBe("button");
    expect(host.getAttribute("data-desktop-panel-control")).toBe("sidebar");
    expect(host.getAttribute("data-desktop-panel-label-pressed")).toBe("Collapse session list");
    expect(host.getAttribute("data-desktop-panel-label-unpressed")).toBe("Expand session list");
    expect(host.getAttribute("aria-label")).toBe("Collapse session list");
    expect(host.getAttribute("title")).toBe("Collapse session list");
    expect(host.getAttribute("aria-pressed")).toBe("true");
    expect(host.textContent).toBe("");
    expect(host.querySelector(".desktop-chat-header-panel-icon")?.getAttribute("data-panel-icon")).toBe("collapse-left");
    expect(host.querySelector(".desktop-chat-header-panel-icon-frame")).toBeTruthy();
    expect(host.querySelector(".desktop-chat-header-panel-icon-rail")).toBeTruthy();

    host.click();
    expect(toggled).toEqual(["sidebar"]);

    mounted.unmount();
    expect(host.textContent).toBe("");
  });

  test("renders text fallback for non-icon panel controls", () => {
    const host = document.createElement("button");

    const mounted = mountHeaderPanelControlIsland(host, {
      panel: "bottom",
      visible: false,
      label: "Tasks",
      pressedLabel: "Hide tasks",
      unpressedLabel: "Show tasks",
    });

    expect(host.getAttribute("aria-label")).toBe("Show tasks");
    expect(host.getAttribute("aria-pressed")).toBe("false");
    expect(host.textContent).toContain("Tasks");

    mounted.unmount();
  });
});
