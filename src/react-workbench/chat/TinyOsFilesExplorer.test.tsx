// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTinyOsFilesState, type TinyOsFilesState } from "../../app-core/chat/tinyOsFilesModel";
import { TinyOsFilesExplorer } from "./TinyOsFilesExplorer";
import type { TinyOsFilesController } from "./useTinyOsFilesController";

afterEach(cleanup);

function controller(state: TinyOsFilesState): TinyOsFilesController {
  return {
    activateFile: vi.fn(),
    closeFile: vi.fn(),
    filterDirectory: vi.fn(async () => undefined),
    loadMoreDirectory: vi.fn(async () => undefined),
    loadMoreFile: vi.fn(async () => undefined),
    markStale: vi.fn(),
    openFile: vi.fn(async () => undefined),
    queryAvailable: true,
    refreshDirectory: vi.fn(async () => undefined),
    refreshFile: vi.fn(async () => undefined),
    revealFile: vi.fn(async () => undefined),
    selectLines: vi.fn(),
    setSearch: vi.fn(),
    showTree: vi.fn(),
    state,
    toggleDirectory: vi.fn(async () => undefined),
  };
}

function treeState(): TinyOsFilesState {
  return {
    ...createTinyOsFilesState(),
    appStatus: "ready",
    directories: {
      ".": {
        status: "ready",
        value: {
          entries: [
            { kind: "directory", name: "src", path: "src" },
            { kind: "file", name: "README.md", path: "README.md", sizeBytes: 12 },
          ],
          filter: "",
          listingRevision: "listing-1",
          path: ".",
        },
      },
    },
    expandedPaths: ["."],
    workspaceKey: "workspace-a",
  };
}

describe("TinyOS Workspace Explorer", () => {
  it("loads tree items without recursive enumeration and supports tree keyboard navigation", async () => {
    const files = controller(treeState());
    render(<TinyOsFilesExplorer canRequestChange={false} controller={files} layoutMode="workspace" onAttachContext={vi.fn()} onRequestExplanation={vi.fn()} />);

    const tree = screen.getByRole("tree", { name: "Workspace files" });
    const rows = within(tree).getAllByRole("treeitem");
    rows[0].focus();
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    expect(document.activeElement).toBe(rows[1]);

    await userEvent.click(screen.getByRole("treeitem", { name: "README.md" }));
    expect(files.openFile).toHaveBeenCalledWith("README.md");
    expect(screen.getByText("Select a UTF-8 text file to preview it.")).toBeTruthy();
  });

  it("creates an immutable workspace reference from a selected line range", async () => {
    const onAttachContext = vi.fn();
    const onRequestExplanation = vi.fn();
    const files = controller({
      ...treeState(),
      activePath: "src/main.ts",
      compactSurface: "document",
      documents: {
        "src/main.ts": {
          status: "ready",
          value: {
            content: "const one = 1;\nconst two = 2;",
            contentType: "text",
            lineEnd: 2,
            path: "src/main.ts",
            revision: "revision-1",
            sizeBytes: 31,
            stale: false,
          },
        },
      },
      openPaths: ["src/main.ts"],
      selection: {
        endLine: 2,
        path: "src/main.ts",
        selectedText: "const one = 1;\nconst two = 2;",
        startLine: 1,
      },
    });
    render(<TinyOsFilesExplorer canRequestChange controller={files} layoutMode="compact" onAttachContext={onAttachContext} onRequestExplanation={onRequestExplanation} />);

    expect(screen.queryByRole("tree")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Attach L1–2" }));
    expect(onAttachContext).toHaveBeenCalledWith({
      endLine: 2,
      kind: "file",
      path: "src/main.ts",
      provenance: { kind: "workspace_read", workspaceKey: "workspace-a" },
      revision: "revision-1",
      selectedText: "const one = 1;\nconst two = 2;",
      startLine: 1,
    });
    await userEvent.click(screen.getByRole("button", { name: "Ask Agent to explain" }));
    expect(onRequestExplanation).toHaveBeenCalledWith({
      endLine: 2,
      kind: "file",
      path: "src/main.ts",
      provenance: { kind: "workspace_read", workspaceKey: "workspace-a" },
      revision: "revision-1",
      selectedText: "const one = 1;\nconst two = 2;",
      startLine: 1,
    });
  });

  it("uses a separate tree surface in compact mode", async () => {
    const files = controller(treeState());
    render(<TinyOsFilesExplorer canRequestChange={false} controller={files} layoutMode="compact" onAttachContext={vi.fn()} onRequestExplanation={vi.fn()} />);

    expect(screen.getByRole("tree", { name: "Workspace files" })).toBeTruthy();
    expect(screen.queryByText("Select a UTF-8 text file to preview it.")).toBeNull();
    await userEvent.click(screen.getByRole("treeitem", { name: "src" }));
    expect(files.toggleDirectory).toHaveBeenCalledWith("src");
  });
});
