// @vitest-environment happy-dom

import { afterEach, describe, expect, test, vi } from "vitest";
import {
  buildRendererDiagnostic,
  installRendererDiagnosticHandlers,
  recordRendererDiagnostic,
  showRendererDiagnosticOverlay,
} from "./rendererDiagnostics";

describe("renderer diagnostics", () => {
  afterEach(() => {
    document.getElementById("tinybot-renderer-diagnostic-overlay")?.remove();
    window.localStorage.clear();
    window.__tinybotNativeDebug = [];
    vi.restoreAllMocks();
  });

  test("records renderer crashes through the native diagnostic command without chat text", async () => {
    const invoke = vi.fn(async <T,>() => undefined as T);
    window.__tinybotNativeDebug = [
      {
        at: "2026-07-06T01:00:00.000Z",
        stage: "socket.frame",
        details: {
          chatId: "chat-1",
          text: { preview: "sensitive answer", length: 16 },
        },
      },
    ];

    const diagnostic = buildRendererDiagnostic("react.render", new Error("render exploded"), {
      componentStack: "at ChatPage",
      now: () => "2026-07-06T01:01:00.000Z",
    });

    await recordRendererDiagnostic(diagnostic, { invoke });

    expect(invoke).toHaveBeenCalledWith("record_renderer_diagnostic", {
      input: expect.objectContaining({
        id: diagnostic.id,
        type: "react.render",
        message: "render exploded",
        componentStack: "at ChatPage",
        recentDebugStages: [
          {
            at: "2026-07-06T01:00:00.000Z",
            stage: "socket.frame",
          },
        ],
      }),
    });
    expect(JSON.stringify(invoke.mock.calls)).not.toContain("sensitive answer");
  });

  test("falls back to a bounded localStorage crash log when native recording fails", async () => {
    const invoke = vi.fn(async <T,>() => {
      throw new Error("native unavailable");
      return undefined as T;
    });

    await recordRendererDiagnostic(
      buildRendererDiagnostic("window.error", new Error("boom"), {
        now: () => "2026-07-06T01:02:00.000Z",
      }),
      { invoke },
    );

    const stored = JSON.parse(window.localStorage.getItem("tinybot.renderer.diagnostics") ?? "[]");
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      type: "window.error",
      message: "boom",
    });
  });

  test("installs global handlers for window errors and unhandled rejections", () => {
    const record = vi.fn();
    const cleanup = installRendererDiagnosticHandlers({ record });

    window.dispatchEvent(new ErrorEvent("error", { error: new Error("window exploded") }));
    const rejectionEvent = new Event("unhandledrejection") as PromiseRejectionEvent;
    Object.defineProperty(rejectionEvent, "reason", { value: new Error("promise exploded") });
    window.dispatchEvent(rejectionEvent);

    cleanup();

    expect(record).toHaveBeenCalledTimes(2);
    expect(record.mock.calls[0][0]).toMatchObject({
      type: "window.error",
      message: "window exploded",
    });
    expect(record.mock.calls[1][0]).toMatchObject({
      type: "window.unhandledrejection",
      message: "promise exploded",
    });
  });

  test("shows a visible crash overlay with the diagnostic id", () => {
    const diagnostic = buildRendererDiagnostic("react.render", new Error("render exploded"), {
      now: () => "2026-07-06T01:03:00.000Z",
    });

    showRendererDiagnosticOverlay(diagnostic);

    const overlay = document.getElementById("tinybot-renderer-diagnostic-overlay");
    expect(overlay?.getAttribute("role")).toBe("alert");
    expect(overlay?.textContent).toContain("Tinybot UI crashed");
    expect(overlay?.textContent).toContain("render exploded");
    expect(overlay?.textContent).toContain(diagnostic.id);
  });
});
