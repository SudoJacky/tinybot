// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { TFunction } from "i18next";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TinyOsKernelSnapshot } from "../../app-core/chat/tinyOsKernelModel";
import { createTinyOsBrowserSessionSnapshot } from "../../app-core/chat/tinyOsNativeSnapshot";
import type { NativeBrowserRuntimeApi } from "../../app-core/native/desktopNativeBrowser";
import { normalizeBrowserAddress, TinyOsBrowserApp } from "./TinyOsBrowserApp";

afterEach(cleanup);

function browserSnapshot() {
  return createTinyOsBrowserSessionSnapshot({
    activeTabId: "tab-1",
    browserSessionId: "browser-1",
    contract: "browser_session_v1",
    control: { controlEpoch: 2, state: "idle" },
    interaction: { click: true, navigate: true, type: true },
    kind: "browser_session",
    operationId: "operation-1",
    profilePersistence: "persistent",
    runtimeKind: "windows_webview2",
    runtimeVersion: "test-runtime",
    sessionId: "session-1",
    state: "running",
    tabs: [{
      activeHistoryIndex: 0,
      captures: [{ captureId: "capture-1", observedAt: "2026-08-15T00:00:00Z", stale: false }],
      currentCaptureId: "capture-1",
      history: [{ captureId: "capture-1", title: "Example", url: "https://example.com" }],
      loading: false,
      rendererLifecycle: "running",
      tabId: "tab-1",
      title: "Example",
      url: "https://example.com",
    }, {
      activeHistoryIndex: 0,
      captures: [{ captureId: "capture-2", observedAt: "2026-08-15T00:01:00Z", stale: false }],
      currentCaptureId: "capture-2",
      history: [{ captureId: "capture-2", title: "Second", url: "https://example.org" }],
      loading: false,
      rendererLifecycle: "running",
      tabId: "tab-2",
      title: "Second",
      url: "https://example.org",
    }],
  }, {
    observedAt: "2026-08-15T00:01:00Z",
    revision: "browser-revision-1",
    sourceId: "browser.session",
  });
}

function kernel(): TinyOsKernelSnapshot {
  const snapshot = browserSnapshot();
  return {
    agentGroups: [],
    browserSessions: [{
      ...snapshot.data,
      observedAt: snapshot.observedAt,
      provenance: snapshot.provenance,
      revision: snapshot.revision,
    }],
    capabilities: [],
    cursor: { eventCount: 0, eventIndex: 0, mode: "live" },
    discrepancies: [],
    metrics: [],
    notifications: [],
    processes: [],
    resources: [],
    truth: "derived",
  };
}

function browserRuntime(snapshot = browserSnapshot()) {
  const api = {
    activateTab: vi.fn(async () => snapshot),
    back: vi.fn(async () => undefined),
    capabilities: vi.fn(),
    closeSession: vi.fn(async () => undefined),
    closeTab: vi.fn(async () => snapshot),
    createSession: vi.fn(async () => snapshot),
    createTab: vi.fn(async () => snapshot),
    deleteProfile: vi.fn(async () => undefined),
    forward: vi.fn(async () => undefined),
    interact: vi.fn(async () => undefined),
    navigate: vi.fn(async () => snapshot),
    observe: vi.fn(),
    reload: vi.fn(async () => undefined),
    resolvePolicyRequest: vi.fn(async () => snapshot),
    restartTab: vi.fn(async () => snapshot),
    snapshot: vi.fn(async () => snapshot),
    stop: vi.fn(async () => undefined),
    updateSurface: vi.fn(async () => snapshot),
  } as unknown as NativeBrowserRuntimeApi;
  return api;
}

describe("TinyOS browser app", () => {
  it("owns tab activation and address navigation behind its runtime interface", async () => {
    const runtime = browserRuntime();
    const user = userEvent.setup();
    render(<TinyOsBrowserApp browserRuntime={runtime} kernel={kernel()} onHandoffComplete={vi.fn()} surfaceVisible={false} />);

    await user.click(screen.getByRole("tab", { name: "Second" }));
    expect(runtime.activateTab).toHaveBeenCalledWith("browser-1", "tab-2");

    const address = screen.getByRole("textbox", { name: "Browser address" });
    await user.clear(address);
    await user.type(address, "tinybot.dev");
    await user.click(screen.getByRole("button", { name: "Go" }));
    expect(runtime.navigate).toHaveBeenCalledWith("browser-1", "tab-2", "https://tinybot.dev");
  });

  it("keeps address normalization explicit and rejects search-like input", () => {
    const t = ((key: string) => key) as unknown as TFunction<"tinyos">;
    expect(normalizeBrowserAddress("localhost:5173/chat", t)).toBe("http://localhost:5173/chat");
    expect(normalizeBrowserAddress("example.com", t)).toBe("https://example.com");
    expect(() => normalizeBrowserAddress("not an address", t)).toThrow("shell.browser.invalidAddress");
  });
});
