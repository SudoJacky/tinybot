// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { nextTick } from "vue";
import { mountRecentChatRowIsland } from "./recentChatRowIsland";

describe("recent chat row Vue island", () => {
  test("renders pinned recent chat metadata and delete affordance", () => {
    const host = document.createElement("div");

    const mounted = mountRecentChatRowIsland(host, {
      active: true,
      chatId: "chat-1",
      href: "/chat/chat-1",
      pinned: true,
      routeId: "chat-1",
      sessionKey: "WebSocket:chat-1",
      title: "Session one",
      updatedLabel: "2分",
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("recent-chat-row");
    expect(host.className).toBe("desktop-sidebar-chat-row");
    expect(host.getAttribute("role")).toBe("listitem");
    expect(host.getAttribute("data-active")).toBe("true");
    expect(host.getAttribute("data-sidebar-row-kind")).toBe("chat");
    expect(host.getAttribute("data-desktop-session-key")).toBe("WebSocket:chat-1");
    expect(host.getAttribute("data-desktop-chat-id")).toBe("chat-1");
    expect(host.getAttribute("data-desktop-route-id")).toBe("chat-1");
    expect(host.getAttribute("data-pinned")).toBe("true");

    const link = host.querySelector<HTMLAnchorElement>(".desktop-sidebar-row-main");
    expect(link?.getAttribute("href")).toBe("/chat/chat-1");
    expect(link?.getAttribute("data-desktop-entity-module")).toBe("chat");
    expect(link?.getAttribute("data-desktop-entity-id")).toBe("chat-1");
    expect(link?.querySelector(".desktop-sidebar-row-label")?.textContent).toBe("Session one");
    expect(link?.querySelector(".desktop-sidebar-row-meta")?.textContent).toBe("2分");
    expect(link?.querySelector("[data-desktop-session-pin-icon]")?.textContent).toBe("📌");

    const deleteButton = host.querySelector<HTMLButtonElement>("[data-desktop-chat-delete]");
    expect(deleteButton?.getAttribute("type")).toBe("button");
    expect(deleteButton?.getAttribute("aria-label")).toBe("Delete chat Session one");
    expect(deleteButton?.textContent).toBe("x");

    mounted.unmount();
    expect(host.textContent).toBe("");
  });

  test("does not render compact work status chips in the session row", () => {
    const host = document.createElement("div");

    mountRecentChatRowIsland(host, {
      active: true,
      chatId: "chat-1",
      href: "/chat/chat-1",
      pinned: false,
      routeId: "chat-1",
      sessionKey: "WebSocket:chat-1",
      statusChips: [
        { kind: "running", label: "Running" },
        { kind: "approval", label: "Approval" },
        { kind: "files", label: "2 files" },
        { kind: "knowledge", label: "Knowledge On" },
      ],
      title: "Session one",
      updatedLabel: "2分",
    });

    expect(host.querySelector(".desktop-sidebar-row-status")).toBeNull();
    expect(host.querySelector(".desktop-sidebar-status-chip")).toBeNull();
    expect(host.textContent).not.toContain("Running");
    expect(host.textContent).not.toContain("Approval");
    expect(host.textContent).not.toContain("Knowledge On");
  });

  test("confirms before invoking delete callback", async () => {
    const host = document.createElement("div");
    const deletes: unknown[] = [];

    mountRecentChatRowIsland(host, {
      active: false,
      chatId: "chat-2",
      href: "/chat/chat-2",
      onDeleteSession: (event) => deletes.push(event),
      pinned: false,
      routeId: "chat-2",
      sessionKey: "WebSocket:chat-2",
      title: "Session two",
      updatedLabel: "chat-2",
    });

    const deleteButton = host.querySelector<HTMLButtonElement>("[data-desktop-chat-delete]");
    deleteButton?.click();
    await nextTick();
    expect(deletes).toEqual([]);
    expect(deleteButton?.getAttribute("aria-label")).toBe("Confirm delete chat Session two");
    expect(deleteButton?.getAttribute("data-confirming")).toBe("true");
    expect(deleteButton?.textContent).toBe("确认");

    deleteButton?.click();
    await nextTick();
    expect(deletes).toEqual([{ chatId: "chat-2", sessionKey: "WebSocket:chat-2", title: "Session two" }]);
    expect(deleteButton?.getAttribute("disabled")).toBe("");
    expect(deleteButton?.getAttribute("data-deleting")).toBe("true");
    expect(deleteButton?.textContent).toBe("删除中");
  });
});
