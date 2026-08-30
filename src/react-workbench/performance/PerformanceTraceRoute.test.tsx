// @vitest-environment happy-dom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppServices } from "../services";
import PerformanceTraceRoute from "./PerformanceTraceRoute";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.__tinybotRendererLogs = [];
  window.__tinybotNativeDebug = [];
  window.__tinybotNativeChatDebug = [];
  vi.restoreAllMocks();
});

describe("PerformanceTraceRoute", () => {
  it("renders native metrics and refreshes the bounded snapshot on demand", async () => {
    const load = vi.fn(async () => fixtureSnapshot());
    render(<PerformanceTraceRoute services={{ performanceStore: { load } } as unknown as AppServices} />);

    expect(await screen.findByRole("heading", { name: "Performance Trace" })).toBeTruthy();
    expect(await screen.findByText("tool.duration")).toBeTruthy();
    expect(screen.getByText("trace.fixture")).toBeTruthy();
    expect(screen.getByText("120 ms")).toBeTruthy();
    expect(screen.getByText("Native backend")).toBeTruthy();
    expect(screen.getByText("WebView2")).toBeTruthy();
    expect(screen.getByText("192 MiB")).toBeTruthy();

    await userEvent.setup().click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  });

  it("records bounded memory samples only after an explicit start", async () => {
    const sampleMemory = vi.fn(async () => ({
      ...fixtureSnapshot().memory,
      sampledAtUnixMs: Date.UTC(2026, 7, 16, 1, 2, 5),
      totalPrivateBytes: 202_375_168,
    }));
    render(<PerformanceTraceRoute services={{
      performanceStore: { load: vi.fn(async () => fixtureSnapshot()), sampleMemory },
    } as unknown as AppServices} />);

    const start = await screen.findByRole("button", { name: "Start memory recording" });
    expect(sampleMemory).not.toHaveBeenCalled();

    await userEvent.setup().click(start);

    await waitFor(() => expect(sampleMemory).toHaveBeenCalledOnce());
    expect(screen.getByRole("button", { name: "Stop memory recording" })).toBeTruthy();
  });

  it("stops memory recording and surfaces collection failures", async () => {
    const sampleMemory = vi.fn(async () => {
      throw new Error("process query failed");
    });
    render(<PerformanceTraceRoute services={{
      performanceStore: { load: vi.fn(async () => fixtureSnapshot()), sampleMemory },
    } as unknown as AppServices} />);

    await userEvent.setup().click(await screen.findByRole("button", { name: "Start memory recording" }));

    expect((await screen.findByRole("alert")).textContent).toContain("process query failed");
    expect(screen.getByRole("button", { name: "Start memory recording" })).toBeTruthy();
  });

  it("surfaces load failures and offers an explicit retry", async () => {
    const load = vi.fn()
      .mockRejectedValueOnce(new Error("snapshot unavailable"))
      .mockResolvedValueOnce(fixtureSnapshot());
    render(<PerformanceTraceRoute services={{ performanceStore: { load } } as unknown as AppServices} />);

    expect((await screen.findByRole("alert")).textContent).toContain("snapshot unavailable");
    await userEvent.setup().click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("tool.duration")).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("exports the loaded snapshot through the native save flow and reports the saved path", async () => {
    const snapshot = fixtureSnapshot();
    const exportSnapshot = vi.fn(async () => ({ path: "C:\\Temp\\tinybot-performance-trace.json" }));
    render(<PerformanceTraceRoute services={{
      performanceStore: {
        load: vi.fn(async () => snapshot),
        exportSnapshot,
        exportDiagnosticBundle: vi.fn(async () => null),
      },
    } as unknown as AppServices} />);

    await screen.findByText("tool.duration");
    await userEvent.setup().click(screen.getByRole("button", { name: "Export JSON" }));

    await waitFor(() => expect(exportSnapshot).toHaveBeenCalledWith(snapshot));
    expect((await screen.findByRole("status")).textContent).toContain("C:\\Temp\\tinybot-performance-trace.json");
  });

  it("exports a local diagnostic bundle and reports the saved path", async () => {
    const exportDiagnosticBundle = vi.fn(async () => ({
      schemaVersion: "tinybot.diagnostic_bundle.v1" as const,
      path: "C:\\Temp\\tinybot-diagnostic.zip",
      sizeBytes: 4096,
      includedFiles: ["manifest.json", "performance-trace.json"],
    }));
    render(<PerformanceTraceRoute services={{
      performanceStore: { load: vi.fn(async () => fixtureSnapshot()), exportDiagnosticBundle },
    } as unknown as AppServices} />);

    await screen.findByText("tool.duration");
    await userEvent.setup().click(screen.getByRole("button", { name: "Export Diagnostic Bundle" }));

    await waitFor(() => expect(exportDiagnosticBundle).toHaveBeenCalledOnce());
    expect((await screen.findByRole("status")).textContent).toContain("C:\\Temp\\tinybot-diagnostic.zip");
  });

  it("enables and disables persistent renderer diagnostics from the trace page", async () => {
    render(<PerformanceTraceRoute services={{
      performanceStore: {
        load: vi.fn(async () => fixtureSnapshot()),
        exportDiagnosticBundle: vi.fn(async () => null),
      },
    } as unknown as AppServices} />);
    const checkbox = await screen.findByRole("checkbox", { name: /Diagnostic mode/ });

    await userEvent.setup().click(checkbox);

    expect(window.localStorage.getItem("tinybot.desktop.nativeDebug")).toBe("on");
    expect(checkbox).toHaveProperty("checked", true);

    await userEvent.setup().click(checkbox);

    expect(window.localStorage.getItem("tinybot.desktop.nativeDebug")).toBeNull();
    expect(checkbox).toHaveProperty("checked", false);
  });
});

function fixtureSnapshot() {
  return {
    schemaVersion: "tinybot.performance_trace.v1" as const,
    generatedAtUnixMs: Date.UTC(2026, 7, 16, 1, 2, 3),
    metrics: {
      schemaVersion: 1,
      generatedAtUnixMs: Date.UTC(2026, 7, 16, 1, 2, 2),
      counters: { "tool.calls": 3 },
      durations: { "tool.duration": { count: 2, totalMs: 200, maxMs: 120, averageMs: 100 } },
      gauges: { "runtime.active": 2 },
    },
    memory: {
      schemaVersion: "tinybot.memory_snapshot.v1" as const,
      sampledAtUnixMs: Date.UTC(2026, 7, 16, 1, 2, 2),
      status: "available" as const,
      native: {
        pid: 101,
        privateBytes: 64 * 1024 * 1024,
        workingSetBytes: 48 * 1024 * 1024,
        peakWorkingSetBytes: 56 * 1024 * 1024,
      },
      webview2: {
        privateBytes: 128 * 1024 * 1024,
        workingSetBytes: 96 * 1024 * 1024,
        processes: [{
          pid: 202,
          kind: "renderer",
          privateBytes: 128 * 1024 * 1024,
          workingSetBytes: 96 * 1024 * 1024,
          peakWorkingSetBytes: 112 * 1024 * 1024,
          webviewLabels: ["main"],
        }],
      },
      totalPrivateBytes: 192 * 1024 * 1024,
      totalWorkingSetBytes: 144 * 1024 * 1024,
      collectionErrors: [],
    },
    recentEvents: [{
      schemaVersion: "tinybot.native_log.v1",
      timestampUnixMs: Date.UTC(2026, 7, 16, 1, 2, 1),
      stream: "renderer",
      level: "warn" as const,
      event: "trace.fixture",
      context: { details: { threadId: "thread-1" } },
    }],
  };
}
