// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { mountConversationAttachmentIsland } from "./conversationAttachmentIsland";

describe("conversation attachment Vue island", () => {
  test("renders attachment name and size", () => {
    const host = document.createElement("div");

    const mounted = mountConversationAttachmentIsland(host, {
      name: "tinybot_native_workbench_design.png",
      sizeLabel: "1.2 MB",
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("conversation-attachment");
    expect(host.className).toBe("desktop-conversation-attachment");
    expect(host.textContent).toBe("tinybot_native_workbench_design.png  1.2 MB");

    mounted.unmount();
    expect(host.textContent).toBe("");
  });

  test("renders attachment without a size label", () => {
    const host = document.createElement("div");

    mountConversationAttachmentIsland(host, {
      name: "notes.md",
      sizeLabel: "",
    });

    expect(host.textContent).toBe("notes.md");
  });
});
