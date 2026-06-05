// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { mountFileActionsSurfaceIsland } from "./fileActionsSurfaceIsland";

describe("file actions surface Vue island", () => {
  test("renders import cards, session upload state, operation status, and session file list", () => {
    const host = document.createElement("section");

    const mounted = mountFileActionsSurfaceIsland(host, {
      activeSessionKey: "WebSocket:chat-live",
    });

    expect(host.className).toBe("desktop-file-actions");
    expect(host.getAttribute("data-desktop-vue-island")).toBe("file-actions-surface");
    expect(host.getAttribute("data-desktop-module-surface")).toBe("workspace knowledge");
    expect(host.querySelector("h2")?.textContent).toBe("File imports");

    expect(host.querySelector("#desktop-knowledge-upload")?.getAttribute("data-desktop-file-upload")).toBe("knowledge-document");
    expect(host.querySelector("#desktop-session-file-upload")?.getAttribute("data-desktop-file-upload")).toBe("session-temporary-file");
    expect(host.querySelector("#desktop-workspace-file-drop")?.getAttribute("href")).toBe("/workspace");
    expect(host.querySelector("#desktop-file-session-formats")?.textContent).toContain("png");

    const sessionKey = host.querySelector<HTMLInputElement>("#desktop-session-upload-key");
    expect(sessionKey?.value).toBe("WebSocket:chat-live");
    expect(sessionKey?.getAttribute("readonly")).toBe("");
    expect(sessionKey?.getAttribute("data-active-session-key")).toBe("WebSocket:chat-live");
    expect(host.querySelector("#desktop-session-file-count")?.textContent).toContain("0");
    expect(host.querySelector("#desktop-session-files-refresh")?.getAttribute("data-desktop-session-files-refresh")).toBe("true");

    const operationStrip = host.querySelector(".desktop-file-operation-strip");
    expect(operationStrip?.textContent).toContain("Knowledge upload");
    expect(operationStrip?.textContent).toContain("Session upload");
    expect(operationStrip?.textContent).toContain("Workspace import");
    expect(host.querySelector("#desktop-file-upload-status")?.textContent).toBe("No file operation running.");

    const sessionFiles = host.querySelector("#desktop-session-file-list");
    expect(sessionFiles?.getAttribute("aria-label")).toBe("Session temporary files");
    expect(sessionFiles?.textContent).toContain("Temporary files not loaded yet.");

    mounted.unmount();
    expect(host.textContent).toBe("");
  });
});
