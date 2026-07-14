import { describe, expect, it } from "vitest";
import type { WorkspaceDirectoryPage, WorkspaceFileChunk } from "../workspace/workspaceExplorer";
import { createTinyOsFilesState, reduceTinyOsFilesState, resourceValue } from "./tinyOsFilesModel";

function directoryPage(overrides: Partial<WorkspaceDirectoryPage> = {}): WorkspaceDirectoryPage {
  return {
    entries: [{ kind: "file", name: "README.md", path: "README.md", sizeBytes: 12 }],
    listingRevision: "listing-1",
    path: ".",
    workspaceKey: "workspace-a",
    ...overrides,
  };
}

function fileChunk(overrides: Partial<WorkspaceFileChunk> = {}): WorkspaceFileChunk {
  return {
    content: "one\ntwo\n",
    contentType: "text",
    lineEnd: 2,
    lineStart: 1,
    path: "README.md",
    revision: "file-1",
    sizeBytes: 16,
    ...overrides,
  };
}

describe("TinyOS Files state", () => {
  it("rejects stale asynchronous directory results", () => {
    const loadingA = reduceTinyOsFilesState(createTinyOsFilesState(), {
      filter: "a",
      path: ".",
      requestId: "request-a",
      type: "directory_loading",
    });
    const loadingB = reduceTinyOsFilesState(loadingA, {
      filter: "b",
      path: ".",
      requestId: "request-b",
      type: "directory_loading",
    });
    const stale = reduceTinyOsFilesState(loadingB, {
      append: false,
      page: directoryPage(),
      requestId: "request-a",
      type: "directory_loaded",
    });

    expect(stale).toBe(loadingB);
  });

  it("appends bounded pages and file chunks", () => {
    const loadingPage = reduceTinyOsFilesState(createTinyOsFilesState(), {
      filter: "",
      path: ".",
      requestId: "directory-1",
      type: "directory_loading",
    });
    const firstPage = reduceTinyOsFilesState(loadingPage, {
      append: false,
      page: directoryPage({ nextCursor: "page-2" }),
      requestId: "directory-1",
      type: "directory_loaded",
    });
    const loadingNextPage = reduceTinyOsFilesState(firstPage, {
      filter: "",
      path: ".",
      requestId: "directory-2",
      type: "directory_loading",
    });
    const nextPage = reduceTinyOsFilesState(loadingNextPage, {
      append: true,
      page: directoryPage({
        entries: [{ kind: "file", name: "package.json", path: "package.json" }],
        listingRevision: "listing-1",
      }),
      requestId: "directory-2",
      type: "directory_loaded",
    });

    expect(resourceValue(nextPage.directories["."])?.entries.map(({ path }) => path)).toEqual([
      "README.md",
      "package.json",
    ]);

    const loadingFile = reduceTinyOsFilesState(nextPage, {
      path: "README.md",
      requestId: "file-1",
      type: "file_loading",
    });
    const firstChunk = reduceTinyOsFilesState(loadingFile, {
      append: false,
      chunk: fileChunk({ nextCursor: "chunk-2" }),
      requestId: "file-1",
      type: "file_loaded",
      workspaceKey: "workspace-a",
    });
    const loadingNextChunk = reduceTinyOsFilesState(firstChunk, {
      path: "README.md",
      requestId: "file-2",
      type: "file_loading",
    });
    const nextChunk = reduceTinyOsFilesState(loadingNextChunk, {
      append: true,
      chunk: fileChunk({ content: "three\n", lineEnd: 3, lineStart: 3, nextCursor: undefined }),
      requestId: "file-2",
      type: "file_loaded",
      workspaceKey: "workspace-a",
    });

    expect(resourceValue(nextChunk.documents["README.md"])?.content).toBe("one\ntwo\nthree\n");
  });

  it("closes the active tab using MRU order and clears its selection", () => {
    let state = createTinyOsFilesState();
    for (const path of ["a.ts", "b.ts", "c.ts"]) {
      state = reduceTinyOsFilesState(state, { path, requestId: `load-${path}`, type: "file_loading" });
      state = reduceTinyOsFilesState(state, {
        append: false,
        chunk: fileChunk({ path }),
        requestId: `load-${path}`,
        type: "file_loaded",
        workspaceKey: "workspace-a",
      });
    }
    state = reduceTinyOsFilesState(state, { path: "a.ts", type: "activate_file" });
    state = reduceTinyOsFilesState(state, {
      selection: { endLine: 2, path: "a.ts", selectedText: "one\ntwo", startLine: 1 },
      type: "select_lines",
    });
    state = reduceTinyOsFilesState(state, { path: "a.ts", type: "close_file" });

    expect(state.activePath).toBe("c.ts");
    expect(state.openPaths).toEqual(["b.ts", "c.ts"]);
    expect(state.selection).toBeUndefined();
  });

  it("keeps the loaded snapshot visible when a document becomes stale", () => {
    const loading = reduceTinyOsFilesState(createTinyOsFilesState(), {
      path: "README.md",
      requestId: "file-1",
      type: "file_loading",
    });
    const loaded = reduceTinyOsFilesState(loading, {
      append: false,
      chunk: fileChunk(),
      requestId: "file-1",
      type: "file_loaded",
      workspaceKey: "workspace-a",
    });
    const stale = reduceTinyOsFilesState(loaded, { path: "README.md", type: "mark_stale" });

    expect(resourceValue(stale.documents["README.md"])).toMatchObject({ content: "one\ntwo\n", stale: true });
  });

  it("drops workspace-scoped tabs when the configured workspace changes", () => {
    let state = createTinyOsFilesState();
    state = reduceTinyOsFilesState(state, { requestId: "init-a", type: "initialize" });
    state = reduceTinyOsFilesState(state, { page: directoryPage({ workspaceKey: "workspace-a" }), requestId: "init-a", type: "initialized" });
    state = reduceTinyOsFilesState(state, { path: "README.md", requestId: "file-a", type: "file_loading" });
    state = reduceTinyOsFilesState(state, { append: false, chunk: fileChunk(), requestId: "file-a", type: "file_loaded", workspaceKey: "workspace-a" });
    state = reduceTinyOsFilesState(state, { requestId: "init-b", type: "initialize" });
    state = reduceTinyOsFilesState(state, { page: directoryPage({ workspaceKey: "workspace-b" }), requestId: "init-b", type: "initialized" });

    expect(state.workspaceKey).toBe("workspace-b");
    expect(state.openPaths).toEqual([]);
    expect(state.documents).toEqual({});
  });
});
