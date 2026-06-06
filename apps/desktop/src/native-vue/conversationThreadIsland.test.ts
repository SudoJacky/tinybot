// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { nextTick } from "vue";
import { mountConversationThreadIsland } from "./conversationThreadIsland";

describe("conversation thread Vue island", () => {
  test("renders messages in order", async () => {
    const host = document.createElement("section");

    const mounted = mountConversationThreadIsland(host, {
      emptyMessage: "",
      messages: [
        {
          author: "You",
          body: ["Hello"],
          references: [],
          time: "10:28 AM",
          tone: "user",
          toolActivities: [],
        },
        {
          author: "Tinybot",
          body: ["Hi"],
          references: [{ detail: "", kind: "File", title: "README.md" }],
          time: "10:29 AM",
          tone: "assistant",
          toolActivities: [],
        },
      ],
    });
    await nextTick();
    await nextTick();

    expect(host.getAttribute("data-desktop-vue-island")).toBe("conversation-thread");
    expect(host.className).toBe("desktop-conversation-thread");
    expect(host.getAttribute("aria-label")).toBe("Conversation");
    expect(Array.from(host.querySelectorAll(".desktop-conversation-message")).map((message) => message.getAttribute("data-desktop-vue-island"))).toEqual([
      "conversation-message",
      "conversation-message",
    ]);
    expect(Array.from(host.querySelectorAll(".desktop-conversation-meta strong")).map((author) => author.textContent)).toEqual([
      "You",
      "Tinybot",
    ]);
    expect(host.querySelector(".desktop-conversation-reference")?.textContent).toBe("File: README.md");

    mounted.unmount();
    expect(host.textContent).toBe("");
  });

  test("renders empty state", () => {
    const host = document.createElement("section");

    mountConversationThreadIsland(host, {
      emptyMessage: "No messages in this session.",
      messages: [],
    });

    expect(host.textContent).toBe("No messages in this session.");
  });
});
