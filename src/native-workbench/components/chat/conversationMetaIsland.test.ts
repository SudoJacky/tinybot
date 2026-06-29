// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { mountConversationMetaIsland } from "./conversationMetaIsland";

describe("conversation meta Vue island", () => {
  test("renders author and time", () => {
    const host = document.createElement("div");

    const mounted = mountConversationMetaIsland(host, {
      author: "Tinybot",
      time: "10:28 AM",
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("conversation-meta");
    expect(host.className).toBe("desktop-conversation-meta");
    expect(host.querySelector("strong")?.textContent).toBe("Tinybot");
    expect(host.querySelector(".desktop-conversation-meta-separator")?.textContent).toBe(" · ");
    expect(host.querySelector(".desktop-conversation-meta-separator")?.getAttribute("aria-hidden")).toBe("true");
    const spans = Array.from(host.querySelectorAll("span"));
    expect(spans[spans.length - 1]?.textContent).toBe("10:28 AM");
    expect(host.textContent).toBe("Tinybot · 10:28 AM");

    mounted.unmount();
    expect(host.textContent).toBe("");
  });
});
