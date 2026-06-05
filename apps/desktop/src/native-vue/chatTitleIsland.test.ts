// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { mountChatTitleIsland } from "./chatTitleIsland";

describe("chat title Vue island", () => {
  test("renders active chat title", () => {
    const host = document.createElement("h1");

    const mounted = mountChatTitleIsland(host, {
      title: "Renamed session",
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("chat-title");
    expect(host.className).toBe("desktop-chat-title");
    expect(host.textContent).toBe("Renamed session");

    mounted.unmount();
    expect(host.textContent).toBe("");
  });
});
