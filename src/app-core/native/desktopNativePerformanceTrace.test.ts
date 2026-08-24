import { describe, expect, it, vi } from "vitest";
import {
  createDesktopNativePerformanceTraceApi,
  mergeRendererStartupTrace,
} from "./desktopNativePerformanceTrace";

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

  it("merges bounded renderer startup phases into the performance snapshot", () => {
    const snapshot = mergeRendererStartupTrace({
      schemaVersion: "tinybot.performance_trace.v1",
      generatedAtUnixMs: 1_723_772_923_000,
      metrics: {
        schemaVersion: 1,
        generatedAtUnixMs: 1_723_772_923_000,
        counters: {},
        durations: {},
        gauges: {},
      },
      recentEvents: [],
    }, [{
      schemaVersion: "tinybot.renderer_log.v1",
      at: "2026-08-24T01:02:03.000Z",
      level: "info",
      stage: "startup.sessions.load.complete",
      details: { durationMs: 128.4, sessionCount: 7, sinceStartMs: 181.2 },
    }, {
      schemaVersion: "tinybot.renderer_log.v1",
      at: "2026-08-24T01:02:04.000Z",
      level: "info",
      stage: "chat.message.sent",
      details: { durationMs: 5 },
    }]);

    expect(snapshot.metrics.durations["renderer.startup.sessions.load.durationMs"]).toEqual({
      averageMs: 128.4,
      count: 1,
      maxMs: 128.4,
      totalMs: 128.4,
    });
    expect(snapshot.metrics.gauges["renderer.startup.sessions.load.complete.sinceStartMs"]).toBe(181.2);
    expect(snapshot.recentEvents).toHaveLength(1);
    expect(snapshot.recentEvents[0]).toMatchObject({
      event: "startup.sessions.load.complete",
      stream: "renderer",
    });
  });

  it("exports a performance snapshot through the native save flow", async () => {
    const invoke = vi.fn(async () => ({ path: "C:\\Temp\\tinybot-performance-trace.json" }));
    const api = createDesktopNativePerformanceTraceApi({ invoke });
    const snapshot = {
      schemaVersion: "tinybot.performance_trace.v1" as const,
      generatedAtUnixMs: Date.UTC(2026, 7, 24, 1, 2, 3),
      metrics: {
        schemaVersion: 1,
        generatedAtUnixMs: Date.UTC(2026, 7, 24, 1, 2, 3),
        counters: {},
        durations: {},
        gauges: {},
      },
      recentEvents: [],
    };

    const result = await api.exportSnapshot(snapshot);

    expect(invoke).toHaveBeenCalledWith("save_export_file", {
      options: {
        title: "Export Tinybot performance trace",
        defaultPath: "tinybot-performance-trace-2026-08-24T01-02-03.000Z.json",
        filters: [{ name: "JSON", extensions: ["json"] }],
        contents: `${JSON.stringify(snapshot, null, 2)}\n`,
      },
    });
    expect(result).toEqual({ path: "C:\\Temp\\tinybot-performance-trace.json" });
  });

  it("returns null when the performance snapshot save dialog is cancelled", async () => {
    const api = createDesktopNativePerformanceTraceApi({ invoke: vi.fn(async () => null) });

    await expect(api.exportSnapshot({
      schemaVersion: "tinybot.performance_trace.v1",
      generatedAtUnixMs: 1,
      metrics: {
        schemaVersion: 1,
        generatedAtUnixMs: 1,
        counters: {},
        durations: {},
        gauges: {},
      },
      recentEvents: [],
    })).resolves.toBeNull();
  });

  it("exports a diagnostic bundle through the native save flow", async () => {
    const invoke = vi.fn(async () => ({
      schemaVersion: "tinybot.diagnostic_bundle.v1",
      path: "C:\\Temp\\tinybot-diagnostic.zip",
      sizeBytes: 4096,
      includedFiles: ["manifest.json", "renderer-logs.json"],
    }));
    const api = createDesktopNativePerformanceTraceApi({ invoke });

    const result = await api.exportDiagnosticBundle({
      diagnosticModeEnabled: true,
      locale: "zh-CN",
      timeZone: "Asia/Singapore",
      rendererLogs: [{
        schemaVersion: "tinybot.renderer_log.v1",
        at: "2026-08-16T01:02:03.000Z",
        level: "info",
        stage: "diagnostic.fixture",
        details: { threadId: "thread-1" },
      }],
    });

    expect(invoke).toHaveBeenCalledWith("desktop_export_diagnostic_bundle", {
      input: {
        schemaVersion: "tinybot.diagnostic_bundle_input.v1",
        diagnosticModeEnabled: true,
        locale: "zh-CN",
        timeZone: "Asia/Singapore",
        rendererLogs: [expect.objectContaining({ stage: "diagnostic.fixture" })],
      },
    });
    expect(result).toEqual({
      schemaVersion: "tinybot.diagnostic_bundle.v1",
      path: "C:\\Temp\\tinybot-diagnostic.zip",
      sizeBytes: 4096,
      includedFiles: ["manifest.json", "renderer-logs.json"],
    });
  });

  it("returns null when the diagnostic bundle save dialog is cancelled", async () => {
    const api = createDesktopNativePerformanceTraceApi({ invoke: vi.fn(async () => null) });

    await expect(api.exportDiagnosticBundle({
      diagnosticModeEnabled: false,
      rendererLogs: [],
    })).resolves.toBeNull();
  });

  it("fails fast when the diagnostic bundle result is invalid", async () => {
    const api = createDesktopNativePerformanceTraceApi({
      invoke: vi.fn(async () => ({
        schemaVersion: "tinybot.diagnostic_bundle.v1",
        path: "",
        sizeBytes: 1,
        includedFiles: [],
      })),
    });

    await expect(api.exportDiagnosticBundle({
      diagnosticModeEnabled: false,
      rendererLogs: [],
    })).rejects.toThrow("path must be a non-empty string");
  });
});
