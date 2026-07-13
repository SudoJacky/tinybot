import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  AlertCircle,
  ArrowLeft,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  Loader2,
  MessageCircleQuestion,
  Paperclip,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { resourceValue, type TinyOsDirectoryView, type TinyOsResourceState } from "../../app-core/chat/tinyOsFilesModel";
import type { TinyOsContextReference, TinyOsLayoutMode } from "../../app-core/chat/tinyOsUiState";
import type { WorkspaceDirectoryEntry } from "../../app-core/workspace/workspaceExplorer";
import type { TinyOsFilesController } from "./useTinyOsFilesController";

export function TinyOsFilesExplorer({
  canRequestChange,
  controller,
  layoutMode,
  onAttachContext,
  onRequestExplanation,
  requestChangeUnavailableReason,
}: {
  canRequestChange: boolean;
  controller: TinyOsFilesController;
  layoutMode: TinyOsLayoutMode;
  onAttachContext: (reference: TinyOsContextReference) => void;
  onRequestExplanation: (reference: TinyOsContextReference) => void;
  requestChangeUnavailableReason?: string;
}) {
  const { state } = controller;
  const [currentDirectory, setCurrentDirectory] = useState(".");
  const directory = resourceValue(state.directories[currentDirectory]);
  const [filter, setFilter] = useState(directory?.filter ?? "");
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
            <button aria-label="Refresh current directory" title="Refresh directory" type="button" onClick={() => void controller.refreshDirectory(currentDirectory)}><RefreshCw aria-hidden="true" size={13} /></button>
          </header>
          <form className="tinyos-workspace-explorer__filter" onSubmit={(event) => { event.preventDefault(); void controller.filterDirectory(currentDirectory, filter); }}>
            <Search aria-hidden="true" size={12} />
            <input aria-label={`Filter ${displayPath(currentDirectory)}`} placeholder="Filter current folder" value={filter} onChange={(event) => setFilter(event.currentTarget.value)} />
          </form>
          <WorkspaceTree controller={controller} currentDirectory={currentDirectory} onSelectDirectory={selectDirectory} />
          <div aria-live="polite" className="tinyos-workspace-explorer__status">
            {directory?.filter ? `Filtered ${displayPath(currentDirectory)} by “${directory.filter}”` : displayPath(currentDirectory)}
          </div>
        </aside>
      ) : null}
      {showDocument ? (
        <WorkspaceDocument
          canRequestChange={canRequestChange}
          controller={controller}
          compact={layoutMode === "compact"}
          onAttachContext={onAttachContext}
          onBrowseDirectory={browseDirectory}
          onRequestExplanation={onRequestExplanation}
          requestChangeUnavailableReason={requestChangeUnavailableReason}
        />
      ) : null}
    </div>
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
  canRequestChange,
  compact,
  controller,
  onAttachContext,
  onBrowseDirectory,
  onRequestExplanation,
  requestChangeUnavailableReason,
}: {
  canRequestChange: boolean;
  compact: boolean;
  controller: TinyOsFilesController;
  onAttachContext: (reference: TinyOsContextReference) => void;
  onBrowseDirectory: (path: string) => void;
  onRequestExplanation: (reference: TinyOsContextReference) => void;
  requestChangeUnavailableReason?: string;
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
  const activeMatchRef = useRef<HTMLLIElement>(null);

  useEffect(() => {
    setAnchor(undefined);
    controller.selectLines(undefined);
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

  return (
    <section aria-label={`File ${path}`} className="tinyos-workspace-document">
      <div className="tinyos-workspace-document__tabs" role="tablist" aria-label="Open files">
        {compact ? <button aria-label="Back to workspace" title="Back to workspace" type="button" onClick={controller.showTree}><ArrowLeft aria-hidden="true" size={13} /></button> : null}
        {state.openPaths.map((openPath) => (
          <span data-active={openPath === path ? "true" : undefined} key={openPath}>
            <button aria-selected={openPath === path} role="tab" title={openPath} type="button" onClick={() => controller.activateFile(openPath)}>{fileName(openPath)}</button>
            <button aria-label={`Close ${openPath}`} title={`Close ${openPath}`} type="button" onClick={() => controller.closeFile(openPath)}><X aria-hidden="true" size={11} /></button>
          </span>
        ))}
      </div>
      <div className="tinyos-workspace-document__path">
        <nav aria-label="File breadcrumb">{breadcrumbPaths(path).map(({ label, value }) => <button aria-current={value === path ? "page" : undefined} disabled={value === path} key={value} title={value} type="button" onClick={() => onBrowseDirectory(value)}>{label}</button>)}</nav>
        <button aria-label={`Refresh ${path}`} title="Refresh file" type="button" onClick={() => void controller.refreshFile(path)}><RefreshCw aria-hidden="true" size={13} /></button>
      </div>
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
      {document?.contentType === "text" ? (
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
        <span>{document?.stale ? "Snapshot may be stale" : document?.contentType === "text" ? "Read-only · UTF-8" : "Read-only"}</span>
        {document?.nextCursor ? <button type="button" onClick={() => void controller.loadMoreFile(path)}>Load more</button> : null}
        {search.query && document?.nextCursor ? <span>Search covers loaded content only</span> : null}
        {selectedReference ? (
          <button type="button" onClick={() => onAttachContext(selectedReference)}><Paperclip aria-hidden="true" size={11} />Attach L{selectedReference.startLine}{selectedReference.endLine === selectedReference.startLine ? "" : `–${selectedReference.endLine}`}</button>
        ) : null}
        {selectedReference ? (
          <button
            disabled={!canRequestChange}
            title={canRequestChange ? "Ask Agent to explain this selection" : requestChangeUnavailableReason}
            type="button"
            onClick={() => onRequestExplanation(selectedReference)}
          ><MessageCircleQuestion aria-hidden="true" size={11} />Ask Agent to explain</button>
        ) : null}
        <span>{document ? `${formatBytes(document.content.length)} loaded / ${formatBytes(document.sizeBytes)}` : ""}</span>
      </footer>
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

function boundedSelectionText(value: string): string {
  return value.length <= 16_384 ? value : `${value.slice(0, 16_384)}\n[selection truncated]`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;" })[character] ?? character);
}
