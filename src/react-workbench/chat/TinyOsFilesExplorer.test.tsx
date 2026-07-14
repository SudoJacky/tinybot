// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTinyOsFilesState, type TinyOsFilesState } from "../../app-core/chat/tinyOsFilesModel";
import { createTinyOsFileSaveCommand } from "../../app-core/chat/tinyOsCommandGateway";
import { createTinyOsShellCommandRegistry, defineTinyOsShellCommand } from "../../app-core/chat/tinyOsShellCommandRegistry";
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

function openDocumentState(path = "README.md"): TinyOsFilesState {
  return {
    ...treeState(),
    activePath: path,
    documents: {
      [path]: {
        status: "ready",
        value: {
          access: "read_only",
          content: "before\n",
          contentType: "text",
          lineEnd: 1,
          path,
          provenance: { kind: "native_query", sourceId: "workspace-a" },
          resourceId: `workspace:workspace-a:${path}`,
          revision: "metadata:7:12",
          sizeBytes: 7,
          stale: false,
        },
      },
    },
    mruPaths: [path],
    openPaths: [path],
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
            access: "read_only",
            content: "const one = 1;\nconst two = 2;",
            contentType: "text",
            lineEnd: 2,
            path: "src/main.ts",
            provenance: { kind: "native_query", sourceId: "workspace-a" },
            resourceId: "workspace:workspace-a:src/main.ts",
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
            access: "read_only",
            content: "before\n",
            contentType: "text",
            lineEnd: 1,
            path: "README.md",
            provenance: { kind: "native_query", sourceId: "workspace-a" },
            resourceId: "workspace:workspace-a:README.md",
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
    const onSaveFile = vi.fn(async () => { throw new Error('file.save failed: version conflict: {"revision":"metadata:9:18"}'); });
    const files = controller({
      ...treeState(),
      activePath: "README.md",
      documents: {
        "README.md": {
          status: "ready",
          value: {
            access: "read_only",
            content: "before\n",
            contentType: "text",
            lineEnd: 1,
            path: "README.md",
            provenance: { kind: "native_query", sourceId: "workspace-a" },
            resourceId: "workspace:workspace-a:README.md",
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
    const conflict = screen.getByRole("region", { name: "File revision conflict" });
    expect(within(conflict).getByText("metadata:7:12")).toBeTruthy();
    expect(within(conflict).getByText("metadata:9:18")).toBeTruthy();
  });

  it("shows stable native resource identity, registered Open With handlers, and process occupancy", async () => {
    const attach = vi.fn();
    const resourceId = "workspace:workspace-a:README.md";
    const registry = createTinyOsShellCommandRegistry([defineTinyOsShellCommand({
      availability: { available: true },
      category: "resource",
      dispatch: attach,
      id: `reference.attach:${resourceId}`,
      input: { acceptedKinds: ["file"], kind: "reference" },
      keywords: ["readme", "chat"],
      label: "Attach README.md to Chat",
      scope: "local_presentation",
      target: { kind: "resource", resourceId },
    })]);
    const files = controller(openDocumentState());
    render(<TinyOsFilesExplorer
      canRequestChange={false}
      commandRegistry={registry}
      controller={files}
      kernel={{
        browserSessions: [],
        capabilities: [],
        cursor: { eventCount: 1, eventIndex: 1, mode: "live" },
        discrepancies: [],
        metrics: [],
        notifications: [],
        processes: [{
          applicationId: "files",
          correlation: { runId: "run-1", sessionId: "session-1" },
          id: "process-file-1",
          kind: "tool_operation",
          provenance: { kind: "canonical_event", sourceId: "item-1" },
          state: "running",
          title: "Read README",
        }],
        resources: [{
          access: "read_only",
          id: "kernel-file-1",
          kind: "file",
          path: "README.md",
          provenance: { kind: "canonical_event", sourceId: "item-1" },
          relatedProcessIds: ["process-file-1"],
          revision: "metadata:7:12",
          title: "README.md",
        }],
        truth: "derived",
      }}
      layoutMode="workspace"
      onAttachContext={vi.fn()}
      onRequestExplanation={vi.fn()}
      onRequestModification={vi.fn()}
    />);

    const identity = screen.getByRole("group", { name: "File resource identity" });
    expect(within(identity).getByText(resourceId)).toBeTruthy();
    expect(within(identity).getByText(/native_query/)).toBeTruthy();
    expect(within(identity).getByText("1 related process")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Open With" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Attach README.md to Chat" }));
    expect(attach).toHaveBeenCalledTimes(1);
  });

  it("keeps recent files and favorites as local views over known resources", async () => {
    const files = controller(openDocumentState());
    render(<TinyOsFilesExplorer canRequestChange={false} controller={files} layoutMode="workspace" onAttachContext={vi.fn()} onRequestExplanation={vi.fn()} onRequestModification={vi.fn()} />);

    await userEvent.click(screen.getByRole("button", { name: "Add README.md to favorites" }));
    await userEvent.click(screen.getByRole("button", { name: "Show favorite files" }));
    await userEvent.click(within(screen.getByLabelText("Favorite files")).getByRole("button", { name: /README.md/ }));
    expect(files.openFile).toHaveBeenCalledWith("README.md");

    await userEvent.click(screen.getByRole("button", { name: "Show recent files" }));
    expect(within(screen.getByLabelText("Recent files")).getByRole("button", { name: /README.md/ })).toBeTruthy();
  });

  it("tracks file dispatch, acknowledgement, completion, and conflict without presenting Trash", () => {
    const files = controller(openDocumentState());
    const command = createTinyOsFileSaveCommand({
      baseRevision: "metadata:7:12",
      commandId: "file-command-1",
      content: "after\n",
      issuedAt: "2026-07-14T00:00:00Z",
      path: "README.md",
      sessionId: "session-1",
      source: { control: "files-save", surface: "tinyos" },
    });
    const props = {
      canRequestChange: false,
      controller: files,
      layoutMode: "workspace" as const,
      onAttachContext: vi.fn(),
      onRequestExplanation: vi.fn(),
      onRequestModification: vi.fn(),
    };
    const { rerender } = render(<TinyOsFilesExplorer {...props} commandLifecycle={{ command, dispatchedAtMs: 1, stage: "sending" }} />);
    expect(within(screen.getByLabelText("File operation queue")).getByText("dispatching")).toBeTruthy();

    rerender(<TinyOsFilesExplorer {...props} commandLifecycle={{ command, dispatchedAtMs: 1, transportAcceptedAtMs: 2, stage: "waiting_for_canonical" }} />);
    expect(within(screen.getByLabelText("File operation queue")).getByText("awaiting runtime")).toBeTruthy();
    rerender(<TinyOsFilesExplorer {...props} commandLifecycle={{ acknowledgement: { itemId: "item-1", revision: 1 }, acknowledgedAtMs: 3, command, dispatchedAtMs: 1, stage: "acknowledged" }} />);
    expect(within(screen.getByLabelText("File operation queue")).getByText("acknowledged")).toBeTruthy();
    rerender(<TinyOsFilesExplorer {...props} commandLifecycle={{ acknowledgement: { itemId: "item-1", revision: 1 }, command, completedAtMs: 4, completion: { itemId: "item-1", revision: 2, status: "completed" }, dispatchedAtMs: 1, stage: "completed" }} />);
    expect(within(screen.getByLabelText("File operation queue")).getByText("completed")).toBeTruthy();

    const conflictCommand = { ...command, commandId: "file-command-2" };
    rerender(<TinyOsFilesExplorer {...props} commandLifecycle={{ command: conflictCommand, dispatchedAtMs: 5, error: "version conflict", stage: "rejected" }} />);
    expect(within(screen.getByLabelText("File operation queue")).getByText("conflict")).toBeTruthy();
    expect(screen.getByText("Permanent delete · Trash unavailable")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Trash/ })).toBeNull();
  });
});
