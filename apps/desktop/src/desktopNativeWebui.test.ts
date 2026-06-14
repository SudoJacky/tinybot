// @vitest-environment happy-dom

import { afterEach, describe, expect, test, vi } from "vitest";

import { createDesktopNativeWebuiApi } from "./desktopNativeWebui";

describe("desktop native WebUI API", () => {
  afterEach(() => {
    window.localStorage.clear();
    window.__tinybotNativeDebug = [];
    window.__tinybotNativeChatDebug = [];
    vi.restoreAllMocks();
  });

  test("routes WebUI control requests through the worker command", async () => {
    const invoke = vi.fn(async (_command: string, _args?: unknown) => ({
      status: 200,
      body: { ok: true },
    }));
    const api = createDesktopNativeWebuiApi({ invoke });

    await expect(api.route({ method: "GET", path: "/api/status" })).resolves.toEqual({ ok: true });
    expect(invoke).toHaveBeenCalledWith("worker_webui_route", {
      input: { method: "GET", path: "/api/status" },
    });
  });

  test("preserves headers on native WebUI route requests", async () => {
    const invoke = vi.fn(async (_command: string, _args?: unknown) => ({
      status: 200,
      body: { token: "token-1" },
    }));
    const api = createDesktopNativeWebuiApi({ invoke });

    await expect(api.route({
      method: "POST",
      path: "/webui/refresh-token",
      headers: { Authorization: "Bearer token-1" },
    })).resolves.toEqual({ token: "token-1" });
    expect(invoke).toHaveBeenCalledWith("worker_webui_route", {
      input: {
        method: "POST",
        path: "/webui/refresh-token",
        headers: { Authorization: "Bearer token-1" },
      },
    });
  });

  test("logs native WebUI route duration", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    window.localStorage.setItem("tinybot.desktop.nativeDebug", "on");
    const invoke = vi.fn(async (_command: string, _args?: unknown) => ({
      status: 200,
      body: { ok: true },
    }));
    const times = [100, 123.45];
    const api = createDesktopNativeWebuiApi({
      invoke,
      now: () => times.shift() ?? 123.45,
    });

    await expect(api.route({ method: "GET", path: "/api/tools" })).resolves.toEqual({ ok: true });

    expect(window.__tinybotNativeDebug?.map((entry) => entry.stage)).toEqual([
      "nativeWebui.route.start",
      "nativeWebui.route.complete",
    ]);
    expect(window.__tinybotNativeDebug?.[1].details).toMatchObject({
      durationMs: 23.5,
      method: "GET",
      path: "/api/tools",
      status: 200,
    });
  });
});
