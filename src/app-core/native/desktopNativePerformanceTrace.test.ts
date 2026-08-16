import { describe, expect, it, vi } from "vitest";
import { createDesktopNativePerformanceTraceApi } from "./desktopNativePerformanceTrace";

describe("desktopNativePerformanceTrace", () => {
  it("loads and validates a bounded native performance snapshot", async () => {
    const invoke = vi.fn(async () => ({
      schemaVersion: "tinybot.performance_trace.v1",
      generatedAtUnixMs: 1_723_772_923_000,
      metrics: {
        schemaVersion: 1,
        generatedAtUnixMs: 1_723_772_922_000,
        counters: { "tool.calls": 3 },
        durations: {
          "tool.duration": { count: 2, totalMs: 200, maxMs: 120, averageMs: 100 },
        },
        gauges: { "runtime.active": 2 },
      },
      recentEvents: [{
        schemaVersion: "tinybot.native_log.v1",
        timestampUnixMs: 1_723_772_921_000,
        stream: "renderer",
        level: "warn",
        event: "trace.fixture",
        context: { details: { threadId: "thread-1" } },
      }],
    }));
    const api = createDesktopNativePerformanceTraceApi({ invoke });

    const snapshot = await api.snapshot();

    expect(invoke).toHaveBeenCalledWith("desktop_performance_snapshot");
    expect(snapshot.metrics.durations["tool.duration"].averageMs).toBe(100);
    expect(snapshot.recentEvents[0]).toMatchObject({
      stream: "renderer",
      level: "warn",
      event: "trace.fixture",
    });
  });

  it("fails fast when the native snapshot shape is invalid", async () => {
    const api = createDesktopNativePerformanceTraceApi({
      invoke: vi.fn(async () => ({
        schemaVersion: "tinybot.performance_trace.v1",
        generatedAtUnixMs: 1,
        metrics: {
          schemaVersion: 1,
          generatedAtUnixMs: 1,
          counters: {},
          durations: {},
          gauges: {},
        },
        recentEvents: [{ level: "fatal" }],
      })),
    });

    await expect(api.snapshot()).rejects.toThrow("unsupported level");
  });
});
