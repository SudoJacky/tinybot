// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { nextTick } from "vue";
import { mountSidebarRecentChatsIsland } from "./sidebarRecentChatsIsland";

describe("sidebar recent chats Vue island", () => {
  test("renders recent chat rows and forwards delete events", async () => {
    const host = document.createElement("section");
    const deletes: unknown[] = [];

    const mounted = mountSidebarRecentChatsIsland(host, {
      rows: [
        {
          active: true,
          chatId: "chat-1",
          href: "/chat/chat-1",
          pinned: true,
          routeId: "chat-1",
          sessionKey: "WebSocket:chat-1",
          statusChips: [
            { kind: "running", label: "Running" },
            { kind: "knowledge", label: "Knowledge On" },
          ],
          title: "Session one",
          updatedLabel: "Updated 8:11:21 AM",
        },
        {
          active: false,
          chatId: "chat-2",
          href: "/chat/custom-route",
          pinned: false,
          routeId: "custom-route",
          sessionKey: "custom-route",
          title: "Session two",
          updatedLabel: "chat-2",
        },
      ],
      onDeleteSession: (event) => deletes.push(event),
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("sidebar-recent-chats");
    expect(host.className).toBe("desktop-sidebar-list-section desktop-sidebar-list-section-recent");
    expect(host.querySelector(".desktop-sidebar-section-heading h2")?.textContent).toBe("Recent chats");
    expect(host.querySelector(".desktop-sidebar-section-action")).toBeNull();
    expect(host.querySelector(".desktop-recent-chat-list")?.getAttribute("role")).toBe("list");

    const rows = Array.from(host.querySelectorAll(".desktop-sidebar-chat-row"));
    expect(rows.map((row) => row.getAttribute("data-desktop-session-key"))).toEqual(["WebSocket:chat-1", "custom-route"]);
    expect(rows.map((row) => row.getAttribute("data-pinned"))).toEqual(["true", "false"]);
    expect(rows[0]?.querySelector(".desktop-sidebar-row-label")?.textContent).toBe("Session one");
    expect(rows[0]?.querySelector("[data-desktop-session-pin-icon]")?.textContent).toBe("馃搶");
    expect(rows[0]?.querySelector(".desktop-sidebar-row-status")?.getAttribute("data-desktop-chat-status")).toBe("WebSocket:chat-1");
    expect(Array.from(rows[0]?.querySelectorAll(".desktop-sidebar-status-chip") ?? []).map((chip) => chip.textContent)).toEqual(["Running", "Knowledge On"]);
    expect(rows[1]?.querySelector(".desktop-sidebar-row-main")?.getAttribute("href")).toBe("/chat/custom-route");

    const deleteButton = rows[1]?.querySelector<HTMLButtonElement>("[data-desktop-chat-delete]");
    deleteButton?.click();
    await nextTick();
    deleteButton?.click();
    await nextTick();

    expect(deletes).toEqual([{ chatId: "chat-2", sessionKey: "custom-route", title: "Session two" }]);

    mounted.unmount();
    expect(host.textContent).toBe("");
  });

  test("renders empty recent chat state", () => {
    const host = document.createElement("section");

    mountSidebarRecentChatsIsland(host, { rows: [] });

    expect(host.querySelector(".desktop-recent-chat-list")?.textContent).toContain("No recent chats.");
    expect(host.querySelector(".desktop-sidebar-chat-row")).toBeNull();
  });
});
