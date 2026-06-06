// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { mountConversationReasoningIsland } from "./conversationReasoningIsland";

describe("conversation reasoning Vue island", () => {
  test("renders reasoning summary and body", () => {
    const host = document.createElement("details");

    const mounted = mountConversationReasoningIsland(host, {
      content: "Inspected the workspace and selected the next Vue island.",
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("conversation-reasoning");
    expect(host.className).toBe("desktop-message-reasoning");
    expect(host.querySelector(".desktop-message-reasoning-title")?.textContent).toBe("Thinking");
    expect(host.querySelector(".desktop-message-reasoning-meta")?.textContent).toBe("Show details");
    expect(host.querySelector(".desktop-message-reasoning-body")?.textContent).toBe("Inspected the workspace and selected the next Vue island.");

    mounted.unmount();
    expect(host.textContent).toBe("");
  });
});
