// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import type { DesktopTaskCenterItem } from "../desktopTaskCenter";
import { mountModuleWorkSectionIsland } from "./moduleWorkSectionIsland";

describe("module work section Vue island", () => {
  test("renders inspectable module work rows and dispatches row selection", () => {
    const host = document.createElement("section");
    const selected: string[] = [];
    const item: DesktopTaskCenterItem = {
      id: "chat:stream:chat-1",
      source: "chat",
      title: "Streaming response",
      state: "active",
      status: "running",
      tone: "normal",
      detail: "Rendering tokens",
      progress: { percent: 12 },
      progressLabel: "12 tokens",
      destination: { module: "chat", entityId: "chat-1", href: "/chat/chat-1" },
      diagnostics: "",
      relatedResources: [],
      outputs: [],
      actions: [{ id: "inspect", label: "Inspect" }],
      updatedAt: "",
    };

    const mounted = mountModuleWorkSectionIsland(host, {
      title: "Chat runs",
      items: [item],
      onInspect: (nextItem) => selected.push(nextItem.id),
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("module-work");
    expect(host.className).toContain("desktop-module-work");
    expect(host.getAttribute("aria-label")).toBe("Chat runs");
    expect(host.querySelector("h2")?.textContent).toBe("Chat runs");

    const row = host.querySelector<HTMLButtonElement>('[data-desktop-module-work="chat:stream:chat-1"]');
    expect(row?.getAttribute("data-desktop-module-work-source")).toBe("chat");
    expect(row?.getAttribute("aria-label")).toBe("Inspect Streaming response in Work Lens");
    expect(row?.textContent).toContain("Streaming response: running / Rendering tokens / 12 tokens");

    row?.click();
    expect(selected).toEqual(["chat:stream:chat-1"]);

    mounted.unmount();
    expect(host.textContent).toBe("");
  });
});
