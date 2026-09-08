// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { createNativeBrowserSessionSnapshot } from "../../app-core/native/nativeBrowserSnapshot";
import type { ChatEvent } from "../services";
import { useSidecarBrowserState } from "./useSidecarBrowserState";
afterEach(cleanup);
  test("does not replace a newer visible Browser snapshot with a stale hidden response", async () => {
    let listener: ((event: ChatEvent) => void) | undefined;
    const store = {
      subscribe: vi.fn((_sessionId: string, nextListener: (event: ChatEvent) => void) => {
        listener = nextListener;
        return vi.fn();
      }),
    };
    const { result } = renderHook(() => useSidecarBrowserState(store, "session-1"));

    act(() => listener?.({
      browserSnapshot: nativeBrowserSnapshot(3, "visible"),
      type: "browser.snapshot",
    }));
    await waitFor(() => expect(result.current.state.browserSnapshot?.data.surface?.lifecycle).toBe("visible"));
    act(() => listener?.({
      browserSnapshot: nativeBrowserSnapshot(2, "hidden"),
      type: "browser.snapshot",
    }));

    expect(result.current.state.browserSnapshot?.data.surface?.lifecycle).toBe("visible");
    expect(result.current.state.browserSnapshot?.revision).toBe(3);
  });

function nativeBrowserSnapshot(revision: number, surfaceLifecycle: "hidden" | "visible") {
  return createNativeBrowserSessionSnapshot({
    activeTabId: "browser-tab-1",
    browserSessionId: "browser-session-1",
    contract: "browser_session_v1",
    interaction: { click: true, navigate: true, type: true },
    kind: "browser_session",
    lifecycle: "ready",
    operationId: "browser-operation-1",
    runtimeKind: "windows_webview2",
    sessionId: "session-1",
    state: "running",
    surface: { layoutRevision: revision, lifecycle: surfaceLifecycle },
    tabs: [{
      activeHistoryIndex: 0,
      captures: [],
      history: [{ title: "Example", url: "https://example.com" }],
      loading: false,
      rendererLifecycle: "running",
      tabId: "browser-tab-1",
      title: "Example",
      url: "https://example.com",
    }],
  }, {
    observedAt: "2026-08-18T08:00:00Z",
    revision,
    sourceId: "native-browser:browser-session-1",
  });
}
