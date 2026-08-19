// @vitest-environment happy-dom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTinyOsBrowserSessionSnapshot } from "../../app-core/chat/tinyOsNativeSnapshot";
import type { NativeBrowserRuntimeApi } from "../../app-core/native/desktopNativeBrowser";
import { normalizeBrowserAddress, SidecarBrowser } from "./SidecarBrowser";
import type { SidecarBrowserTab } from "./sidecarModel";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function browserSnapshot(
  controlState: "idle" | "user_required" = "idle",
  lifecycle: "creating" | "ready" = "ready",
) {
  return createTinyOsBrowserSessionSnapshot({
    activeTabId: "native-tab-1",
    browserSessionId: "browser-session-1",
    contract: "browser_session_v1",
    control: { controlEpoch: 3, state: controlState },
    interaction: { click: true, navigate: true, type: true },
    kind: "browser_session",
    lifecycle,
    operationId: "operation-1",
    profilePersistence: "persistent",
    runtimeKind: "windows_webview2",
    runtimeVersion: "test",
    sessionId: "thread-1",
    state: "running",
    surface: { layoutRevision: 4, lifecycle: "hidden" },
    tabs: [{
      activeHistoryIndex: 0,
      canGoBack: false,
      canGoForward: false,
      captures: [],
      history: [{ title: "Example", url: "https://example.com" }],
      loading: lifecycle === "creating",
      rendererLifecycle: lifecycle === "creating" ? "starting" : "running",
      tabId: "native-tab-1",
      title: "Example",
      url: "https://example.com",
    }],
  }, {
    observedAt: "2026-08-18T08:00:00Z",
    revision: 5,
    sourceId: "native-browser:browser-session-1",
  });
}

function browserRuntime(snapshot = browserSnapshot()) {
  return {
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
}

const resource: SidecarBrowserTab = {
  browserSessionId: "browser-session-1",
  id: "sidecar-browser-1",
  kind: "browser",
  nativeTabId: "native-tab-1",
  threadId: "thread-1",
  title: "Example",
};

function renderBrowser(overrides: Partial<Parameters<typeof SidecarBrowser>[0]> = {}) {
  const snapshot = browserSnapshot();
  const runtime = browserRuntime(snapshot);
  const props: Parameters<typeof SidecarBrowser>[0] = {
    browserRuntime: runtime,
    onHandoffComplete: vi.fn(),
    onRetryProvision: vi.fn(),
    onSnapshot: vi.fn(),
    snapshot,
    surfaceVisible: false,
    tab: resource,
    ...overrides,
  };
  return { props, runtime, ...render(<SidecarBrowser {...props} />) };
}

describe("SidecarBrowser", () => {
  it("normalizes web addresses without treating search text as a URL", () => {
    expect(normalizeBrowserAddress("localhost:5173/chat", "empty", "invalid")).toBe("http://localhost:5173/chat");
    expect(normalizeBrowserAddress("tinybot.dev", "empty", "invalid")).toBe("https://tinybot.dev");
    expect(() => normalizeBrowserAddress("search words", "empty", "invalid")).toThrow("invalid");
  });

  it("navigates the bound native WebView2 tab from the address bar", async () => {
    const user = userEvent.setup();
    const { runtime } = renderBrowser();

    const address = screen.getByRole("textbox", { name: "Browser address" });
    await user.clear(address);
    await user.type(address, "tinybot.dev");
    await user.click(screen.getByRole("button", { name: "Go" }));

    expect(runtime.navigate).toHaveBeenCalledWith(
      "browser-session-1",
      "native-tab-1",
      "https://tinybot.dev",
    );
  });

  it("returns a protected browser handoff to Agent explicitly", async () => {
    const user = userEvent.setup();
    const snapshot = browserSnapshot("user_required");
    const runtime = browserRuntime(snapshot);
    const onHandoffComplete = vi.fn();
    renderBrowser({ browserRuntime: runtime, onHandoffComplete, snapshot });

    await user.click(screen.getByRole("button", { name: "Return to Agent" }));

    expect(runtime.interact).toHaveBeenCalledWith(expect.objectContaining({
      action: { type: "resume" },
      browserSessionId: "browser-session-1",
      controlEpoch: 3,
      tabId: "native-tab-1",
    }));
    expect(onHandoffComplete).toHaveBeenCalledOnce();
  });

  it("reports the measured Sidecar slot to the native surface runtime", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      bottom: 580,
      height: 480,
      left: 720,
      right: 1120,
      toJSON: () => ({}),
      top: 100,
      width: 400,
      x: 720,
      y: 100,
    });
    const { runtime } = renderBrowser({ surfaceVisible: true });

    await waitFor(() => expect(runtime.updateSurface).toHaveBeenCalledWith(expect.objectContaining({
      browserSessionId: "browser-session-1",
      rect: expect.objectContaining({ height: 480, width: 400, x: 720, y: 100 }),
      tabId: "native-tab-1",
      visible: true,
    })), { timeout: 800 });
  });

  it("waits for a Creating native session before attaching its visible surface", async () => {
    vi.useFakeTimers();
    const creatingSnapshot = browserSnapshot("idle", "creating");
    const readySnapshot = browserSnapshot();
    const runtime = browserRuntime(readySnapshot);
    const rendered = renderBrowser({
      browserRuntime: runtime,
      snapshot: creatingSnapshot,
      surfaceVisible: true,
    });

    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(runtime.updateSurface).not.toHaveBeenCalled();

    rendered.rerender(<SidecarBrowser {...rendered.props} snapshot={readySnapshot} />);
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(runtime.updateSurface).toHaveBeenCalledWith(expect.objectContaining({ visible: true }));
  });
});
