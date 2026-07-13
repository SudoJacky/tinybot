import { describe, expect, test, vi } from "vitest";

import { createDesktopNativeWorkspaceApi } from "./desktopNativeWorkspace";

describe("desktop native workspace API", () => {
  test("loads and writes workspace files through Rust state Tauri commands", async () => {
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => ({
      command,
      args,
    }));
    const api = createDesktopNativeWorkspaceApi({ invoke });

    await expect(api.files()).resolves.toEqual({
      command: "worker_workspace_files",
      args: undefined,
    });
    await expect(api.file("docs/readme.md")).resolves.toEqual({
      command: "worker_workspace_file",
      args: { input: { path: "docs/readme.md" } },
    });
    await expect(api.putFile("docs/readme.md", { content: "# Readme\n" })).resolves.toEqual({
      command: "worker_workspace_put_file",
      args: { input: { path: "docs/readme.md", body: { content: "# Readme\n" } } },
    });
    await expect(api.directory({ path: "src", nameQuery: "chat" })).resolves.toEqual({
      command: "worker_workspace_directory",
      args: { input: { path: "src", nameQuery: "chat" } },
    });
    await expect(api.fileChunk({ path: "src/chat.ts", cursor: "next" })).resolves.toEqual({
      command: "worker_workspace_file_chunk",
      args: { input: { path: "src/chat.ts", cursor: "next" } },
    });
  });
});
