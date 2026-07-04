import { describe, expect, test, vi } from "vitest";

import { createDesktopNativeCoworkApi } from "./desktopNativeCowork";

describe("desktop native cowork api", () => {
  test("unwraps successful worker route envelopes", async () => {
    const invoke = vi.fn(async () => ({ status: 200, body: { session: { id: "cw_1" } } }));
    const api = createDesktopNativeCoworkApi({ invoke });

    await expect(api.route({ method: "GET", path: "/api/cowork/sessions/cw_1" })).resolves.toEqual({
      session: { id: "cw_1" },
    });
    expect(invoke).toHaveBeenCalledWith("worker_cowork_route", {
      input: { method: "GET", path: "/api/cowork/sessions/cw_1" },
    });
  });

  test("forwards structured query parameters to the native worker route", async () => {
    const invoke = vi.fn(async () => ({ status: 200, body: { activity: { available: true } } }));
    const api = createDesktopNativeCoworkApi({ invoke });

    await expect(api.route({
      method: "GET",
      path: "/api/cowork/sessions/cw_1/agents/lead/activity",
      query: { limit: "5" },
    })).resolves.toEqual({
      activity: { available: true },
    });
    expect(invoke).toHaveBeenCalledWith("worker_cowork_route", {
      input: {
        method: "GET",
        path: "/api/cowork/sessions/cw_1/agents/lead/activity",
        query: { limit: "5" },
      },
    });
  });

  test("throws for non-2xx worker route envelopes so callers can fall back", async () => {
    const invoke = vi.fn(async () => ({ status: 501, body: { error: "not migrated" } }));
    const api = createDesktopNativeCoworkApi({ invoke });

    await expect(api.route({ method: "POST", path: "/api/cowork/sessions/cw_1/run" }))
      .rejects.toThrow("Native Cowork route failed: HTTP 501");
  });
});
