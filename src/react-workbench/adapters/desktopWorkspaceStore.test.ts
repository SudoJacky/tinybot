import { describe, expect, it, vi } from "vitest";
import type { NativeWorkspaceApi } from "../../app-core/native/desktopNativeWorkspace";
import { createDesktopWorkspaceStore } from "./desktopWorkspaceStore";

function createNativeWorkspace() {
  return {
    directory: vi.fn<NativeWorkspaceApi["directory"]>(async () => ({ result: { entries: [], listing_revision: "revision-1", path: "." } })),
    fileChunk: vi.fn<NativeWorkspaceApi["fileChunk"]>(async () => ({ result: { content_type: "text", path: "README.md", revision: "revision-1", size_bytes: 0 } })),
    threadFileChunk: vi.fn<NativeWorkspaceApi["threadFileChunk"]>(async () => ({ result: { content_type: "text", path: "README.md", revision: "revision-1", size_bytes: 0 } })),
    threadFileBytes: vi.fn<NativeWorkspaceApi["threadFileBytes"]>(async () => new Uint8Array([0, 1, 2, 3])),
  };
}

describe("desktop workspace store", () => {
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
    nativeWorkspace.threadFileChunk.mockResolvedValue({
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
    await expect(store.readThreadFileBytes!({
      expectedRevision: "revision-3",
      path: "report.xlsx",
      threadId: "thread-1",
    })).resolves.toEqual(new Uint8Array([0, 1, 2, 3]));
    expect(nativeWorkspace.threadFileBytes).toHaveBeenCalledWith({
      expectedRevision: "revision-3",
      path: "report.xlsx",
      threadId: "thread-1",
    });

    await expect(store.readThreadFile({ threadId: "thread-1", path: "src/main.ts" })).resolves.toEqual({
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
    expect(nativeWorkspace.threadFileChunk).toHaveBeenCalledWith({ threadId: "thread-1", path: "src/main.ts" });
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
