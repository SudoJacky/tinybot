// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { mountConversationMessageIsland } from "./conversationMessageIsland";

describe("conversation message Vue island", () => {
  test("renders composed assistant message content", () => {
    const host = document.createElement("article");

    const mounted = mountConversationMessageIsland(host, {
      attachment: "design.png",
      author: "Tinybot",
      body: ["See [docs](https://example.com)."],
      references: [{ detail: "lines 1-4", kind: "File", title: "README.md" }],
      time: "10:28 AM",
      tone: "assistant",
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("conversation-message");
    expect(host.className).toBe("desktop-conversation-message");
    expect(host.getAttribute("data-message-tone")).toBe("assistant");
    expect(host.querySelector(".desktop-conversation-meta strong")?.textContent).toBe("Tinybot");
    expect(host.querySelector(".desktop-conversation-meta span")?.textContent).toBe("10:28 AM");
    expect(host.querySelector(".desktop-conversation-body a")?.getAttribute("target")).toBe("_blank");
    expect(host.querySelector(".desktop-conversation-reference")?.textContent).toBe("File: README.md - lines 1-4");
    expect(host.querySelector(".desktop-conversation-attachment")?.textContent).toBe("design.png  1.2 MB");

    mounted.unmount();
    expect(host.textContent).toBe("");
  });

  test("renders user message paragraphs", () => {
    const host = document.createElement("article");

    mountConversationMessageIsland(host, {
      author: "You",
      body: ["First", "Second"],
      references: [],
      time: "10:29 AM",
      tone: "user",
    });

    expect(Array.from(host.querySelectorAll(".desktop-conversation-body p")).map((paragraph) => paragraph.textContent)).toEqual([
      "First",
      "Second",
    ]);
  });
});
