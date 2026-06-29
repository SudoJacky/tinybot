import { describe, expect, test, vi } from "vitest";

import { createDesktopNativeSessionsApi } from "./desktopNativeSessions";

describe("desktop native sessions API", () => {
  test("loads session lists and messages through Rust state Tauri commands", async () => {
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => ({
      command,
      args,
    }));
    const api = createDesktopNativeSessionsApi({ invoke });

    await expect(api.list()).resolves.toEqual({
      command: "worker_sessions_list",
      args: undefined,
    });
    await expect(api.messages("websocket:chat-1")).resolves.toEqual({
      command: "worker_session_messages",
      args: { input: { key: "websocket:chat-1" } },
    });
  });
});
