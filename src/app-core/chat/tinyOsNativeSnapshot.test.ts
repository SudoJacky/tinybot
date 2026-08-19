import { describe, expect, it } from "vitest";
import { createTinyOsBrowserSessionSnapshot } from "./tinyOsNativeSnapshot";

const metadata = {
  observedAt: "2026-07-14T01:02:03Z",
  revision: "revision-1",
  sourceId: "native-query-1",
};

describe("native browser snapshot adapter", () => {
  it("validates browser session identity and adds snapshot metadata", () => {
    const snapshot = createTinyOsBrowserSessionSnapshot({
      activeTabId: "tab-1",
      browserSessionId: "browser-session-1",
      contract: "browser_session_v1",
      interaction: { click: true, navigate: true, type: false },
      kind: "browser_session",
      operationId: "turn-1",
      sessionId: "session-1",
      state: "running",
      tabs: [{
        activeHistoryIndex: 0,
        captures: [{ captureId: "capture-1", observedAt: metadata.observedAt, stale: false }],
        currentCaptureId: "capture-1",
        history: [{
          captureId: "capture-1",
          observedAt: metadata.observedAt,
          title: "Home",
          url: "https://example.com",
        }],
        loading: false,
        tabId: "tab-1",
        title: "Home",
        url: "https://example.com",
      }],
    }, metadata);

    expect(snapshot).toMatchObject({
      observedAt: metadata.observedAt,
      provenance: {
        kind: "native_query",
        revision: metadata.revision,
        sourceId: metadata.sourceId,
      },
      revision: metadata.revision,
      schemaVersion: "tinybot.tinyos_native_snapshot.v1",
    });
    expect(snapshot.data.tabs[0].currentCaptureId).toBe("capture-1");

    expect(() => createTinyOsBrowserSessionSnapshot({
      ...snapshot.data,
      activeTabId: "tab-missing",
    }, metadata)).toThrow(/not present/i);
    expect(() => createTinyOsBrowserSessionSnapshot({
      ...snapshot.data,
      tabs: [{ ...snapshot.data.tabs[0], currentCaptureId: "capture-missing" }],
    }, metadata)).toThrow(/current capture.*missing/i);
    expect(() => createTinyOsBrowserSessionSnapshot(snapshot.data, {
      ...metadata,
      observedAt: "not-a-time",
    })).toThrow(/valid timestamp/i);
  });
});
