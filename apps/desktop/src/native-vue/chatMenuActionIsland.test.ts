// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { mountChatMenuActionIsland } from "./chatMenuActionIsland";

describe("chat menu action Vue island", () => {
  test("renders enabled menu action", () => {
    const host = document.createElement("button");

    const mounted = mountChatMenuActionIsland(host, {
      action: "rename",
      disabled: false,
      label: "Rename session",
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("chat-menu-action");
    expect(host.className).toBe("desktop-chat-menu-action");
    expect(host.getAttribute("role")).toBe("menuitem");
    expect(host.getAttribute("data-desktop-chat-menu-action")).toBe("rename");
    expect(host.textContent).toBe("Rename session");
    expect((host as HTMLButtonElement).disabled).toBe(false);

    mounted.unmount();
    expect(host.textContent).toBe("");
  });

  test("renders disabled menu action", () => {
    const host = document.createElement("button");

    mountChatMenuActionIsland(host, {
      action: "pin",
      disabled: true,
      label: "Pin session",
    });

    expect((host as HTMLButtonElement).disabled).toBe(true);
    expect(host.getAttribute("disabled")).not.toBeNull();
  });
});
