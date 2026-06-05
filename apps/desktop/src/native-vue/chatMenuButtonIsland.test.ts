// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { mountChatMenuButtonIsland } from "./chatMenuButtonIsland";

describe("chat menu button Vue island", () => {
  test("renders chat menu trigger and dispatches toggle", () => {
    const host = document.createElement("button");
    let toggleCount = 0;

    const mounted = mountChatMenuButtonIsland(host, {
      expanded: false,
      onToggle: () => {
        toggleCount += 1;
      },
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("chat-menu-button");
    expect(host.className).toContain("desktop-chat-menu");
    expect(host.getAttribute("type")).toBe("button");
    expect(host.getAttribute("data-desktop-chat-menu")).toBe("more");
    expect(host.getAttribute("aria-haspopup")).toBe("menu");
    expect(host.getAttribute("aria-expanded")).toBe("false");
    expect(host.getAttribute("aria-label")).toBe("More chat actions");
    expect(host.textContent).toBe("...");

    host.click();
    expect(toggleCount).toBe(1);

    mounted.unmount();
    expect(host.textContent).toBe("");
  });

  test("renders expanded state", () => {
    const host = document.createElement("button");

    const mounted = mountChatMenuButtonIsland(host, {
      expanded: true,
    });

    expect(host.getAttribute("aria-expanded")).toBe("true");

    mounted.unmount();
  });
});
