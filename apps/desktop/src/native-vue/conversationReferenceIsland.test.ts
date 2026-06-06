// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { mountConversationReferenceIsland } from "./conversationReferenceIsland";

describe("conversation reference Vue island", () => {
  test("renders kind title and detail", () => {
    const host = document.createElement("p");

    const mounted = mountConversationReferenceIsland(host, {
      detail: "lines 10-20",
      kind: "File",
      title: "desktopWorkbenchShell.ts",
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("conversation-reference");
    expect(host.className).toBe("desktop-conversation-reference");
    expect(host.textContent).toBe("File: desktopWorkbenchShell.ts - lines 10-20");

    mounted.unmount();
    expect(host.textContent).toBe("");
  });

  test("omits separator when detail is empty", () => {
    const host = document.createElement("p");

    mountConversationReferenceIsland(host, {
      detail: "",
      kind: "Document",
      title: "README.md",
    });

    expect(host.textContent).toBe("Document: README.md");
  });
});
