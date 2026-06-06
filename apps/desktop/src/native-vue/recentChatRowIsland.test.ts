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
      updatedLabel: "Updated 2m ago",
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
    expect(link?.querySelector(".desktop-sidebar-row-meta")?.textContent).toBe("Updated 2m ago");
    expect(link?.querySelector("[data-desktop-session-pin-icon]")?.textContent).toBe("📌");

    const deleteButton = host.querySelector<HTMLButtonElement>("[data-desktop-chat-delete]");
    expect(deleteButton?.getAttribute("type")).toBe("button");
    expect(deleteButton?.getAttribute("aria-label")).toBe("Delete chat Session one");
    expect(deleteButton?.textContent).toBe("x");

    mounted.unmount();
    expect(host.textContent).toBe("");
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
    expect(deleteButton?.textContent).toBe("Confirm");

    deleteButton?.click();
    await nextTick();
    expect(deletes).toEqual([{ chatId: "chat-2", sessionKey: "WebSocket:chat-2", title: "Session two" }]);
    expect(deleteButton?.getAttribute("disabled")).toBe("");
    expect(deleteButton?.getAttribute("data-deleting")).toBe("true");
    expect(deleteButton?.textContent).toBe("Deleting");
  });
});
