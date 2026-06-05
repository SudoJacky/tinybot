// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { buildDesktopTaskCenterItems } from "../desktopTaskCenter";
import { mountTaskCenterIsland } from "./taskCenterIsland";

describe("task center Vue island", () => {
  test("mounts Naive UI task rows and routes projected actions", () => {
    const host = document.createElement("section");
    const events: string[] = [];
    const items = buildDesktopTaskCenterItems({
      fileOperations: [
        {
          id: "file:workspace:AGENTS.md:save",
          title: "Save AGENTS.md",
          status: "failed",
          detail: "Save conflict",
          canonical: { module: "workspace", entityId: "AGENTS.md", href: "/workspace" },
          retryable: true,
          diagnostics: "HTTP 409",
        },
      ],
      chatStreams: [
        {
          id: "chat:stream:chat-1",
          title: "Streaming response",
          status: "streaming",
          detail: "Generating answer",
          progress: { percent: 42 },
          canonical: { module: "chat", entityId: "chat-1", href: "/chat/chat-1" },
          cancelable: true,
        },
      ],
    });

    const mounted = mountTaskCenterIsland(host, {
      items,
      onAction: ({ action, item }) => events.push(`${action}:${item.id}`),
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("task-center");
    expect(host.getAttribute("id")).toBe("desktop-task-center");
    expect(host.getAttribute("aria-label")).toBe("Background task center");
    expect(host.querySelector(".desktop-task-center-summary")?.textContent).toBe("2 tasks - 1 active - 0 blocked - 1 failed");
    expect(Array.from(host.querySelectorAll(".desktop-task-center-item")).map((row) => row.getAttribute("data-desktop-task-id"))).toEqual([
      "file:workspace:AGENTS.md:save",
      "chat:stream:chat-1",
    ]);
    expect(host.querySelector('[data-desktop-task-id="chat:stream:chat-1"]')?.textContent).toContain("42%");
    expect(host.querySelector('[data-desktop-task-id="file:workspace:AGENTS.md:save"]')?.textContent).toContain("HTTP 409");
    expect(host.querySelector('[data-desktop-task-id="file:workspace:AGENTS.md:save"] .desktop-task-state-badge')?.getAttribute("data-desktop-vue-island")).toBe("task-state-badge");
    expect(host.querySelector('[data-desktop-task-id="file:workspace:AGENTS.md:save"][data-desktop-task-action="retry"]')?.getAttribute("data-desktop-vue-island")).toBe("task-action");
    expect(host.querySelector<HTMLAnchorElement>('[data-desktop-task-id="file:workspace:AGENTS.md:save"][data-desktop-task-action="open"]')?.getAttribute("href")).toBe("/workspace");

    host.querySelector<HTMLButtonElement>('[data-desktop-task-id="file:workspace:AGENTS.md:save"][data-desktop-task-action="retry"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-desktop-task-id="file:workspace:AGENTS.md:save"][data-desktop-task-action="copyDiagnostics"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-desktop-task-id="chat:stream:chat-1"][data-desktop-task-action="cancel"]')?.click();
    expect(events).toEqual([
      "retry:file:workspace:AGENTS.md:save",
      "copyDiagnostics:file:workspace:AGENTS.md:save",
      "cancel:chat:stream:chat-1",
    ]);

    mounted.unmount();
    expect(host.textContent).toBe("");
  });
});
