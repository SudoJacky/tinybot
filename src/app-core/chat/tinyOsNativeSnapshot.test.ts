import { describe, expect, it } from "vitest";

import {
  createTinyOsBrowserCaptureSnapshot,
  createTinyOsBrowserSessionSnapshot,
  createTinyOsTerminalProcessSnapshot,
  createTinyOsWorkspaceResourceSnapshot,
} from "./tinyOsNativeSnapshot";

const metadata = {
  observedAt: "2026-07-14T01:02:03Z",
  revision: "revision-1",
  sourceId: "native-query-1",
};

describe("TinyOS native snapshot adapters", () => {
  it("adds version, revision, observation time, and native-query provenance", () => {
    const snapshot = createTinyOsWorkspaceResourceSnapshot({
      access: "read_only",
      kind: "workspace_resource",
      path: "src/main.ts",
      resourceKind: "file",
      workspaceKey: "workspace-1",
    }, metadata);

    expect(snapshot).toEqual({
      data: {
        access: "read_only",
        kind: "workspace_resource",
        path: "src/main.ts",
        resourceKind: "file",
        workspaceKey: "workspace-1",
      },
      observedAt: metadata.observedAt,
      provenance: {
        kind: "native_query",
        observedAt: metadata.observedAt,
        revision: metadata.revision,
        sourceId: metadata.sourceId,
      },
      revision: metadata.revision,
      schemaVersion: "tinybot.tinyos_native_snapshot.v1",
      sourceId: metadata.sourceId,
    });
  });

  it("distinguishes terminal observations and real browser captures", () => {
    const terminal = createTinyOsTerminalProcessSnapshot({
      kind: "terminal_process",
      nativeProcessId: "process-1",
      operationId: "run-1",
      sessionId: "session-1",
      state: "running",
      toolCallId: "call-1",
    }, { ...metadata, sourceId: "shell.list" });
    const capture = createTinyOsBrowserCaptureSnapshot({
      captureId: "capture-1",
      kind: "browser_capture",
      realCapture: true,
      title: "Home",
      url: "https://example.com",
    }, { ...metadata, sourceId: "browser.capture" });

    expect(terminal.provenance.kind).toBe("native_query");
    expect(terminal.data.executionContract).toBe("retained_execution_v1");
    expect(capture.provenance.kind).toBe("real_capture");
  });

  it("fails fast for missing revision, identity, or invalid observation time", () => {
    expect(() => createTinyOsWorkspaceResourceSnapshot({
      access: "read_only",
      kind: "workspace_resource",
      path: "src/main.ts",
      resourceKind: "file",
      workspaceKey: "workspace-1",
    }, { ...metadata, revision: "" })).toThrow(/revision is required/i);
    expect(() => createTinyOsTerminalProcessSnapshot({
      kind: "terminal_process",
      nativeProcessId: "",
      operationId: "run-1",
      sessionId: "session-1",
      state: "running",
    }, metadata)).toThrow(/process id is required/i);
    expect(() => createTinyOsTerminalProcessSnapshot({
      droppedBytes: -1,
      kind: "terminal_process",
      nativeProcessId: "process-1",
      operationId: "run-1",
      sessionId: "session-1",
      state: "running",
    }, metadata)).toThrow(/dropped bytes must be non-negative/i);
    expect(() => createTinyOsBrowserCaptureSnapshot({
      captureId: "capture-1",
      kind: "browser_capture",
      realCapture: false,
    }, { ...metadata, observedAt: "not-a-time" })).toThrow(/valid timestamp/i);
  });

  it("validates browser session tab, history, and current-capture identity", () => {
    const snapshot = createTinyOsBrowserSessionSnapshot({
      activeTabId: "tab-1",
      browserSessionId: "browser-session-1",
      contract: "browser_session_v1",
      interaction: { click: true, navigate: true, type: false },
      kind: "browser_session",
      operationId: "run-1",
      sessionId: "session-1",
      state: "running",
      tabs: [{
        activeHistoryIndex: 0,
        captures: [{ captureId: "capture-1", observedAt: metadata.observedAt, stale: false }],
        currentCaptureId: "capture-1",
        history: [{ captureId: "capture-1", observedAt: metadata.observedAt, title: "Home", url: "https://example.com" }],
        loading: false,
        tabId: "tab-1",
        title: "Home",
        url: "https://example.com",
      }],
    }, metadata);

    expect(snapshot.data.contract).toBe("browser_session_v1");
    expect(snapshot.data.tabs[0].currentCaptureId).toBe("capture-1");
    expect(snapshot.provenance.kind).toBe("native_query");

    expect(() => createTinyOsBrowserSessionSnapshot({
      ...snapshot.data,
      activeTabId: "tab-missing",
    }, metadata)).toThrow(/not present/i);
    expect(() => createTinyOsBrowserSessionSnapshot({
      ...snapshot.data,
      tabs: [{ ...snapshot.data.tabs[0], currentCaptureId: "capture-missing" }],
    }, metadata)).toThrow(/current capture.*missing/i);
  });
});
