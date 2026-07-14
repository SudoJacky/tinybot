import { describe, expect, it } from "vitest";

import type { TinyOsNativeBrowserSession } from "./tinyOsNativeSnapshot";
import { validateTinyOsBrowserInteractionTarget } from "./tinyOsBrowserSession";

function session(): TinyOsNativeBrowserSession {
  return {
    activeTabId: "tab-1",
    browserSessionId: "browser-1",
    contract: "browser_session_v1",
    interaction: { click: true, navigate: true, type: true },
    kind: "browser_session",
    runId: "run-1",
    sessionId: "session-1",
    state: "running",
    tabs: [{
      activeHistoryIndex: 1,
      captures: [
        { captureId: "capture-old", observedAt: "2026-07-14T01:00:00Z", stale: true },
        { captureId: "capture-current", observedAt: "2026-07-14T01:01:00Z", stale: false },
      ],
      currentCaptureId: "capture-current",
      history: [{ url: "https://example.com" }, { captureId: "capture-current", url: "https://example.com/current" }],
      loading: false,
      tabId: "tab-1",
      title: "Current",
      url: "https://example.com/current",
    }],
  };
}

describe("TinyOS browser interaction target", () => {
  it("accepts only the current compatible capture", () => {
    expect(validateTinyOsBrowserInteractionTarget(session(), {
      browserSessionId: "browser-1",
      captureId: "capture-current",
      tabId: "tab-1",
    }).status).toBe("accepted");
  });

  it("preserves stale evidence and returns the current capture for recovery", () => {
    expect(validateTinyOsBrowserInteractionTarget(session(), {
      browserSessionId: "browser-1",
      captureId: "capture-old",
      tabId: "tab-1",
    })).toMatchObject({
      currentCapture: { captureId: "capture-current" },
      reasonCode: "capture_stale",
      status: "rejected",
    });
  });

  it("rejects missing sessions and tabs without inventing recovery state", () => {
    expect(validateTinyOsBrowserInteractionTarget(undefined, {
      browserSessionId: "browser-1",
      captureId: "capture-current",
      tabId: "tab-1",
    })).toMatchObject({ reasonCode: "session_mismatch", status: "rejected" });
    expect(validateTinyOsBrowserInteractionTarget(session(), {
      browserSessionId: "browser-1",
      captureId: "capture-current",
      tabId: "tab-missing",
    })).toMatchObject({ reasonCode: "tab_missing", status: "rejected" });
  });
});
