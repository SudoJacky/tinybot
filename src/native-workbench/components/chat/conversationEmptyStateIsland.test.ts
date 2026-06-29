// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { mountConversationEmptyStateIsland } from "./conversationEmptyStateIsland";

describe("conversation empty state Vue island", () => {
  test("renders empty conversation copy on the thread host", () => {
    const host = document.createElement("section");

    const mounted = mountConversationEmptyStateIsland(host, {
      message: "No messages in this session.",
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("conversation-empty-state");
    expect(host.className).toContain("desktop-conversation-thread");
    expect(host.getAttribute("aria-label")).toBe("Conversation");
    expect(host.textContent).toContain("No messages in this session.");

    mounted.unmount();
    expect(host.textContent).toBe("");
  });
});
