// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import type { DesktopTaskCenterItem } from "../../tasks/desktopTaskCenter";
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
  test("renders workbench chrome and contextual module work without redundant shortcuts", () => {
    const host = document.createElement("div");
    const inspected: string[] = [];

    const mounted = mountChatWorkbenchIsland(host, {
      moduleWorkItems: [chatRun],
      onInspectWorkItem: (item) => inspected.push(item.id),
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("chat-workbench");
    expect(host.className).toBe("desktop-chat-workbench-chrome");
    expect(host.textContent).toContain("Start a new session");
    expect(host.textContent).toContain("Ask Tinybot about the workspace, inspect files, or create a task.");
    expect(host.textContent).not.toContain("sessionStart");
    expect(host.textContent).not.toContain("session.Start");
    expect(host.querySelector(".desktop-quick-actions")).toBeNull();
    expect(host.querySelectorAll(".desktop-quick-action")).toHaveLength(0);
    expect(host.querySelector(".desktop-panel-controls")).toBeNull();
    expect(host.querySelector(".desktop-module-work")?.getAttribute("data-desktop-vue-island")).toBe("module-work");
    expect(host.querySelector('[data-desktop-module-work="chat:stream:chat-1"]')?.textContent).toContain("Streaming response");

    host.querySelector<HTMLButtonElement>('[data-desktop-module-work="chat:stream:chat-1"]')?.click();

    expect(inspected).toEqual(["chat:stream:chat-1"]);

    mounted.unmount();
    expect(host.textContent).toBe("");
  });
});
