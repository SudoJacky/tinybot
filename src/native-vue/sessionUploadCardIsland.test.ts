// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { mountSessionUploadCardIsland } from "./sessionUploadCardIsland";

describe("session upload card Vue island", () => {
  test("renders active session upload key and refresh controls", () => {
    const host = document.createElement("div");

    const mounted = mountSessionUploadCardIsland(host, {
      activeSessionKey: "WebSocket:chat-live",
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("session-upload-card");
    expect(host.className).toContain("desktop-file-session-card");
    expect(host.textContent).toContain("Session key");
    expect(host.textContent).toContain("Temporary files");

    const input = host.querySelector<HTMLInputElement>("#desktop-session-upload-key");
    expect(input?.className).toContain("desktop-session-upload-key");
    expect(input?.getAttribute("aria-label")).toBe("Session key for temporary file upload");
    expect(input?.getAttribute("placeholder")).toBe("Session key");
    expect(input?.getAttribute("readonly")).toBe("");
    expect(input?.getAttribute("data-active-session-key")).toBe("WebSocket:chat-live");
    expect(input?.value).toBe("WebSocket:chat-live");

    expect(host.querySelector("#desktop-session-file-count")?.textContent).toBe("0");
    expect(host.querySelector("#desktop-session-files-refresh")?.getAttribute("data-desktop-session-files-refresh")).toBe("true");

    mounted.unmount();
    expect(host.textContent).toBe("");
  });

  test("renders editable session key when no active session is available", () => {
    const host = document.createElement("div");

    const mounted = mountSessionUploadCardIsland(host, {});

    const input = host.querySelector<HTMLInputElement>("#desktop-session-upload-key");
    expect(input?.value).toBe("");
    expect(input?.getAttribute("readonly")).toBeNull();
    expect(input?.getAttribute("data-active-session-key")).toBeNull();

    mounted.unmount();
  });
});
