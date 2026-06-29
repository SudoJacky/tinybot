// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { nextTick } from "vue";
import { mountChatMenuPopoverIsland } from "./chatMenuPopoverIsland";

describe("chat menu popover Vue island", () => {
  test("renders actions and forwards clicks", async () => {
    const host = document.createElement("div");
    const events: string[] = [];

    const mounted = mountChatMenuPopoverIsland(host, {
      actions: [
        {
          action: "pin",
          disabled: false,
          label: "Pin session",
          onAction: () => {
            events.push("pin");
            return "Unpin session";
          },
        },
        {
          action: "rename",
          disabled: false,
          label: "Rename session",
          onAction: () => {
            events.push("rename");
          },
        },
        {
          action: "new-chat",
          disabled: true,
          label: "New chat",
          onAction: () => {
            events.push("new-chat");
          },
        },
      ],
      emptyMessage: "",
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("chat-menu-popover");
    expect(host.className).toBe("desktop-chat-menu-popover");
    expect(host.getAttribute("role")).toBe("menu");
    expect(host.getAttribute("aria-label")).toBe("Chat session actions");
    expect(host.querySelector(".desktop-chat-menu-popover-card")).toBeNull();
    const actionButtons = Array.from(host.querySelectorAll<HTMLButtonElement>(".desktop-chat-menu-action"));
    expect(actionButtons).toHaveLength(3);
    expect(actionButtons.map((button) => button.getAttribute("data-desktop-vue-island"))).toEqual([
      "chat-menu-action",
      "chat-menu-action",
      "chat-menu-action",
    ]);
    expect(actionButtons.every((button) => button.querySelector(".desktop-chat-menu-action") === null)).toBe(true);
    expect(actionButtons.map((button) => button.textContent)).toEqual([
      "Pin session",
      "Rename session",
      "New chat",
    ]);
    expect(host.querySelector<HTMLButtonElement>('[data-desktop-chat-menu-action="new-chat"]')?.disabled).toBe(true);

    host.querySelector<HTMLButtonElement>('[data-desktop-chat-menu-action="pin"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-desktop-chat-menu-action="rename"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-desktop-chat-menu-action="new-chat"]')?.click();
    await nextTick();

    expect(events).toEqual(["pin", "rename"]);
    expect(host.querySelector('[data-desktop-chat-menu-action="pin"]')?.textContent).toBe("Unpin session");

    mounted.unmount();
    expect(host.textContent).toBe("");
  });

  test("renders empty menu state", () => {
    const host = document.createElement("div");

    mountChatMenuPopoverIsland(host, {
      actions: [],
      emptyMessage: "No active session",
    });

    expect(host.querySelector(".desktop-chat-menu-empty")?.getAttribute("data-desktop-vue-island")).toBe("chat-menu-empty");
    expect(host.textContent).toBe("No active session");
  });
});
