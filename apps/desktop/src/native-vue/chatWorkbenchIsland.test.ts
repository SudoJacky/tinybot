// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import type { DesktopTaskCenterItem } from "../desktopTaskCenter";
import { mountChatWorkbenchIsland } from "./chatWorkbenchIsland";

const chatRun: DesktopTaskCenterItem = {
  id: "chat:stream:chat-1",
  source: "chat",
  title: "Streaming response",
  state: "active",
  status: "running",
  tone: "normal",
  detail: "Rendering tokens",
  progress: null,
  progressLabel: "12 tokens",
  destination: { module: "chat", entityId: "chat-1", href: "/chat/chat-1" },
  diagnostics: "",
  relatedResources: [],
  outputs: [],
  actions: [{ id: "inspect", label: "Inspect" }],
  updatedAt: "",
};

describe("chat workbench Vue island", () => {
  test("renders workbench chrome, panel controls, quick actions, and module work", () => {
    const host = document.createElement("div");
    const panels: string[] = [];
    const inspected: string[] = [];

    const mounted = mountChatWorkbenchIsland(host, {
      moduleWorkItems: [chatRun],
      panelControls: [
        { panel: "sidebar", label: "Sidebar", ariaLabel: "Toggle Sidebar panel", visible: true },
        { panel: "bottom", label: "Tasks", ariaLabel: "Toggle Tasks panel", visible: false },
      ],
      onInspectWorkItem: (item) => inspected.push(item.id),
      onPanelToggle: (panel) => panels.push(panel),
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("chat-workbench");
    expect(host.className).toBe("desktop-chat-workbench-chrome");
    expect(host.textContent).toContain("Ready for a new session.");
    expect(host.textContent).toContain("Ready for a new session. Start");
    expect(host.textContent).toContain("Start from chat, inspect the workspace, or check gateway status.");
    expect(host.textContent).not.toContain("sessionStart");
    expect(host.textContent).not.toContain("session.Start");
    expect(host.querySelector(".desktop-quick-actions")?.getAttribute("data-desktop-vue-island")).toBe("quick-actions");
    expect(host.querySelector(".desktop-quick-actions")?.textContent).toContain("Open workspace");
    expect(host.querySelector(".desktop-panel-controls")?.getAttribute("data-desktop-vue-island")).toBe("panel-controls");
    expect(host.querySelector('[data-desktop-panel-control="sidebar"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(host.querySelector(".desktop-module-work")?.getAttribute("data-desktop-vue-island")).toBe("module-work");
    expect(host.querySelector('[data-desktop-module-work="chat:stream:chat-1"]')?.textContent).toContain("Streaming response");

    host.querySelector<HTMLButtonElement>('[data-desktop-panel-control="bottom"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-desktop-module-work="chat:stream:chat-1"]')?.click();

    expect(panels).toEqual(["bottom"]);
    expect(inspected).toEqual(["chat:stream:chat-1"]);

    mounted.unmount();
    expect(host.textContent).toBe("");
  });
});
