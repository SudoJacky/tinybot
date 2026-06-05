// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { mountChatHeaderActionsIsland } from "./chatHeaderActionsIsland";

describe("chat header actions Vue island", () => {
  test("renders compact panel controls and dispatches toggles", () => {
    const host = document.createElement("div");
    const toggled: string[] = [];

    const mounted = mountChatHeaderActionsIsland(host, {
      actions: [
        {
          panel: "sidebar",
          visible: true,
          label: "Sidebar",
          pressedLabel: "Collapse session list",
          unpressedLabel: "Expand session list",
        },
        {
          panel: "inspector",
          visible: false,
          label: "Run Chain",
          pressedLabel: "Close Run Chain panel",
          unpressedLabel: "Open Run Chain panel",
        },
      ],
      onToggle: (panel) => toggled.push(panel),
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("chat-header-actions");
    expect(host.className).toBe("desktop-chat-header-actions");

    const sidebar = host.querySelector<HTMLElement>('[data-desktop-panel-control="sidebar"]');
    const inspector = host.querySelector<HTMLElement>('[data-desktop-panel-control="inspector"]');

    expect(sidebar?.getAttribute("aria-label")).toBe("Collapse session list");
    expect(sidebar?.getAttribute("aria-pressed")).toBe("true");
    expect(sidebar?.querySelector(".desktop-chat-header-panel-icon")?.getAttribute("data-panel-icon")).toBe("collapse-left");
    expect(inspector?.getAttribute("aria-label")).toBe("Open Run Chain panel");
    expect(inspector?.getAttribute("aria-pressed")).toBe("false");
    expect(inspector?.querySelector(".desktop-chat-header-panel-icon")?.getAttribute("data-panel-icon")).toBe("collapse-right");

    sidebar?.click();
    inspector?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    sidebar?.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));

    expect(toggled).toEqual(["sidebar", "inspector", "sidebar"]);

    mounted.unmount();
    expect(host.textContent).toBe("");
  });
});
