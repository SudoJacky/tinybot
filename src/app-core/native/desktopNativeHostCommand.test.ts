import { describe, expect, test, vi } from "vitest";

import { createDesktopNativeHostCommandApi } from "./desktopNativeHostCommand";

describe("desktop native host command API", () => {
  test("dispatches the remaining typed TinyOS host command", async () => {
    const invoke = vi.fn(async (_command: string, _args?: Record<string, unknown>) => ({ ok: true }));
    const api = createDesktopNativeHostCommandApi({ invoke });
    const request = {
      clientId: "desktop-native",
      attachedChatId: "thread-1",
      frame: { type: "command", command_kind: "file.save", operation_id: "operation-1" },
    };

    await expect(api.dispatch(request)).resolves.toEqual({ ok: true });
    expect(invoke).toHaveBeenCalledWith("worker_dispatch_tinyos_host_command", { input: request });
  });
});
