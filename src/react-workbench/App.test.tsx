// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { TinybotErrorBoundary } from "./App";

afterEach(() => {
  cleanup();
  document.getElementById("tinybot-renderer-diagnostic-overlay")?.remove();
  vi.restoreAllMocks();
});

describe("TinybotErrorBoundary", () => {
  test("renders a visible fallback and records diagnostics after a render crash", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const recordDiagnostic = vi.fn(async () => undefined);

    render(
      <TinybotErrorBoundary recordDiagnostic={recordDiagnostic}>
        <CrashingChild />
      </TinybotErrorBoundary>,
    );

    const alerts = screen.getAllByRole("alert");
    expect(alerts.map((alert) => alert.textContent).join("\n")).toContain("Tinybot UI crashed");
    expect(alerts.map((alert) => alert.textContent).join("\n")).toContain("render exploded");
    expect(alerts.map((alert) => alert.textContent).join("\n")).toContain("Crash ID");
    expect(screen.getAllByRole("button", { name: "Reload" }).length).toBeGreaterThan(0);
    expect(recordDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
      type: "react.render",
      message: "render exploded",
      componentStack: expect.stringContaining("CrashingChild"),
    }));
  });
});

function CrashingChild(): ReactNode {
  throw new Error("render exploded");
}
