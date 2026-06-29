// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { nextTick } from "vue";
import { mountSessionFileListIsland } from "./sessionFileListIsland";

describe("session temporary file list Vue island", () => {
  test("renders session file rows with the desktop runtime dataset contract", async () => {
    const host = document.createElement("div");

    const mounted = mountSessionFileListIsland(host, {
      sessionKey: "WebSocket:chat-1",
      rows: [{
        id: "file-1",
        name: "context.txt",
        status: "indexed",
        sizeBytes: 1536,
        mimeType: "text/plain",
        updatedAt: "2026-06-03T09:00:00.000Z",
        actions: ["download"],
      }],
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("session-file-list");
    expect(host.getAttribute("id")).toBe("desktop-session-file-list");
    expect(host.className).toContain("desktop-session-file-list");
    expect(host.getAttribute("aria-label")).toBe("Session temporary files");
    expect(host.dataset.sessionKey).toBe("WebSocket:chat-1");
    expect(host.dataset.fileCount).toBe("1");
    expect(host.textContent).toContain("context.txt - indexed / text/plain / 1.5 KiB / 2026-06-03T09:00:00.000Z - download");

    mounted.update({
      sessionKey: "WebSocket:chat-1",
      rows: [],
    });
    await nextTick();

    expect(host.dataset.fileCount).toBe("0");
    expect(host.textContent).toContain("No temporary files attached to this session.");

    mounted.unmount();
    expect(host.textContent).toBe("");
  });

  test("renders the no-session fallback", () => {
    const host = document.createElement("div");

    const mounted = mountSessionFileListIsland(host, {
      sessionKey: "",
      rows: [],
    });

    expect(host.dataset.sessionKey).toBe("");
    expect(host.dataset.fileCount).toBe("0");
    expect(host.textContent).toContain("Select a chat session to view temporary files.");

    mounted.unmount();
  });
});
