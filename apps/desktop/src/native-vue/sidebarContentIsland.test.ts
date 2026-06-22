// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { mountSidebarContentIsland } from "./sidebarContentIsland";

describe("sidebar content Vue island", () => {
  test("renders primary sidebar sections and dispatches sidebar commands", () => {
    const host = document.createElement("div");
    const commands: unknown[] = [];
    document.addEventListener("desktop-menu-command", (event) => commands.push((event as CustomEvent).detail));

    const mounted = mountSidebarContentIsland(host, {
      commandItems: [
        { commandId: "open-settings", id: "settings", kind: "command", label: "Settings" },
      ],
      commandLabel: "System",
      recentChats: [
        {
          active: true,
          chatId: "chat-1",
          href: "/chat/chat-1",
          pinned: true,
          routeId: "chat-1",
          sessionKey: "WebSocket:chat-1",
          title: "Session one",
          updatedLabel: "Updated 8:11:21 AM",
        },
      ],
      resourceItems: [
        { href: "/workspace", id: "workspace", kind: "link", label: "Workspace" },
      ],
      resourceLabel: "Resources",
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("sidebar-content");
    expect(host.className).toBe("desktop-sidebar-content");
    expect(host.querySelector(".n-space.desktop-sidebar-content-stack")).not.toBeNull();
    expect(host.querySelector(".desktop-sidebar-actions")?.getAttribute("data-desktop-vue-island")).toBe("sidebar-actions");
    expect(host.querySelector(".desktop-sidebar-primary-action")?.getAttribute("href")).toBe("/chat/new");
    expect(host.querySelector(".desktop-sidebar-search")?.getAttribute("type")).toBe("search");
    expect(host.querySelector(".desktop-sidebar-list-section-workspaces")).toBeNull();
    expect(host.querySelector(".desktop-workspace-list")).toBeNull();
    expect(host.querySelector(".desktop-sidebar-list-section-recent")?.getAttribute("data-desktop-vue-island")).toBe("sidebar-recent-chats");
    expect(host.querySelector("[data-desktop-session-key]")?.getAttribute("data-pinned")).toBe("true");
    expect(host.querySelector('[data-sidebar-item-id="workspace"]')?.closest(".desktop-workbench-section")?.getAttribute("data-desktop-vue-island")).toBe("shared-sidebar-links");
    expect(host.querySelector('[data-sidebar-item-id="workspace"]')?.getAttribute("href")).toBe("/workspace");
    expect(host.querySelector('[data-sidebar-command="open-settings"]')?.closest(".desktop-workbench-section")?.getAttribute("data-desktop-vue-island")).toBe("shared-sidebar-commands");

    host.querySelector<HTMLButtonElement>('[data-sidebar-command="open-settings"]')?.click();
    expect(commands).toEqual([{ id: "open-settings", source: "native-sidebar" }]);

    mounted.unmount();
    expect(host.textContent).toBe("");
  });
});
