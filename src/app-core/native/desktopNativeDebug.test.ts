// @vitest-environment happy-dom

import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createDesktopNativeStartupTrace,
  logDesktopNativeDebug,
  traceDesktopNativeDebugAsync,
} from "./desktopNativeChatDebug";

describe("desktop native debug logger", () => {
  afterEach(() => {
    window.localStorage.clear();
    window.__tinybotNativeDebug = [];
    window.__tinybotNativeChatDebug = [];
    vi.restoreAllMocks();
  });

  test("is disabled by default outside explicit opt-in", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    logDesktopNativeDebug("nativeWebSocket.agentEvent.received", {
      eventName: "agent.delta",
    });

    expect(window.__tinybotNativeDebug).toBeUndefined();
    expect(info).not.toHaveBeenCalled();
  });

  test("stores sanitized native debug entries behind the localStorage switch", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    window.localStorage.setItem("tinybot.desktop.nativeDebug", "on");

    logDesktopNativeDebug("session.delete.start", {
      longText: "x".repeat(540),
      manyItems: Array.from({ length: 20 }, (_, index) => index),
      nested: { value: "ready" },
    });

    expect(window.__tinybotNativeDebug).toHaveLength(1);
    expect(window.__tinybotNativeChatDebug).toBe(window.__tinybotNativeDebug);
    expect(window.__tinybotNativeDebug?.[0]).toMatchObject({
      stage: "session.delete.start",
      details: {
        longText: `${"x".repeat(500)}...`,
        manyItems: Array.from({ length: 12 }, (_, index) => index),
        nested: { value: "ready" },
      },
    });
    expect(info).toHaveBeenCalledWith("[Tinybot native]", "session.delete.start", window.__tinybotNativeDebug?.[0]?.details);
  });

  test("records startup trace phase timings", () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    window.localStorage.setItem("tinybot.desktop.nativeDebug", "on");
    const times = [0, 5, 10, 40, 50, 80];
    const trace = createDesktopNativeStartupTrace({
      now: () => times.shift() ?? 220.3,
    });

    trace.mark("dom.ready", { mode: "native" });
    trace.start("runtimeReady");
    trace.complete("runtimeReady", { state: "running" });
    trace.start("chatRuntime");
    trace.fail("chatRuntime", new Error("slow chat"));

    expect(window.__tinybotNativeDebug?.map((entry) => entry.stage)).toEqual([
      "startup.dom.ready",
      "startup.runtimeReady.start",
      "startup.runtimeReady.complete",
      "startup.chatRuntime.start",
      "startup.chatRuntime.failed",
    ]);
    expect(window.__tinybotNativeDebug?.[2].details).toMatchObject({
      durationMs: 30,
      sinceStartMs: 40,
      state: "running",
    });
    expect(window.__tinybotNativeDebug?.[4].details).toMatchObject({
      durationMs: 30,
      sinceStartMs: 80,
      error: "slow chat",
    });
  });

  test("records async debug phase durations", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    window.localStorage.setItem("tinybot.desktop.nativeDebug", "on");
    const times = [10, 52.24];

    const result = await traceDesktopNativeDebugAsync(
      "toolsSkills.load.tools.list",
      async () => ({ count: 24 }),
      { source: "startup" },
      { now: () => times.shift() ?? 52.24 },
    );

    expect(result).toEqual({ count: 24 });
    expect(window.__tinybotNativeDebug?.map((entry) => entry.stage)).toEqual([
      "toolsSkills.load.tools.list.start",
      "toolsSkills.load.tools.list.complete",
    ]);
    expect(window.__tinybotNativeDebug?.[1].details).toMatchObject({
      durationMs: 42.2,
      source: "startup",
    });
  });

});
