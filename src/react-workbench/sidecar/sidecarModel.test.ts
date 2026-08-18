import { describe, expect, it } from "vitest";
import {
  DEFAULT_SIDECAR_WIDTH,
  MIN_SIDECAR_WIDTH,
  SIDECAR_WIDTH_STORAGE_KEY,
  activeSidecarTab,
  createInitialSidecarState,
  readPersistedSidecarWidth,
  reduceSidecarState,
  sidecarArtifactTabId,
  visibleSidecarTabs,
  writePersistedSidecarWidth,
} from "./sidecarModel";

function scopedState(threadId = "thread-1", workspaceId = "D:/code/tinybot") {
  return reduceSidecarState(createInitialSidecarState(), {
    threadId,
    type: "scope.changed",
    workspaceId,
  });
}

describe("sidecar resource tabs", () => {
  it("creates browser and terminal resources in the current scope", () => {
    let state = scopedState();
    state = reduceSidecarState(state, { type: "tab.newBrowser" });
    state = reduceSidecarState(state, { type: "tab.newTerminal" });

    expect(state.presentation).toBe("docked");
    expect(visibleSidecarTabs(state).map((tab) => tab.kind)).toEqual(["browser", "terminal"]);
    expect(activeSidecarTab(state)).toMatchObject({ kind: "terminal", shell: "powershell" });
  });

  it("binds Sidecar browser resources one-to-one to native WebView2 tabs", () => {
    let state = scopedState();
    state = reduceSidecarState(state, { type: "tab.newBrowser" });
    const resourceId = state.activeTabId;

    state = reduceSidecarState(state, {
      activeNativeTabId: "native-tab-1",
      browserSessionId: "browser-session-1",
      tabs: [{ nativeTabId: "native-tab-1", title: "Tinybot Docs" }],
      threadId: "thread-1",
      type: "tab.syncBrowserSession",
    });

    expect(activeSidecarTab(state)).toMatchObject({
      browserSessionId: "browser-session-1",
      id: resourceId,
      kind: "browser",
      nativeTabId: "native-tab-1",
      title: "Tinybot Docs",
    });
  });

  it("adds Agent-created native tabs without nesting a second tab strip", () => {
    let state = scopedState();
    state = reduceSidecarState(state, { type: "tab.newBrowser" });
    state = reduceSidecarState(state, {
      activeNativeTabId: "native-tab-1",
      browserSessionId: "browser-session-1",
      tabs: [{ nativeTabId: "native-tab-1", title: "First" }],
      threadId: "thread-1",
      type: "tab.syncBrowserSession",
    });
    state = reduceSidecarState(state, {
      activeNativeTabId: "native-tab-2",
      browserSessionId: "browser-session-1",
      tabs: [
        { nativeTabId: "native-tab-1", title: "First" },
        { nativeTabId: "native-tab-2", title: "Second" },
      ],
      threadId: "thread-1",
      type: "tab.syncBrowserSession",
    });

    expect(visibleSidecarTabs(state).map((tab) => tab.title)).toEqual(["First", "Second"]);
    expect(activeSidecarTab(state)).toMatchObject({ nativeTabId: "native-tab-2" });
  });

  it("reuses the Sidecar resource identity when a failed native session restarts", () => {
    let state = scopedState();
    state = reduceSidecarState(state, { type: "tab.newBrowser" });
    const resourceId = state.activeTabId;
    state = reduceSidecarState(state, {
      activeNativeTabId: "native-tab-old",
      browserSessionId: "browser-session-old",
      tabs: [{ nativeTabId: "native-tab-old", title: "Old" }],
      threadId: "thread-1",
      type: "tab.syncBrowserSession",
    });
    state = reduceSidecarState(state, {
      activeNativeTabId: "native-tab-new",
      browserSessionId: "browser-session-new",
      tabs: [{ nativeTabId: "native-tab-new", title: "New" }],
      threadId: "thread-1",
      type: "tab.syncBrowserSession",
    });

    expect(activeSidecarTab(state)).toMatchObject({
      browserSessionId: "browser-session-new",
      id: resourceId,
      nativeTabId: "native-tab-new",
      title: "New",
    });
  });

  it("opens one contextual artifact tab and reuses it", () => {
    let state = scopedState();
    const event = {
      artifactId: "chart-1",
      threadId: "thread-1",
      title: "Quarterly revenue",
      type: "tab.openArtifact" as const,
    };
    state = reduceSidecarState(state, event);
    state = reduceSidecarState(state, event);

    expect(visibleSidecarTabs(state)).toEqual([expect.objectContaining({
      id: sidecarArtifactTabId("thread-1", "chart-1"),
      kind: "artifact",
    })]);
  });

  it("keeps resources while hiding scopes and restores them when the scope returns", () => {
    let state = scopedState();
    state = reduceSidecarState(state, { type: "tab.newBrowser" });
    state = reduceSidecarState(state, { type: "tab.newTerminal" });
    const originalIds = visibleSidecarTabs(state).map((tab) => tab.id);

    state = reduceSidecarState(state, {
      threadId: "thread-2",
      type: "scope.changed",
      workspaceId: "D:/code/tinybot",
    });
    expect(visibleSidecarTabs(state).map((tab) => tab.kind)).toEqual(["terminal"]);

    state = reduceSidecarState(state, {
      threadId: "thread-3",
      type: "scope.changed",
      workspaceId: "D:/code/other",
    });
    expect(visibleSidecarTabs(state)).toEqual([]);

    state = reduceSidecarState(state, {
      threadId: "thread-1",
      type: "scope.changed",
      workspaceId: "D:/code/tinybot",
    });
    expect(visibleSidecarTabs(state).map((tab) => tab.id)).toEqual(originalIds);
  });

  it("closes the active tab and activates its nearest visible neighbour", () => {
    let state = scopedState();
    state = reduceSidecarState(state, { type: "tab.newBrowser" });
    const browserId = state.activeTabId;
    state = reduceSidecarState(state, { type: "tab.newTerminal" });

    state = reduceSidecarState(state, { tabId: state.activeTabId, type: "tab.close" });

    expect(state.activeTabId).toBe(browserId);
    expect(activeSidecarTab(state)?.kind).toBe("browser");
  });

  it("hides presentation without destroying resources", () => {
    let state = scopedState();
    state = reduceSidecarState(state, { type: "tab.newTerminal" });
    state = reduceSidecarState(state, { type: "presentation.hide" });

    expect(state.presentation).toBe("closed");
    expect(state.tabs).toHaveLength(1);

    state = reduceSidecarState(state, { type: "presentation.show" });
    expect(state.presentation).toBe("docked");
    expect(activeSidecarTab(state)?.kind).toBe("terminal");
  });

  it("clamps and persists the docked width", () => {
    let state = scopedState();
    state = reduceSidecarState(state, {
      maxWidth: 720,
      type: "presentation.resize",
      width: 999,
    });
    expect(state.width).toBe(720);
    state = reduceSidecarState(state, {
      maxWidth: 720,
      type: "presentation.resize",
      width: 100,
    });
    expect(state.width).toBe(MIN_SIDECAR_WIDTH);

    const values = new Map<string, string>();
    writePersistedSidecarWidth({ setItem: (key, value) => values.set(key, value) }, 512.4);
    expect(values.get(SIDECAR_WIDTH_STORAGE_KEY)).toBe("512");
    expect(readPersistedSidecarWidth({ getItem: (key) => values.get(key) ?? null })).toBe(512);
    expect(readPersistedSidecarWidth({ getItem: () => "invalid" })).toBe(DEFAULT_SIDECAR_WIDTH);
  });
});
