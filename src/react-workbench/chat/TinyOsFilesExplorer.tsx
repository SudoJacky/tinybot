import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  AlertCircle,
  Activity,
  ArrowLeft,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock3,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  Loader2,
  MessageCircleQuestion,
  Paperclip,
  PencilLine,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { resourceValue, type TinyOsDirectoryView, type TinyOsResourceState } from "../../app-core/chat/tinyOsFilesModel";
import { tinyOsWorkspaceResourceId } from "../../app-core/chat/tinyOsFilesModel";
import type { TinyOsCommandLifecycle } from "../../app-core/chat/tinyOsCommandGateway";
import type { TinyOsKernelSnapshot } from "../../app-core/chat/tinyOsKernelModel";
import type { TinyOsShellCommandRegistry } from "../../app-core/chat/tinyOsShellCommandRegistry";
import { writeTinyOsReferenceTransfer } from "../../app-core/chat/tinyOsReferenceTransfer";
import type { TinyOsContextReference, TinyOsLayoutMode } from "../../app-core/chat/tinyOsUiState";
import type { WorkspaceDirectoryEntry } from "../../app-core/workspace/workspaceExplorer";
import type { TinyOsFilesController } from "./useTinyOsFilesController";

export function TinyOsFilesExplorer({
  canDirectEdit = false,
  canRequestChange,
  canSave = false,
  commandLifecycle = { stage: "idle" },
  commandRegistry,
  controller,
  directEditUnavailableReason,
  layoutMode,
  kernel,
  onAttachContext,
  onRequestExplanation,
  onRequestModification,
  onDeleteFile = async () => undefined,
  onMoveFile = async () => undefined,
  onSaveFile = async () => undefined,
  requestChangeUnavailableReason,
  saveUnavailableReason,
}: {
  canDirectEdit?: boolean;
  canRequestChange: boolean;
  canSave?: boolean;
  commandLifecycle?: TinyOsCommandLifecycle;
  commandRegistry?: TinyOsShellCommandRegistry;
  controller: TinyOsFilesController;
  directEditUnavailableReason?: string;
  layoutMode: TinyOsLayoutMode;
  kernel?: TinyOsKernelSnapshot;
  onAttachContext: (reference: TinyOsContextReference) => void;
  onRequestExplanation: (reference: TinyOsContextReference) => void;
  onRequestModification: (reference: TinyOsContextReference) => void;
  onDeleteFile?: (input: { baseRevision: string; path: string }) => Promise<void>;
  onMoveFile?: (input: { baseRevision: string; path: string; targetPath: string }) => Promise<void>;
  onSaveFile?: (input: { baseRevision?: string; content: string; createOnly: boolean; path: string }) => Promise<void>;
  requestChangeUnavailableReason?: string;
  saveUnavailableReason?: string;
}) {
  const { state } = controller;
  const [currentDirectory, setCurrentDirectory] = useState(".");
  const directory = resourceValue(state.directories[currentDirectory]);
  const [filter, setFilter] = useState(directory?.filter ?? "");
  const [newFilePath, setNewFilePath] = useState("");
  const [creatingFile, setCreatingFile] = useState(false);
  const [createError, setCreateError] = useState("");
  const [favoritePaths, setFavoritePaths] = useState<Set<string>>(() => new Set());
  const [localView, setLocalView] = useState<"favorites" | "recent" | "tree">("tree");
  const compactDocument = layoutMode === "compact" && state.compactSurface === "document";
  const showTree = layoutMode !== "compact" || !compactDocument;
  const showDocument = layoutMode !== "compact" || compactDocument;

  useEffect(() => setFilter(directory?.filter ?? ""), [currentDirectory, directory?.filter]);

  function selectDirectory(path: string) {
    setCurrentDirectory(path);
  }

  function browseDirectory(path: string) {
    setCurrentDirectory(path);
    if (path !== "." && !resourceValue(state.directories[path])) void controller.toggleDirectory(path);
    if (layoutMode === "compact") controller.showTree();
  }

  return (
    <div className="tinyos-workspace-explorer" data-layout={layoutMode}>
      {showTree ? (
        <aside aria-label="Workspace Explorer" className="tinyos-workspace-explorer__tree">
          <header>
            <span><FolderOpen aria-hidden="true" size={14} /><strong>Workspace</strong></span>
            <button aria-label="Show workspace tree" aria-pressed={localView === "tree"} title="Workspace tree" type="button" onClick={() => setLocalView("tree")}><Folder aria-hidden="true" size={13} /></button>
            <button aria-label="Show recent files" aria-pressed={localView === "recent"} title="Recent files" type="button" onClick={() => setLocalView("recent")}><Clock3 aria-hidden="true" size={13} /></button>
            <button aria-label="Show favorite files" aria-pressed={localView === "favorites"} title="Favorite files" type="button" onClick={() => setLocalView("favorites")}><Star aria-hidden="true" size={13} /></button>
            <button aria-label="Create workspace file" disabled={!canSave} title={canSave ? "Create an empty workspace file" : saveUnavailableReason} type="button" onClick={() => setCreatingFile((current) => !current)}><FilePlus2 aria-hidden="true" size={13} /></button>
            <button aria-label="Refresh current directory" title="Refresh directory" type="button" onClick={() => void controller.refreshDirectory(currentDirectory)}><RefreshCw aria-hidden="true" size={13} /></button>
          </header>
          {creatingFile ? (
            <form className="tinyos-workspace-explorer__create" onSubmit={(event) => {
              event.preventDefault();
              const path = newFilePath.trim().replace(/\\/g, "/");
              if (!path) return;
              setCreateError("");
              void onSaveFile({ content: "", createOnly: true, path }).then(async () => {
                setCreatingFile(false);
                setNewFilePath("");
                await controller.refreshDirectory(parentDirectory(path));
                await controller.revealFile(path);
              }).catch((error) => setCreateError(error instanceof Error ? error.message : String(error)));
            }}>
              <input aria-label="New workspace file path" autoFocus placeholder="path/to/new-file.ts" value={newFilePath} onChange={(event) => setNewFilePath(event.currentTarget.value)} />
              <button disabled={!newFilePath.trim()} type="submit">Create</button>
              <button type="button" onClick={() => setCreatingFile(false)}>Cancel</button>
              {createError ? <span role="alert">{createError}</span> : null}
            </form>
          ) : null}
          <form className="tinyos-workspace-explorer__filter" onSubmit={(event) => { event.preventDefault(); void controller.filterDirectory(currentDirectory, filter); }}>
            <Search aria-hidden="true" size={12} />
            <input aria-label={`Filter ${displayPath(currentDirectory)}`} placeholder="Filter current folder" value={filter} onChange={(event) => setFilter(event.currentTarget.value)} />
          </form>
          {localView === "tree" ? <WorkspaceTree controller={controller} currentDirectory={currentDirectory} onSelectDirectory={selectDirectory} /> : (
            <LocalFileView
              label={localView === "recent" ? "Recent files" : "Favorite files"}
              paths={localView === "recent" ? [...state.mruPaths].reverse() : [...favoritePaths]}
              onOpen={(path) => void controller.openFile(path)}
            />
          )}
          <div aria-live="polite" className="tinyos-workspace-explorer__status">
            {directory?.filter ? `Filtered ${displayPath(currentDirectory)} by “${directory.filter}”` : displayPath(currentDirectory)}
          </div>
        </aside>
      ) : null}
      {showDocument ? (
        <WorkspaceDocument
          canDirectEdit={canDirectEdit}
          canRequestChange={canRequestChange}
          canSave={canSave}
          commandRegistry={commandRegistry}
          controller={controller}
          compact={layoutMode === "compact"}
          directEditUnavailableReason={directEditUnavailableReason}
          favorite={Boolean(state.activePath && favoritePaths.has(state.activePath))}
          kernel={kernel}
          onAttachContext={onAttachContext}
          onBrowseDirectory={browseDirectory}
          onRequestExplanation={onRequestExplanation}
          onRequestModification={onRequestModification}
          onDeleteFile={onDeleteFile}
          onMoveFile={onMoveFile}
          onSaveFile={onSaveFile}
          onToggleFavorite={() => state.activePath && setFavoritePaths((current) => {
            const next = new Set(current);
            if (next.has(state.activePath!)) next.delete(state.activePath!);
            else next.add(state.activePath!);
            return next;
          })}
          requestChangeUnavailableReason={requestChangeUnavailableReason}
          saveUnavailableReason={saveUnavailableReason}
        />
      ) : null}
      <TinyOsFileOperationQueue lifecycle={commandLifecycle} />
    </div>
  );
}

function LocalFileView({ label, onOpen, paths }: { label: string; onOpen: (path: string) => void; paths: string[] }) {
  return (
    <div aria-label={label} className="tinyos-workspace-local-view">
      {paths.length ? paths.map((path) => <button key={path} title={path} type="button" onClick={() => onOpen(path)}><FileText aria-hidden="true" size={13} /><span>{fileName(path)}</span><small>{path}</small></button>) : <ExplorerMessage text={`No ${label.toLocaleLowerCase()} yet.`} />}
    </div>
  );
}

type TinyOsFileOperationView = {
  commandId: string;
  detail?: string;
  kind: "delete" | "move" | "save";
  path: string;
  state: "acknowledged" | "awaiting_runtime" | "completed" | "conflict" | "dispatching" | "failed";
};

function TinyOsFileOperationQueue({ lifecycle }: { lifecycle: TinyOsCommandLifecycle }) {
  const [operations, setOperations] = useState<TinyOsFileOperationView[]>([]);
  useEffect(() => {
    if (lifecycle.stage === "idle") return;
    const command = lifecycle.command;
    if (command.kind !== "file.save" && command.kind !== "file.move" && command.kind !== "file.delete") return;
    const error = lifecycle.stage === "rejected" || lifecycle.stage === "timed_out" ? lifecycle.error : undefined;
    const state: TinyOsFileOperationView["state"] = lifecycle.stage === "sending"
      ? "dispatching"
      : lifecycle.stage === "waiting_for_canonical"
        ? "awaiting_runtime"
        : lifecycle.stage === "acknowledged"
          ? "acknowledged"
          : lifecycle.stage === "completed"
            ? lifecycle.completion.status === "completed" ? "completed" : "failed"
            : error?.toLocaleLowerCase().includes("version conflict") ? "conflict" : "failed";
    const next: TinyOsFileOperationView = {
      commandId: command.commandId,
      detail: error,
      kind: command.kind.replace("file.", "") as TinyOsFileOperationView["kind"],
      path: command.file.path,
      state,
    };
    setOperations((current) => [next, ...current.filter((operation) => operation.commandId !== next.commandId)].slice(0, 5));
  }, [lifecycle]);

  if (!operations.length) return null;
  return (
    <aside aria-label="File operation queue" className="tinyos-file-operation-queue">
      <header><strong>File operations</strong><span>{operations.length}</span></header>
      {operations.map((operation) => <article data-state={operation.state} key={operation.commandId}><span><strong>{operation.kind}</strong><small>{operation.path}</small></span><span>{operation.state.replace("_", " ")}</span>{operation.detail ? <small title={operation.detail}>{operation.detail}</small> : null}</article>)}
    </aside>
  );
}

function WorkspaceTree({
  controller,
  currentDirectory,
  onSelectDirectory,
}: {
  controller: TinyOsFilesController;
  currentDirectory: string;
  onSelectDirectory: (path: string) => void;
}) {
  const { state } = controller;
  const root = state.directories["."];

  if (state.appStatus === "loading" || root?.status === "loading") return <ExplorerMessage icon="loading" text="Loading workspace…" />;
  if (state.appStatus === "not_configured") return <ExplorerMessage text="Choose a workspace before browsing files." />;
  if (state.appStatus === "capability_denied") return <ExplorerMessage text="Workspace read access is not available for this session." />;
  if (state.appStatus === "root_unavailable") return <ExplorerResourceError resource={root} retry={() => void controller.refreshDirectory(".")} />;
  const rootValue = resourceValue(root);
  if (!rootValue?.entries.length) return <ExplorerMessage text="This workspace folder is empty." />;

  return (
    <div aria-label="Workspace files" className="tinyos-workspace-tree" role="tree" onKeyDown={handleTreeKeyDown}>
      <TreeRows
        controller={controller}
        currentDirectory={currentDirectory}
        depth={0}
        directory={rootValue}
        onSelectDirectory={onSelectDirectory}
      />
    </div>
  );
}

function TreeRows({
  controller,
  currentDirectory,
  depth,
  directory,
  onSelectDirectory,
}: {
  controller: TinyOsFilesController;
  currentDirectory: string;
  depth: number;
  directory: TinyOsDirectoryView;
  onSelectDirectory: (path: string) => void;
}) {
  return (
    <>
      {directory.entries.map((entry) => (
        <TreeEntry
          controller={controller}
          currentDirectory={currentDirectory}
          depth={depth}
          entry={entry}
          key={entry.path}
          onSelectDirectory={onSelectDirectory}
        />
      ))}
      {directory.nextCursor ? <button className="tinyos-workspace-tree__more" type="button" onClick={() => void controller.loadMoreDirectory(directory.path)}>Load more</button> : null}
    </>
  );
}

function TreeEntry({
  controller,
  currentDirectory,
  depth,
  entry,
  onSelectDirectory,
}: {
  controller: TinyOsFilesController;
  currentDirectory: string;
  depth: number;
  entry: WorkspaceDirectoryEntry;
  onSelectDirectory: (path: string) => void;
}) {
  const { state } = controller;
  const isDirectory = entry.kind === "directory";
  const expanded = isDirectory && state.expandedPaths.includes(entry.path);
  const childResource = isDirectory ? state.directories[entry.path] : undefined;
  const childDirectory = resourceValue(childResource);
  return (
    <div className="tinyos-workspace-tree__branch" role="none">
      <button
        aria-expanded={isDirectory ? expanded : undefined}
        aria-selected={isDirectory ? currentDirectory === entry.path : state.activePath === entry.path}
        className="tinyos-workspace-tree__entry"
        data-active={(isDirectory ? currentDirectory === entry.path : state.activePath === entry.path) ? "true" : undefined}
        data-kind={entry.kind}
        data-provenance="native_query"
        data-resource-id={tinyOsWorkspaceResourceId(state.workspaceKey ?? "workspace", entry.path)}
        role="treeitem"
        style={{ paddingInlineStart: `${8 + depth * 14}px` }}
        title={entry.path}
        type="button"
        onClick={() => {
          if (isDirectory) {
            onSelectDirectory(entry.path);
            void controller.toggleDirectory(entry.path);
          } else {
            void controller.openFile(entry.path);
          }
        }}
      >
        {isDirectory ? expanded ? <ChevronDown aria-hidden="true" size={12} /> : <ChevronRight aria-hidden="true" size={12} /> : <span aria-hidden="true" className="tinyos-workspace-tree__spacer" />}
        {isDirectory ? expanded ? <FolderOpen aria-hidden="true" size={13} /> : <Folder aria-hidden="true" size={13} /> : <FileText aria-hidden="true" size={13} />}
        <span>{entry.name}</span>
      </button>
      {expanded ? (
        <div role="group">
          {childResource?.status === "loading" ? <ExplorerMessage compact icon="loading" text={`Loading ${entry.name}…`} /> : null}
          {childResource?.status === "error" ? <ExplorerResourceError compact resource={childResource} retry={() => void controller.refreshDirectory(entry.path)} /> : null}
          {childDirectory && !childDirectory.entries.length ? <ExplorerMessage compact text="Empty folder" /> : null}
          {childDirectory ? <TreeRows controller={controller} currentDirectory={currentDirectory} depth={depth + 1} directory={childDirectory} onSelectDirectory={onSelectDirectory} /> : null}
        </div>
      ) : null}
    </div>
  );
}

function WorkspaceDocument({
  canDirectEdit,
  canRequestChange,
  canSave,
  commandRegistry,
  compact,
  controller,
  directEditUnavailableReason,
  favorite,
  kernel,
  onAttachContext,
  onBrowseDirectory,
  onDeleteFile,
  onMoveFile,
  onRequestExplanation,
  onRequestModification,
  onSaveFile,
  onToggleFavorite,
  requestChangeUnavailableReason,
  saveUnavailableReason,
}: {
  canDirectEdit: boolean;
  canRequestChange: boolean;
  canSave: boolean;
  commandRegistry?: TinyOsShellCommandRegistry;
  compact: boolean;
  controller: TinyOsFilesController;
  directEditUnavailableReason?: string;
  favorite: boolean;
  kernel?: TinyOsKernelSnapshot;
  onAttachContext: (reference: TinyOsContextReference) => void;
  onBrowseDirectory: (path: string) => void;
  onDeleteFile: (input: { baseRevision: string; path: string }) => Promise<void>;
  onMoveFile: (input: { baseRevision: string; path: string; targetPath: string }) => Promise<void>;
  onRequestExplanation: (reference: TinyOsContextReference) => void;
  onRequestModification: (reference: TinyOsContextReference) => void;
  onSaveFile: (input: { baseRevision?: string; content: string; createOnly: boolean; path: string }) => Promise<void>;
  onToggleFavorite: () => void;
  requestChangeUnavailableReason?: string;
  saveUnavailableReason?: string;
}) {
  const { state } = controller;
  const activePath = state.activePath;
  if (!activePath) return <section className="tinyos-workspace-document"><ExplorerMessage text="Select a UTF-8 text file to preview it." /></section>;
  const path: string = activePath;
  const resource = state.documents[path];
  const document = resourceValue(resource);
  const lines = useMemo(() => document?.content.split("\n") ?? [], [document?.content]);
  const highlightedLines = useHighlightedLines(path, document?.content ?? "");
  const search = state.searchByPath[path] ?? { activeMatch: 0, query: "" };
  const matches = useMemo(() => search.query
    ? lines.flatMap((line, index) => line.toLocaleLowerCase().includes(search.query.toLocaleLowerCase()) ? [index] : [])
    : [], [lines, search.query]);
  const activeMatch = matches.length ? Math.min(search.activeMatch, matches.length - 1) : 0;
  const matchLine = matches[activeMatch];
  const selection = state.selection?.path === path ? state.selection : undefined;
  const [anchor, setAnchor] = useState<number>();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [editingPath, setEditingPath] = useState<string>();
  const [reviewing, setReviewing] = useState(false);
  const [moveTarget, setMoveTarget] = useState("");
  const [moving, setMoving] = useState(false);
  const [deleteConfirmed, setDeleteConfirmed] = useState(false);
  const [mutationError, setMutationError] = useState("");
  const [mutationConflict, setMutationConflict] = useState<{ baseRevision: string; currentRevision?: string; message: string }>();
  const [openWith, setOpenWith] = useState(false);
  const activeMatchRef = useRef<HTMLLIElement>(null);

  useEffect(() => {
    setAnchor(undefined);
    controller.selectLines(undefined);
    setReviewing(false);
    setMoving(false);
    setDeleteConfirmed(false);
    setMutationError("");
    setMutationConflict(undefined);
    setOpenWith(false);
  }, [path]);
  useEffect(() => activeMatchRef.current?.scrollIntoView({ block: "center" }), [matchLine]);

  function selectLine(lineNumber: number, extend: boolean) {
    const start = extend && anchor ? Math.min(anchor, lineNumber) : lineNumber;
    const end = extend && anchor ? Math.max(anchor, lineNumber) : lineNumber;
    setAnchor((current) => extend && current ? current : lineNumber);
    controller.selectLines({
      endLine: end,
      path,
      selectedText: boundedSelectionText(lines.slice(start - 1, end).join("\n")),
      startLine: start,
    });
  }

  function moveMatch(delta: number) {
    if (!matches.length) return;
    controller.setSearch(path, search.query, (activeMatch + delta + matches.length) % matches.length);
  }

  const selectedReference: TinyOsContextReference | undefined = selection && document ? {
    endLine: selection.endLine,
    kind: "file",
    path,
    provenance: { kind: "workspace_read", workspaceKey: state.workspaceKey ?? "workspace" },
    revision: document.revision,
    selectedText: selection.selectedText,
    startLine: selection.startLine,
  } : undefined;
  const editing = editingPath === path;
  const draft = drafts[path] ?? document?.content ?? "";
  const dirty = Boolean(document && draft !== document.content);
  const kernelResource = document && kernel?.resources.find((candidate) => candidate.path?.replace(/\\/g, "/") === path.replace(/\\/g, "/"));
  const relatedProcesses = kernelResource
    ? kernel?.processes.filter((process) => kernelResource.relatedProcessIds.includes(process.id)) ?? []
    : [];
  const resourceId = document?.resourceId ?? tinyOsWorkspaceResourceId(state.workspaceKey ?? "workspace", path);
  const openWithCommands = commandRegistry?.commands.filter((command) => command.target.kind === "resource" && command.target.resourceId === resourceId) ?? [];

  async function saveDraft() {
    if (!document || !dirty) return;
    setMutationError("");
    setMutationConflict(undefined);
    try {
      await onSaveFile({ baseRevision: document.revision, content: draft, createOnly: false, path });
      setDrafts((current) => {
        const next = { ...current };
        delete next[path];
        return next;
      });
      setEditingPath(undefined);
      setReviewing(false);
      await controller.refreshFile(path);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setMutationError(message);
      setMutationConflict(fileVersionConflict(message, document.revision));
    }
  }

  return (
    <section aria-label={`File ${path}`} className="tinyos-workspace-document">
      <div className="tinyos-workspace-document__tabs" role="tablist" aria-label="Open files">
        {compact ? <button aria-label="Back to workspace" title="Back to workspace" type="button" onClick={controller.showTree}><ArrowLeft aria-hidden="true" size={13} /></button> : null}
        {state.openPaths.map((openPath) => (
          <span data-active={openPath === path ? "true" : undefined} key={openPath}>
            <button aria-selected={openPath === path} data-provenance="native_query" data-resource-id={tinyOsWorkspaceResourceId(state.workspaceKey ?? "workspace", openPath)} role="tab" title={openPath} type="button" onClick={() => controller.activateFile(openPath)}>{fileName(openPath)}</button>
            <button aria-label={`Close ${openPath}`} title={`Close ${openPath}`} type="button" onClick={() => controller.closeFile(openPath)}><X aria-hidden="true" size={11} /></button>
          </span>
        ))}
      </div>
      <div className="tinyos-workspace-document__path">
        <nav aria-label="File breadcrumb">{breadcrumbPaths(path).map(({ label, value }) => <button aria-current={value === path ? "page" : undefined} disabled={value === path} key={value} title={value} type="button" onClick={() => onBrowseDirectory(value)}>{label}</button>)}</nav>
        <button aria-label={`Refresh ${path}`} title="Refresh file" type="button" onClick={() => void controller.refreshFile(path)}><RefreshCw aria-hidden="true" size={13} /></button>
        <button aria-label={favorite ? `Remove ${path} from favorites` : `Add ${path} to favorites`} aria-pressed={favorite} title={favorite ? "Remove favorite" : "Add favorite"} type="button" onClick={onToggleFavorite}><Star aria-hidden="true" fill={favorite ? "currentColor" : "none"} size={13} /></button>
        <button aria-expanded={openWith} disabled={!openWithCommands.length} title={openWithCommands.length ? "Open with a registered TinyOS handler" : "No registered handler is available"} type="button" onClick={() => setOpenWith((current) => !current)}>Open With</button>
        <button
          aria-label={editing ? `Close editor for ${path}` : `Edit ${path}`}
          disabled={!editing && (!canDirectEdit || document?.contentType !== "text" || Boolean(document?.nextCursor))}
          title={editing ? "Keep the draft and close editable mode" : canDirectEdit ? document?.nextCursor ? "Load the complete file before editing" : "Edit a local draft" : directEditUnavailableReason}
          type="button"
          onClick={() => {
            if (editing) setEditingPath(undefined);
            else if (document) {
              setDrafts((current) => ({ ...current, [path]: current[path] ?? document.content }));
              setEditingPath(path);
            }
          }}
        ><PencilLine aria-hidden="true" size={12} />{editing ? "Close editor" : "Edit draft"}</button>
      </div>
      {openWith ? (
        <div aria-label={`Open ${path} with`} className="tinyos-file-open-with" role="menu">
          {openWithCommands.map((command) => <button disabled={!command.availability.available} key={command.id} role="menuitem" title={command.availability.available ? command.label : command.availability.reason} type="button" onClick={() => void commandRegistry?.execute(command.id).then((result) => result.status === "executed" && setOpenWith(false))}>{command.label}</button>)}
        </div>
      ) : null}
      {document ? (
        <dl aria-label="File resource identity" className="tinyos-file-resource-meta" role="group">
          <div><dt>Resource</dt><dd><code>{resourceId}</code></dd></div>
          <div><dt>Revision</dt><dd><code>{document.revision}</code></dd></div>
          <div><dt>Access</dt><dd>{canSave ? "read / write commands" : document.access.replace("_", " ")}</dd></div>
          <div><dt>Provenance</dt><dd><ShieldCheck aria-hidden="true" size={11} />{document.provenance.kind} · {document.provenance.sourceId}</dd></div>
          <div><dt>Occupancy</dt><dd><Activity aria-hidden="true" size={11} />{relatedProcesses.length ? `${relatedProcesses.length} related process${relatedProcesses.length === 1 ? "" : "es"}` : "No correlated process evidence"}</dd></div>
        </dl>
      ) : null}
      <div className="tinyos-workspace-document__search">
        <Search aria-hidden="true" size={12} />
        <input aria-label="Search loaded file content" placeholder="Search loaded content" value={search.query} onChange={(event) => controller.setSearch(path, event.currentTarget.value, 0)} />
        <span aria-live="polite">{search.query ? `${matches.length ? activeMatch + 1 : 0}/${matches.length}` : ""}</span>
        <button aria-label="Previous match" disabled={!matches.length} title="Previous match" type="button" onClick={() => moveMatch(-1)}><ChevronLeft aria-hidden="true" size={13} /></button>
        <button aria-label="Next match" disabled={!matches.length} title="Next match" type="button" onClick={() => moveMatch(1)}><ChevronRight aria-hidden="true" size={13} /></button>
      </div>
      {resource?.status === "loading" ? <ExplorerMessage icon="loading" text={`Loading ${fileName(path)}…`} /> : null}
      {resource?.status === "error" ? <ExplorerResourceError resource={resource} retry={() => void controller.refreshFile(path)} /> : null}
      {document?.contentType === "binary" || document?.contentType === "unsupported" ? <ExplorerMessage text={`Preview is unavailable for this ${formatBytes(document.sizeBytes)} ${document.contentType} file.`} /> : null}
      {document?.contentType === "text" && editing ? (
        <div className="tinyos-file-editor">
          <textarea aria-label={`Editable draft of ${path}`} spellCheck={false} value={draft} onChange={(event) => {
            const nextDraft = event.currentTarget.value;
            setDrafts((current) => ({ ...current, [path]: nextDraft }));
            setReviewing(false);
          }} />
          {reviewing ? (
            <section aria-label="File change review" className="tinyos-file-editor__diff">
              <header><strong>Diff before save</strong><span>{lineChangeSummary(document.content, draft)}</span></header>
              <div><pre data-side="before">{document.content}</pre><pre data-side="after">{draft}</pre></div>
            </section>
          ) : null}
          <div className="tinyos-file-editor__actions">
            <button disabled={!dirty || !canSave} title={canSave ? "Review the exact change before saving" : saveUnavailableReason} type="button" onClick={() => setReviewing(true)}>Review changes</button>
            <button disabled={!dirty || !canSave || !reviewing} title="Write this reviewed draft using its base revision" type="button" onClick={() => void saveDraft()}><Save aria-hidden="true" size={12} />Apply file change</button>
            <button disabled={!dirty} type="button" onClick={() => {
              setDrafts((current) => ({ ...current, [path]: document.content }));
              setReviewing(false);
            }}>Discard changes</button>
          </div>
        </div>
      ) : document?.contentType === "text" ? (
        <ol aria-label={`Read-only contents of ${path}`} className="tinyos-code-view tinyos-workspace-document__code">
          {lines.map((line, index) => {
            const lineNumber = index + 1;
            const selected = Boolean(selection && lineNumber >= selection.startLine && lineNumber <= selection.endLine);
            const matching = matches.includes(index);
            const currentMatch = matchLine === index;
            return (
              <li data-current-match={currentMatch ? "true" : undefined} data-match={matching ? "true" : undefined} data-selected={selected ? "true" : undefined} key={index} ref={currentMatch ? activeMatchRef : undefined}>
                <button aria-label={`Line ${lineNumber}`} type="button" onClick={(event) => selectLine(lineNumber, event.shiftKey)}>
                  <code dangerouslySetInnerHTML={{ __html: highlightedLines[index] ?? escapeHtml(line || " ") }} />
                </button>
              </li>
            );
          })}
        </ol>
      ) : null}
      <footer className="tinyos-workspace-document__footer">
        <span>{document?.stale ? "Snapshot may be stale" : editing ? dirty ? "Unsaved draft" : "Editable draft" : document?.contentType === "text" ? "Read-only · UTF-8" : "Read-only"}</span>
        {document?.nextCursor ? <button type="button" onClick={() => void controller.loadMoreFile(path)}>Load more</button> : null}
        {search.query && document?.nextCursor ? <span>Search covers loaded content only</span> : null}
        {selectedReference ? (
          <button draggable="true" title="Attach to Chat or drag this structured file reference" type="button" onClick={() => onAttachContext(selectedReference)} onDragStart={(event) => writeTinyOsReferenceTransfer(event.dataTransfer, { kind: "context", reference: selectedReference })}><Paperclip aria-hidden="true" size={11} />Attach L{selectedReference.startLine}{selectedReference.endLine === selectedReference.startLine ? "" : `–${selectedReference.endLine}`}</button>
        ) : null}
        {selectedReference ? (
          <button
            disabled={!canRequestChange}
            title={canRequestChange ? "Ask Agent to explain this selection" : requestChangeUnavailableReason}
            type="button"
            onClick={() => onRequestExplanation(selectedReference)}
          ><MessageCircleQuestion aria-hidden="true" size={11} />Ask Agent to explain</button>
        ) : null}
        {selectedReference ? (
          <button
            disabled={!canRequestChange}
            title={canRequestChange ? "Ask Agent to modify this selection" : requestChangeUnavailableReason}
            type="button"
            onClick={() => onRequestModification(selectedReference)}
          ><PencilLine aria-hidden="true" size={11} />Ask Agent to modify</button>
        ) : null}
        {document?.contentType === "text" && !editing ? (
          moving ? (
            <form className="tinyos-file-move" onSubmit={(event) => {
              event.preventDefault();
              const targetPath = moveTarget.trim();
              if (!targetPath) return;
              setMutationError("");
              void onMoveFile({ baseRevision: document.revision, path, targetPath }).then(async () => {
                setMutationConflict(undefined);
                setMoving(false);
                setMoveTarget("");
                controller.closeFile(path);
                await controller.refreshDirectory(parentDirectory(path));
                await controller.refreshDirectory(parentDirectory(targetPath));
                await controller.revealFile(targetPath);
              }).catch((error) => {
                const message = error instanceof Error ? error.message : String(error);
                setMutationError(message);
                setMutationConflict(fileVersionConflict(message, document.revision));
              });
            }}>
              <input aria-label={`Move ${path} to`} autoFocus placeholder="new/path/name" value={moveTarget} onChange={(event) => setMoveTarget(event.currentTarget.value)} />
              <button disabled={!canSave || !moveTarget.trim()} type="submit">Move</button>
              <button type="button" onClick={() => setMoving(false)}>Cancel</button>
            </form>
          ) : <button disabled={!canSave} title={canSave ? "Move or rename this file after revision validation" : saveUnavailableReason} type="button" onClick={() => { setMoveTarget(path); setMoving(true); }}><PencilLine aria-hidden="true" size={11} />Move / rename</button>
        ) : null}
        {document?.contentType === "text" && !editing ? (
          <button
            className="tinyos-danger-action"
            disabled={!canSave}
            title={canSave ? deleteConfirmed ? "Delete the file permanently" : "Review destructive file deletion" : saveUnavailableReason}
            type="button"
            onClick={() => {
              if (!deleteConfirmed) {
                setDeleteConfirmed(true);
                return;
              }
              setMutationError("");
              void onDeleteFile({ baseRevision: document.revision, path }).then(async () => {
                setMutationConflict(undefined);
                controller.closeFile(path);
                await controller.refreshDirectory(parentDirectory(path));
              }).catch((error) => {
                const message = error instanceof Error ? error.message : String(error);
                setMutationError(message);
                setMutationConflict(fileVersionConflict(message, document.revision));
              });
            }}
          ><Trash2 aria-hidden="true" size={11} />{deleteConfirmed ? "Confirm delete" : "Delete"}</button>
        ) : null}
        {document?.contentType === "text" && !editing ? <span title="TinyOS has no recoverable-delete contract">Permanent delete · Trash unavailable</span> : null}
        <span>{document ? `${formatBytes(document.content.length)} loaded / ${formatBytes(document.sizeBytes)}` : ""}</span>
      </footer>
      {mutationError ? <p className="tinyos-file-mutation-error" role="alert">{mutationError}</p> : null}
      {mutationConflict ? (
        <section aria-label="File revision conflict" className="tinyos-file-conflict">
          <header><AlertCircle aria-hidden="true" size={14} /><strong>Stale base revision</strong></header>
          <p>The reviewed draft is preserved. TinyOS will not overwrite the newer native file.</p>
          <dl><div><dt>Draft base</dt><dd><code>{mutationConflict.baseRevision}</code></dd></div><div><dt>Current native</dt><dd><code>{mutationConflict.currentRevision ?? "Reported without a revision"}</code></dd></div></dl>
          <button type="button" onClick={() => void controller.refreshFile(path)}>Refresh native revision</button>
        </section>
      ) : null}
    </section>
  );
}

function ExplorerResourceError({ compact = false, resource, retry }: { compact?: boolean; resource: TinyOsResourceState<unknown> | undefined; retry: () => void }) {
  const error = resource?.status === "error" ? resource.error : undefined;
  return (
    <div className="tinyos-workspace-explorer__message" data-compact={compact ? "true" : undefined} role="alert">
      <AlertCircle aria-hidden="true" size={14} />
      <span>{error?.message || "Workspace content could not be loaded."}</span>
      {error?.retryable !== false ? <button type="button" onClick={retry}>Retry</button> : null}
    </div>
  );
}

function ExplorerMessage({ compact = false, icon, text }: { compact?: boolean; icon?: "loading"; text: string }) {
  return <div aria-live="polite" className="tinyos-workspace-explorer__message" data-compact={compact ? "true" : undefined}>{icon === "loading" ? <Loader2 aria-hidden="true" className="tinyos-spin" size={14} /> : null}<span>{text}</span></div>;
}

function handleTreeKeyDown(event: KeyboardEvent<HTMLDivElement>) {
  const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button[role='treeitem']")];
  const index = rows.indexOf(document.activeElement as HTMLButtonElement);
  if (index < 0) return;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    rows[index + (event.key === "ArrowDown" ? 1 : -1)]?.focus();
  } else if (event.key === "Home" || event.key === "End") {
    event.preventDefault();
    rows[event.key === "Home" ? 0 : rows.length - 1]?.focus();
  } else if (event.key === "ArrowRight" && rows[index].getAttribute("aria-expanded") === "false") {
    event.preventDefault();
    rows[index].click();
  } else if (event.key === "ArrowLeft" && rows[index].getAttribute("aria-expanded") === "true") {
    event.preventDefault();
    rows[index].click();
  }
}

function useHighlightedLines(path: string, content: string): string[] {
  const [lines, setLines] = useState<string[]>([]);
  useEffect(() => {
    setLines([]);
    if (!content || typeof Worker === "undefined") return;
    const worker = new Worker(new URL("./tinyOsHighlight.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<{ lines: string[] }>) => setLines(event.data.lines);
    worker.postMessage({ content, language: highlightLanguage(path) });
    return () => worker.terminate();
  }, [content, path]);
  return lines;
}

function highlightLanguage(path: string): string | undefined {
  const extension = path.split(".").pop()?.toLocaleLowerCase();
  return ({
    bash: "bash", css: "css", htm: "xml", html: "xml", js: "javascript", json: "json", jsx: "javascript",
    md: "markdown", ps1: "powershell", py: "python", rs: "rust", sh: "bash", ts: "typescript", tsx: "typescript",
    xml: "xml", yaml: "yaml", yml: "yaml",
  } as Record<string, string>)[extension ?? ""];
}

function breadcrumbPaths(path: string): Array<{ label: string; value: string }> {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return [{ label: "Workspace", value: "." }, ...parts.map((label, index) => ({ label, value: parts.slice(0, index + 1).join("/") }))];
}

function fileName(path: string): string {
  return path.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? path;
}

function displayPath(path: string): string {
  return path === "." ? "Workspace root" : path;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KiB`;
  return `${(bytes / 1_048_576).toFixed(1)} MiB`;
}

function parentDirectory(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const separator = normalized.lastIndexOf("/");
  return separator > 0 ? normalized.slice(0, separator) : ".";
}

function lineChangeSummary(before: string, after: string): string {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const unchanged = beforeLines.filter((line, index) => line === afterLines[index]).length;
  const changed = Math.max(beforeLines.length, afterLines.length) - unchanged;
  return `${changed} changed line${changed === 1 ? "" : "s"} · ${before.length} → ${after.length} bytes`;
}

function fileVersionConflict(message: string, baseRevision: string): { baseRevision: string; currentRevision?: string; message: string } | undefined {
  if (!message.toLocaleLowerCase().includes("version conflict")) return undefined;
  const currentRevision = message.match(/["']revision["']\s*:\s*["']([^"']+)["']/i)?.[1];
  return { baseRevision, ...(currentRevision ? { currentRevision } : {}), message };
}

function boundedSelectionText(value: string): string {
  return value.length <= 16_384 ? value : `${value.slice(0, 16_384)}\n[selection truncated]`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;" })[character] ?? character);
}
