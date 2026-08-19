// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatTimelineSnapshot } from "../../app-core/chat/agentTimelineModel";
import type { NativeThreadRecord } from "../../app-core/native/desktopNativeThreads";
import { createDesktopNativeEventBridge } from "./desktopNativeEventBridge";

type BridgeOptions = Parameters<typeof createDesktopNativeEventBridge>[0];

function nativeThread(threadId: string): NativeThreadRecord {
  return {
    threadId,
    title: threadId,
    status: "idle",
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
  };
}

function terminalTimeline(status: "completed" | "failed" | "interrupted"): ChatTimelineSnapshot {
  return {
    turns: [{ id: "turn-1", status }],
  } as unknown as ChatTimelineSnapshot;
}

function createHarness(threads: NativeThreadRecord[] = [nativeThread("thread-1")]) {
  const handlers = new Map<string, (event: { payload: unknown }) => void | Promise<void>>();
  const state: BridgeOptions["controller"]["state"] = {
    threads,
    activeThreadId: "",
    respondingThreadIds: new Set(),
    error: "",
  };
  const applyTimelinePatch = vi.fn(async () => null as ChatTimelineSnapshot | null);
  const loadSessions = vi.fn(async () => state.threads.length);
  const listen: BridgeOptions["listen"] = vi.fn(async (eventName, handler) => {
    handlers.set(eventName, handler);
    return () => handlers.delete(eventName);
  });
  const notifyAll = vi.fn<BridgeOptions["notifyAll"]>();
  const notifySession = vi.fn<BridgeOptions["notifySession"]>();
  const bridge = createDesktopNativeEventBridge({
    controller: { state, applyTimelinePatch, loadSessions },
    listen,
    notifyAll,
    notifySession,
  });
  return {
    applyTimelinePatch,
    bridge,
    handlers,
    loadSessions,
    notifyAll,
    notifySession,
    state,
  };
}

const browserSnapshot = {
  data: {
    activeTabId: "tab-1",
    browserSessionId: "browser-1",
    contract: "browser_session_v1",
    interaction: { click: true, navigate: true, type: true },
    kind: "browser_session",
    operationId: "operation-1",
    sessionId: "thread-1",
    state: "running",
    tabs: [{
      activeHistoryIndex: 0,
      captures: [],
      history: [{ url: "about:blank" }],
      loading: false,
      tabId: "tab-1",
      title: "New tab",
      url: "about:blank",
    }],
  },
  observedAt: "2026-08-15T00:00:00.000Z",
  revision: 1,
  sourceId: "native-browser:browser-1",
};

describe("desktop native event bridge", () => {
  beforeEach(() => {
    window.localStorage.setItem("tinybot.desktop.nativeDebug", "on");
    window.__tinybotNativeDebug = [];
    window.__tinybotNativeChatDebug = window.__tinybotNativeDebug;
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    window.localStorage.removeItem("tinybot.desktop.nativeDebug");
    delete window.__tinybotNativeDebug;
    delete window.__tinybotNativeChatDebug;
    vi.restoreAllMocks();
  });

  it("registers native event listeners and projects timeline outcomes once", async () => {
    const harness = createHarness([]);
    const timeline = terminalTimeline("completed");
    harness.loadSessions.mockImplementation(async () => {
      harness.state.threads = [nativeThread("thread-1")];
      return 1;
    });
    harness.applyTimelinePatch.mockResolvedValue(timeline);

    await harness.bridge.register();

    expect([...harness.handlers.keys()]).toEqual([
      "agent:timeline:patch",
      "agent:awaiting_form",
      "tinyos:browser-snapshot",
    ]);
    const timelineHandler = harness.handlers.get("agent:timeline:patch");
    await timelineHandler?.({ payload: { sessionId: "thread-1", turnId: "turn-1" } });
    await timelineHandler?.({ payload: { sessionId: "thread-1", turnId: "turn-1" } });

    expect(harness.loadSessions).toHaveBeenCalledTimes(1);
    expect(harness.notifyAll).toHaveBeenCalledWith({ type: "chat.created" });
    expect(harness.notifySession).toHaveBeenCalledWith("thread-1", { type: "timeline.patch", timeline });
    expect(harness.notifySession.mock.calls.filter(([, event]) => event.type === "agent.event")).toEqual([
      ["thread-1", { type: "agent.event", eventType: "agent.turn.completed" }],
    ]);

    await timelineHandler?.({ payload: { turnId: "turn-without-session" } });
    expect(harness.notifyAll).toHaveBeenCalledWith({
      type: "timeline.error",
      error: "Canonical timeline patch is missing sessionId",
    });
  });

  it("stores valid agent forms and makes malformed form events observable", async () => {
    const harness = createHarness();
    await harness.bridge.register();
    const formHandler = harness.handlers.get("agent:awaiting_form");

    await formHandler?.({
      payload: {
        formId: "form-1",
        traceContext: { threadId: "thread-1", turnId: "turn-1" },
        form: {
          title: "Choose a mode",
          fields: [{ name: "mode", type: "text", label: "Mode", required: true }],
        },
      },
    });

    expect(harness.bridge.listAgentUiForms("thread-1")).toEqual([
      expect.objectContaining({ form_id: "form-1", title: "Choose a mode" }),
    ]);
    expect(harness.notifySession).toHaveBeenCalledWith("thread-1", { type: "agent-ui.form" });

    await formHandler?.({ payload: { traceContext: { threadId: "thread-1" } } });
    expect(harness.notifyAll).toHaveBeenCalledWith({
      type: "agent-ui.form.error",
      error: "Native agent form event is missing formId.",
    });
  });

  it("projects browser snapshots with explicit error events", async () => {
    const harness = createHarness();
    await harness.bridge.register();

    await harness.handlers.get("tinyos:browser-snapshot")?.({ payload: browserSnapshot });
    expect(harness.notifySession).toHaveBeenCalledWith("thread-1", expect.objectContaining({
      type: "browser.snapshot",
      browserSnapshot: expect.objectContaining({ data: expect.objectContaining({ browserSessionId: "browser-1" }) }),
    }));

    await harness.handlers.get("tinyos:browser-snapshot")?.({ payload: null });
    expect(harness.notifyAll).toHaveBeenCalledWith({
      type: "browser.snapshot.error",
      error: "Native browser snapshot must be an object.",
    });

  });

  it("records correlated lifecycle stages without logging native payload content", async () => {
    const harness = createHarness();
    const timeline = terminalTimeline("completed");
    harness.applyTimelinePatch.mockResolvedValue(timeline);

    await harness.bridge.register();
    await harness.handlers.get("agent:timeline:patch")?.({
      payload: {
        sessionId: "thread-1",
        turnId: "turn-1",
        snapshotRevision: 4,
        item: {
          itemId: "item-1",
          kind: "assistant_message",
          status: "completed",
          content: "must not be logged",
        },
      },
    });
    await harness.handlers.get("tinyos:browser-snapshot")?.({ payload: null });

    expect(window.__tinybotNativeDebug?.map((entry) => entry.stage)).toEqual(expect.arrayContaining([
      "nativeEventBridge.register.start",
      "nativeEventBridge.register.complete",
      "nativeEventBridge.timelinePatch.received",
      "nativeEventBridge.timelinePatch.applied",
      "nativeEventBridge.timelinePatch.terminal",
      "nativeEventBridge.browserSnapshot.failed",
    ]));
    const received = window.__tinybotNativeDebug?.find((entry) => (
      entry.stage === "nativeEventBridge.timelinePatch.received"
    ));
    expect(received?.details).toEqual({
      itemId: "item-1",
      itemKind: "assistant_message",
      itemStatus: "completed",
      sessionId: "thread-1",
      snapshotRevision: 4,
      turnId: "turn-1",
    });
    expect(JSON.stringify(window.__tinybotNativeDebug)).not.toContain("must not be logged");
    expect(console.error).toHaveBeenCalledWith(
      "[tinybot-renderer]",
      "native.event_bridge.failed",
      expect.objectContaining({
        error: "Native browser snapshot must be an object.",
        stage: "browserSnapshot",
      }),
    );
  });
});
