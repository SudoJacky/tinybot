import { describe, expect, it, vi } from "vitest";
import type { NativeWorkspaceApi } from "../../app-core/native/desktopNativeWorkspace";
import { createDesktopWorkspaceStore } from "./desktopWorkspaceStore";

function createNativeWorkspace() {
  return {
    files: vi.fn<NativeWorkspaceApi["files"]>(async () => ({ files: [] })),
    directory: vi.fn<NativeWorkspaceApi["directory"]>(async () => ({ result: { entries: [], listing_revision: "revision-1", path: "." } })),
    fileChunk: vi.fn<NativeWorkspaceApi["fileChunk"]>(async () => ({ result: { content_type: "text", path: "README.md", revision: "revision-1", size_bytes: 0 } })),
  };
}

describe("desktop workspace store", () => {
  it("normalizes workspace file summaries through the WorkspaceStore interface", async () => {
    const initialize = vi.fn(async () => undefined);
    const nativeWorkspace = createNativeWorkspace();
    nativeWorkspace.files.mockResolvedValue({
      files: [
        { relative_path: "src/main.ts", bytes: "512", updated_at: "unix-ms:100" },
        { name: "README.md", size: 2048, modified_at: "2026-08-15T00:00:00.000Z" },
      ],
    });
    const store = createDesktopWorkspaceStore({ initialize, nativeWorkspace });

    await expect(store.listFiles()).resolves.toEqual([
      { path: "src/main.ts", size: 512, updatedAtMs: 100 },
      { path: "README.md", size: 2048, updatedAtMs: Date.parse("2026-08-15T00:00:00.000Z") },
    ]);
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(nativeWorkspace.files).toHaveBeenCalledTimes(1);
  });

  it("normalizes directory and file query results", async () => {
    const nativeWorkspace = createNativeWorkspace();
    nativeWorkspace.directory.mockResolvedValue({
      result: {
        entries: [
          { kind: "directory", path: "src\\chat\\", updated_at: "2026-08-15T00:00:00.000Z" },
          { kind: "file", path: "src\\main.ts", size_bytes: "128" },
          { kind: "symlink", path: "ignored" },
        ],
        listing_revision: "revision-2",
        next_cursor: "cursor-2",
        path: "src",
        workspace_key: "workspace-1",
      },
    });
    nativeWorkspace.fileChunk.mockResolvedValue({
      result: {
        content: "hello",
        content_type: "text",
        line_end: 2,
        line_start: 1,
        next_cursor: "cursor-2",
        path: "src/main.ts",
        revision: "revision-3",
        size_bytes: 5,
        updated_at: "2026-08-15T00:00:00.000Z",
      },
    });
    const store = createDesktopWorkspaceStore({ initialize: async () => undefined, nativeWorkspace });

    await expect(store.listDirectory({ path: "src" })).resolves.toEqual({
      entries: [
        { kind: "directory", name: "chat", path: "src/chat", updatedAt: "2026-08-15T00:00:00.000Z" },
        { kind: "file", name: "main.ts", path: "src/main.ts", sizeBytes: 128 },
      ],
      listingRevision: "revision-2",
      nextCursor: "cursor-2",
      path: "src",
      workspaceKey: "workspace-1",
    });
    await expect(store.readFile({ path: "src/main.ts" })).resolves.toEqual({
      content: "hello",
      contentType: "text",
      lineEnd: 2,
      lineStart: 1,
      nextCursor: "cursor-2",
      path: "src/main.ts",
      revision: "revision-3",
      sizeBytes: 5,
      updatedAt: "2026-08-15T00:00:00.000Z",
    });
  });

  it("preserves structured workspace query failures", async () => {
    const nativeWorkspace = createNativeWorkspace();
    nativeWorkspace.directory.mockResolvedValue({
      error: {
        code: "query_failed",
        message: "Workspace path was not found.",
        retryable: true,
        details: { path: "missing", query_code: "not_found" },
      },
    });
    const store = createDesktopWorkspaceStore({ initialize: async () => undefined, nativeWorkspace });

    await expect(store.listDirectory({ path: "missing" })).rejects.toMatchObject({
      code: "not_found",
      message: "Workspace path was not found.",
      path: "missing",
      retryable: true,
    });
  });
});
