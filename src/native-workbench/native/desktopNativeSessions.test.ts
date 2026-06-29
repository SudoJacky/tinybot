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
    await expect(api.temporaryFiles!("websocket:chat-1")).resolves.toEqual({
      command: "worker_session_temporary_files",
      args: { input: { key: "websocket:chat-1" } },
    });
    await expect(api.uploadTemporaryFile!("websocket:chat-1", { name: "context.md" })).resolves.toEqual({
      command: "worker_session_upload_temporary_file",
      args: { input: { key: "websocket:chat-1", body: { name: "context.md" } } },
    });
    await expect(api.clearTemporaryFiles!("websocket:chat-1")).resolves.toEqual({
      command: "worker_session_clear_temporary_files",
      args: { input: { key: "websocket:chat-1" } },
    });
    await expect(api.delete!("websocket:chat-1")).resolves.toEqual({
      command: "worker_session_delete",
      args: { input: { key: "websocket:chat-1" } },
    });
    await expect(api.patch!("websocket:chat-1", { metadata: { pinned: true } })).resolves.toEqual({
      command: "worker_session_patch",
      args: { input: { key: "websocket:chat-1", body: { metadata: { pinned: true } } } },
    });
    await expect(api.clear!("websocket:chat-1")).resolves.toEqual({
      command: "worker_session_clear",
      args: { input: { key: "websocket:chat-1" } },
    });
  });
});
