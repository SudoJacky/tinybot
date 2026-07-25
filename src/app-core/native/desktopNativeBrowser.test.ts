import { describe, expect, it, vi } from "vitest";
import { createDesktopNativeBrowserApi, normalizeNativeBrowserSnapshot } from "./desktopNativeBrowser";

const snapshot = {
  data: {
    activeTabId: "tab-1",
    browserSessionId: "browser-1",
    contract: "browser_session_v1",
    interaction: { click: true, navigate: true, type: true },
    kind: "browser_session",
    operationId: "turn-1",
    sessionId: "thread-1",
    state: "running",
    tabs: [{ activeHistoryIndex: 0, captures: [], history: [{ url: "about:blank" }], loading: false, tabId: "tab-1", title: "New tab", url: "about:blank" }],
  },
  observedAt: "2026-07-15T00:00:00Z",
  revision: 1,
  schemaVersion: "tinybot.tinyos_native_snapshot.v1",
  sourceId: "native-browser:browser-1",
};

describe("desktopNativeBrowser", () => {
  it("normalizes the backend-authored browser snapshot", () => {
    expect(normalizeNativeBrowserSnapshot(snapshot).data.browserSessionId).toBe("browser-1");
  });

  it("routes all native operations through the wrapper input contract", async () => {
    const invokeMock = vi.fn(async () => snapshot);
    const api = createDesktopNativeBrowserApi({
      invoke: invokeMock as unknown as Parameters<typeof createDesktopNativeBrowserApi>[0]["invoke"],
    });
    await api.navigate("browser-1", "tab-1", "https://example.com");
    expect(invokeMock).toHaveBeenCalledWith("browser_navigate", {
      input: { browserSessionId: "browser-1", tabId: "tab-1", url: "https://example.com" },
    });
    await api.restartTab("browser-1", "tab-1");
    expect(invokeMock).toHaveBeenCalledWith("browser_restart_tab", {
      input: { browserSessionId: "browser-1", tabId: "tab-1" },
    });
    await api.resolvePolicyRequest("browser-1", "policy-1", true);
    expect(invokeMock).toHaveBeenCalledWith("browser_resolve_policy_request", {
      input: { approved: true, browserSessionId: "browser-1", requestId: "policy-1" },
    });
    await api.deleteProfile("profile-1");
    expect(invokeMock).toHaveBeenCalledWith("browser_delete_profile", {
      input: { profileId: "profile-1" },
    });
  });
});
