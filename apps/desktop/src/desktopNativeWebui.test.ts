import { describe, expect, test, vi } from "vitest";

import { createDesktopNativeWebuiApi } from "./desktopNativeWebui";

describe("desktop native WebUI API", () => {
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
});
