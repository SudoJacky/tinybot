import { describe, expect, it, vi } from "vitest";
import {
  createDesktopNativePerformanceTraceApi,
  mergeRendererStartupTrace,
  type PerformanceMemorySnapshot,
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
      memory: fixtureMemorySnapshot(),
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
    expect(snapshot.memory.totalPrivateBytes).toBe(201_326_592);
    expect(snapshot.memory.webview2.processes[0]).toMatchObject({
      kind: "renderer",
      pid: 202,
    });
    expect(snapshot.recentEvents[0]).toMatchObject({
      stream: "renderer",
      level: "warn",
      event: "trace.fixture",
    });
  });

  it("loads a lightweight memory-only sample", async () => {
    const invoke = vi.fn(async () => fixtureMemorySnapshot());
    const api = createDesktopNativePerformanceTraceApi({ invoke });

    const sample = await api.memorySnapshot();

    expect(invoke).toHaveBeenCalledWith("desktop_memory_snapshot");
    expect(sample.native?.privateBytes).toBe(67_108_864);
  });

  it("fails fast when a memory counter is negative", async () => {
    const api = createDesktopNativePerformanceTraceApi({
      invoke: vi.fn(async () => ({
        ...fixtureMemorySnapshot(),
        totalPrivateBytes: -1,
      })),
    });

    await expect(api.memorySnapshot()).rejects.toThrow("non-negative safe integer");
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
        memory: fixtureMemorySnapshot(),
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
      memory: fixtureMemorySnapshot(),
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
      memory: fixtureMemorySnapshot(),
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
      memory: fixtureMemorySnapshot(),
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
      memorySamples: [fixtureMemorySnapshot()],
    });

    expect(invoke).toHaveBeenCalledWith("desktop_export_diagnostic_bundle", {
      input: {
        schemaVersion: "tinybot.diagnostic_bundle_input.v1",
        diagnosticModeEnabled: true,
        locale: "zh-CN",
        timeZone: "Asia/Singapore",
        rendererLogs: [expect.objectContaining({ stage: "diagnostic.fixture" })],
        memorySamples: [expect.objectContaining({ totalPrivateBytes: 201_326_592 })],
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

function fixtureMemorySnapshot(): PerformanceMemorySnapshot {
  return {
    schemaVersion: "tinybot.memory_snapshot.v1",
    sampledAtUnixMs: 1_723_772_922_500,
    status: "available",
    native: {
      pid: 101,
      privateBytes: 67_108_864,
      workingSetBytes: 50_331_648,
      peakWorkingSetBytes: 58_720_256,
    },
    webview2: {
      privateBytes: 134_217_728,
      workingSetBytes: 100_663_296,
      processes: [{
        pid: 202,
        kind: "renderer",
        privateBytes: 134_217_728,
        workingSetBytes: 100_663_296,
        peakWorkingSetBytes: 117_440_512,
        webviewLabels: ["main"],
      }],
    },
    totalPrivateBytes: 201_326_592,
    totalWorkingSetBytes: 150_994_944,
    collectionErrors: [],
  };
}
