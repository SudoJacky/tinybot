// @vitest-environment happy-dom

import { afterEach, describe, expect, test, vi } from "vitest";
import { createRendererLogger } from "./rendererLogger";

describe("renderer logger", () => {
  afterEach(() => {
    delete (globalThis as typeof globalThis & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    window.localStorage.clear();
    window.__tinybotRendererLogs = [];
    window.__tinybotNativeDebug = [];
    window.__tinybotNativeChatDebug = [];
    vi.restoreAllMocks();
  });

  test("keeps debug logs opt-in while collecting warnings by default", () => {
    const consoleSink = {
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    };
    const logger = createRendererLogger({ console: consoleSink });

    logger.log("debug", "native.socket.received", { eventName: "agent.delta" });
    logger.log("warn", "native.socket.invalid", { eventName: "unknown" });

    expect(window.__tinybotRendererLogs).toHaveLength(1);
    expect(window.__tinybotRendererLogs?.[0]).toMatchObject({
      level: "warn",
      stage: "native.socket.invalid",
    });
    expect(consoleSink.info).not.toHaveBeenCalled();
    expect(consoleSink.warn).toHaveBeenCalledOnce();
  });

  test("redacts secrets and bounds retained context", () => {
    const logger = createRendererLogger({
      console: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
      now: () => "2026-08-16T01:02:03.000Z",
    });

    logger.log("error", "provider.request.failed", {
      apiKey: "must-not-leak",
      longValue: "x".repeat(540),
      nested: { authorization: "Bearer must-not-leak", state: "failed" },
      promptPreview: "private prompt",
    });

    expect(window.__tinybotRendererLogs?.[0]).toEqual({
      schemaVersion: "tinybot.renderer_log.v1",
      at: "2026-08-16T01:02:03.000Z",
      level: "error",
      stage: "provider.request.failed",
      details: {
        apiKey: "[redacted]",
        longValue: `${"x".repeat(500)}...`,
        nested: { authorization: "[redacted]", state: "failed" },
        promptPreview: "[redacted]",
      },
    });
  });

  test("persists warnings and errors through the native log command", async () => {
    const invoke = vi.fn(async () => undefined);
    const logger = createRendererLogger({
      console: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
      invoke,
      isNativeRuntime: () => true,
    });

    logger.log("error", "native.event_bridge.failed", { sessionId: "thread-1" });
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce());

    expect(invoke).toHaveBeenCalledWith("record_renderer_log", {
      input: expect.objectContaining({
        level: "error",
        stage: "native.event_bridge.failed",
        details: { sessionId: "thread-1" },
      }),
    });
  });

  test("keeps only the latest 300 renderer entries", () => {
    const logger = createRendererLogger({
      console: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    });

    for (let index = 0; index < 305; index += 1) {
      logger.log("info", `renderer.event.${index}`);
    }

    expect(window.__tinybotRendererLogs).toHaveLength(300);
    expect(window.__tinybotRendererLogs?.[0]?.stage).toBe("renderer.event.5");
    expect(window.__tinybotRendererLogs?.[299]?.stage).toBe("renderer.event.304");
  });

  test("reports native persistence failures without recursively logging", async () => {
    const invoke = vi.fn(async () => {
      throw new Error("log command unavailable");
    });
    const consoleSink = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
    const logger = createRendererLogger({
      console: consoleSink,
      invoke,
      isNativeRuntime: () => true,
    });

    logger.log("warn", "native.listener.failed", { eventName: "agent.done" });
    await vi.waitFor(() => expect(consoleSink.error).toHaveBeenCalledOnce());

    expect(invoke).toHaveBeenCalledOnce();
    expect(consoleSink.error).toHaveBeenCalledWith(
      "[tinybot-renderer] log persistence failed",
      expect.objectContaining({
        error: "log command unavailable",
        stage: "native.listener.failed",
      }),
    );
  });
});
