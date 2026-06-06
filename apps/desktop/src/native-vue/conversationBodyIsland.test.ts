// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { mountConversationBodyIsland } from "./conversationBodyIsland";

describe("conversation body Vue island", () => {
  test("renders user body lines as paragraphs", () => {
    const host = document.createElement("div");

    const mounted = mountConversationBodyIsland(host, {
      body: ["First line", "", "Second line"],
      tone: "user",
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("conversation-body");
    expect(host.className).toBe("desktop-conversation-body");
    expect(Array.from(host.querySelectorAll("p")).map((paragraph) => paragraph.textContent)).toEqual([
      "First line",
      "Second line",
    ]);

    mounted.unmount();
    expect(host.textContent).toBe("");
  });

  test("renders assistant markdown with safe link attributes", () => {
    const host = document.createElement("div");

    mountConversationBodyIsland(host, {
      body: ["See [Tinybot](https://example.com)."],
      tone: "assistant",
    });

    const link = host.querySelector("a");
    expect(host.querySelector("p")?.textContent).toBe("See Tinybot.");
    expect(link?.getAttribute("href")).toBe("https://example.com");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noreferrer");
  });
});
