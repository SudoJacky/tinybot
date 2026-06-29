// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { mountChatMenuEmptyIsland } from "./chatMenuEmptyIsland";

describe("chat menu empty Vue island", () => {
  test("renders empty menu state", () => {
    const host = document.createElement("span");

    const mounted = mountChatMenuEmptyIsland(host, {
      message: "No active session",
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("chat-menu-empty");
    expect(host.className).toBe("desktop-chat-menu-empty");
    expect(host.textContent).toBe("No active session");

    mounted.unmount();
    expect(host.textContent).toBe("");
  });
});
