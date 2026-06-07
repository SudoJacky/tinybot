// @vitest-environment happy-dom

import { describe, expect, test, vi } from "vitest";
import { nextTick } from "vue";
import { mountConversationMessageIsland } from "./conversationMessageIsland";

describe("conversation message Vue island", () => {
  test("renders composed assistant message content", async () => {
    const host = document.createElement("article");
    const staleReasoning = document.createElement("details");
    staleReasoning.className = "desktop-message-reasoning";
    staleReasoning.append(document.createElement("summary"));
    host.append(staleReasoning);

    const mounted = mountConversationMessageIsland(host, {
      attachment: "design.png",
      author: "Tinybot",
      body: ["See [docs](https://example.com)."],
      references: [
        { detail: "lines 1-4", kind: "File", title: "README.md" },
        { detail: "Saved preference", kind: "memory", title: "Memory note" },
      ],
      reasoningContent: "Inspected project context.",
      time: "10:28 AM",
      tone: "assistant",
      toolActivities: [{
        argsText: "README.md",
        approvalStatus: "",
        id: "tool-1",
        kind: "call",
        name: "read_file",
        responseText: "Read README.md",
      }],
    });
    await nextTick();

    expect(host.getAttribute("data-desktop-vue-island")).toBe("conversation-message");
    expect(host.className).toBe("desktop-conversation-message");
    expect(host.getAttribute("data-message-tone")).toBe("assistant");
    expect(host.querySelector(".n-card.desktop-conversation-content-card")).not.toBeNull();
    expect(host.querySelector(".desktop-conversation-meta")?.getAttribute("data-desktop-vue-island")).toBe("conversation-meta");
    expect(host.querySelector(".desktop-conversation-body")?.getAttribute("data-desktop-vue-island")).toBe("conversation-body");
    expect(host.querySelector(".desktop-conversation-reference")?.getAttribute("data-desktop-vue-island")).toBe("conversation-reference");
    expect(host.querySelector(".desktop-conversation-attachment")?.getAttribute("data-desktop-vue-island")).toBe("conversation-attachment");
    expect(host.querySelector(".desktop-tool-activities")?.getAttribute("data-desktop-chat-region")).toBe("tool-timeline");
    expect(host.querySelector(".desktop-tool-activities")?.getAttribute("aria-label")).toBe("Tool Timeline");
    expect(host.querySelector(".desktop-tool-activity")?.textContent).toContain("read_file");
    expect(host.querySelector(".desktop-conversation-meta strong")?.textContent).toBe("Tinybot");
    expect(host.querySelector(".desktop-conversation-meta-separator")?.textContent).toBe(" · ");
    const metaSpans = Array.from(host.querySelectorAll(".desktop-conversation-meta span"));
    expect(metaSpans[metaSpans.length - 1]?.textContent).toBe("10:28 AM");
    expect(host.querySelectorAll(".desktop-message-reasoning-summary")).toHaveLength(0);
    const reasoningToggle = host.querySelector<HTMLButtonElement>(".desktop-message-reasoning-toggle");
    expect(reasoningToggle?.textContent).toBe("Details");
    expect(reasoningToggle?.getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelector(".desktop-message-reasoning-body")).toBeNull();
    reasoningToggle?.click();
    await nextTick();
    expect(reasoningToggle?.getAttribute("aria-expanded")).toBe("true");
    expect(host.querySelector(".desktop-message-reasoning-title")).toBeNull();
    expect(host.querySelector(".desktop-message-reasoning-body")?.textContent).toContain("Inspected project context.");
    expect(host.querySelector(".desktop-conversation-body a")?.getAttribute("target")).toBe("_blank");
    expect(host.querySelector(".desktop-message-references")).not.toBeNull();
    expect(Array.from(host.querySelectorAll(".desktop-message-references-summary")).map((summary) => summary.textContent)).toEqual([
      "File references1 source",
      "Memory references1 source",
    ]);
    expect(host.querySelector(".desktop-message-reference-item")?.textContent).toContain("README.md");
    expect(host.querySelector(".desktop-conversation-attachment")?.textContent).toBe("design.png  1.2 MB");

    mounted.unmount();
    expect(host.textContent).toBe("");
  });

  test("renders user message paragraphs", async () => {
    const host = document.createElement("article");

    mountConversationMessageIsland(host, {
      author: "You",
      body: ["First", "Second"],
      references: [],
      time: "10:29 AM",
      tone: "user",
    });
    await nextTick();

    expect(Array.from(host.querySelectorAll(".desktop-conversation-body p")).map((paragraph) => paragraph.textContent)).toEqual([
      "First",
      "Second",
    ]);
  });

  test("renders a message-level copy action for assistant responses", async () => {
    const host = document.createElement("article");
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    mountConversationMessageIsland(host, {
      author: "Tinybot",
      body: ["First paragraph", "Second paragraph"],
      references: [],
      time: "10:30 AM",
      tone: "assistant",
    });

    const copy = host.querySelector<HTMLButtonElement>(".desktop-message-copy-button");
    expect(copy?.getAttribute("aria-label")).toBe("Copy message");

    copy?.click();
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledWith("First paragraph\n\nSecond paragraph");
    expect(copy?.getAttribute("aria-label")).toBe("Copied");
    expect(copy?.querySelector(".desktop-message-copy-icon")).not.toBeNull();
  });
});
