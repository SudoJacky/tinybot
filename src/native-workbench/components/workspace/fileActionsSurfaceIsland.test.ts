// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { mountFileActionsSurfaceIsland } from "./fileActionsSurfaceIsland";

describe("file actions surface Vue island", () => {
  test("renders chat session attachment controls only", () => {
    const host = document.createElement("section");

    const mounted = mountFileActionsSurfaceIsland(host, {
      activeSessionKey: "WebSocket:chat-live",
    });

    expect(host.className).toBe("desktop-file-actions");
    expect(host.getAttribute("data-desktop-vue-island")).toBe("file-actions-surface");
    expect(host.getAttribute("data-desktop-module-surface")).toBe("chat attachments");
    expect(host.querySelector(".n-card.desktop-file-actions-card")).not.toBeNull();
    expect(host.querySelector("h2")?.textContent).toBe("Session attachments");

    expect(host.querySelector("#desktop-knowledge-upload")).toBeNull();
    expect(host.querySelector("#desktop-session-file-upload")?.getAttribute("data-desktop-file-upload")).toBe("session-temporary-file");
    expect(host.querySelector("#desktop-workspace-file-drop")).toBeNull();
    expect(host.querySelector("#desktop-file-session-formats")?.textContent).toContain("png");

    const sessionKey = host.querySelector<HTMLInputElement>("#desktop-session-upload-key");
    expect(sessionKey?.value).toBe("WebSocket:chat-live");
    expect(sessionKey?.closest(".desktop-file-session-card")?.getAttribute("data-desktop-vue-island")).toBe("session-upload-card");
    expect(sessionKey?.getAttribute("readonly")).toBe("");
    expect(sessionKey?.getAttribute("data-active-session-key")).toBe("WebSocket:chat-live");
    expect(host.querySelector("#desktop-session-file-count")?.textContent).toContain("0");
    expect(host.querySelector("#desktop-session-files-refresh")?.getAttribute("data-desktop-session-files-refresh")).toBe("true");

    const operationStrip = host.querySelector(".desktop-file-operation-strip");
    expect(operationStrip?.querySelector(".desktop-file-operation-status")?.getAttribute("data-desktop-vue-island")).toBe("file-operation-status");
    expect(operationStrip?.textContent).toContain("Session upload");
    expect(operationStrip?.textContent).not.toContain("Knowledge upload");
    expect(operationStrip?.textContent).not.toContain("Workspace import");
    expect(host.querySelector("#desktop-file-upload-status")?.textContent).toBe("No file operation running.");
    expect(host.querySelector("#desktop-file-upload-status")?.getAttribute("data-desktop-vue-island")).toBe("file-upload-status");

    const sessionFiles = host.querySelector("#desktop-session-file-list");
    expect(sessionFiles?.getAttribute("data-desktop-vue-island")).toBe("session-file-list");
    expect(sessionFiles?.getAttribute("aria-label")).toBe("Session temporary files");
    expect(sessionFiles?.textContent).toContain("No temporary files attached to this session.");

    mounted.unmount();
    expect(host.textContent).toBe("");
  });
});
