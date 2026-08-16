// @vitest-environment happy-dom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppServices } from "../services";
import PerformanceTraceRoute, { downloadPerformanceTrace } from "./PerformanceTraceRoute";

afterEach(() => {
  cleanup();
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

    await userEvent.setup().click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
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

  it("exports the loaded snapshot as a timestamped JSON download", () => {
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:trace");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

    downloadPerformanceTrace(fixtureSnapshot());

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:trace");
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
