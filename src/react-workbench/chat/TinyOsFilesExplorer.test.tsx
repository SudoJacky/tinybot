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
    render(<TinyOsFilesExplorer canRequestChange={false} controller={files} layoutMode="workspace" onAttachContext={vi.fn()} onRequestExplanation={vi.fn()} onRequestModification={vi.fn()} />);

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
    const onRequestModification = vi.fn();
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
    render(<TinyOsFilesExplorer canRequestChange controller={files} layoutMode="compact" onAttachContext={onAttachContext} onRequestExplanation={onRequestExplanation} onRequestModification={onRequestModification} />);

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
    await userEvent.click(screen.getByRole("button", { name: "Ask Agent to modify" }));
    expect(onRequestModification).toHaveBeenCalledWith(expect.objectContaining({
      kind: "file",
      path: "src/main.ts",
      startLine: 1,
      endLine: 2,
    }));
  });

  it("uses a separate tree surface in compact mode", async () => {
    const files = controller(treeState());
    render(<TinyOsFilesExplorer canRequestChange={false} controller={files} layoutMode="compact" onAttachContext={vi.fn()} onRequestExplanation={vi.fn()} onRequestModification={vi.fn()} />);

    expect(screen.getByRole("tree", { name: "Workspace files" })).toBeTruthy();
    expect(screen.queryByText("Select a UTF-8 text file to preview it.")).toBeNull();
    await userEvent.click(screen.getByRole("treeitem", { name: "src" }));
    expect(files.toggleDirectory).toHaveBeenCalledWith("src");
  });

  it("reviews a local draft before saving it with the loaded revision", async () => {
    const onSaveFile = vi.fn(async () => undefined);
    const files = controller({
      ...treeState(),
      activePath: "README.md",
      documents: {
        "README.md": {
          status: "ready",
          value: {
            content: "before\n",
            contentType: "text",
            lineEnd: 1,
            path: "README.md",
            revision: "metadata:7:12",
            sizeBytes: 7,
            stale: false,
          },
        },
      },
      openPaths: ["README.md"],
    });
    render(<TinyOsFilesExplorer
      canDirectEdit
      canRequestChange={false}
      canSave
      controller={files}
      layoutMode="workspace"
      onAttachContext={vi.fn()}
      onRequestExplanation={vi.fn()}
      onRequestModification={vi.fn()}
      onSaveFile={onSaveFile}
    />);

    await userEvent.click(screen.getByRole("button", { name: "Edit README.md" }));
    const draft = screen.getByRole("textbox", { name: "Editable draft of README.md" });
    await userEvent.clear(draft);
    await userEvent.type(draft, "after");
    expect((screen.getByRole("button", { name: /Apply file change/ }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Review changes" }));
    expect(screen.getByRole("region", { name: "File change review" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /Apply file change/ }));

    expect(onSaveFile).toHaveBeenCalledWith({
      baseRevision: "metadata:7:12",
      content: "after",
      createOnly: false,
      path: "README.md",
    });
    expect(files.refreshFile).toHaveBeenCalledWith("README.md");
  });

  it("keeps a rejected draft visible for conflict recovery", async () => {
    const onSaveFile = vi.fn(async () => { throw new Error("version conflict"); });
    const files = controller({
      ...treeState(),
      activePath: "README.md",
      documents: {
        "README.md": {
          status: "ready",
          value: {
            content: "before\n",
            contentType: "text",
            lineEnd: 1,
            path: "README.md",
            revision: "metadata:7:12",
            sizeBytes: 7,
            stale: false,
          },
        },
      },
      openPaths: ["README.md"],
    });
    render(<TinyOsFilesExplorer
      canDirectEdit
      canRequestChange={false}
      canSave
      controller={files}
      layoutMode="workspace"
      onAttachContext={vi.fn()}
      onRequestExplanation={vi.fn()}
      onRequestModification={vi.fn()}
      onSaveFile={onSaveFile}
    />);

    await userEvent.click(screen.getByRole("button", { name: "Edit README.md" }));
    const draft = screen.getByRole("textbox", { name: "Editable draft of README.md" });
    await userEvent.clear(draft);
    await userEvent.type(draft, "keep this draft");
    await userEvent.click(screen.getByRole("button", { name: "Review changes" }));
    await userEvent.click(screen.getByRole("button", { name: /Apply file change/ }));

    expect((await screen.findByRole("alert")).textContent).toContain("version conflict");
    expect((screen.getByRole("textbox", { name: "Editable draft of README.md" }) as HTMLTextAreaElement).value).toBe("keep this draft");
  });
});
