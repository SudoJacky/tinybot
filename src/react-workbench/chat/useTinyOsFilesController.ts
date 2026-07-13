import { useCallback, useEffect, useRef, useState } from "react";
import {
  createTinyOsFilesState,
  reduceTinyOsFilesState,
  resourceValue,
  type TinyOsFileSelection,
  type TinyOsFilesAction,
  type TinyOsFilesState,
} from "../../app-core/chat/tinyOsFilesModel";
import type { WorkspaceQueryError } from "../../app-core/workspace/workspaceExplorer";
import type { WorkspaceStore } from "../services";

type WorkspaceQueries = Pick<WorkspaceStore, "listDirectory" | "readFile">;

export type TinyOsFilesController = {
  closeFile(path: string): void;
  filterDirectory(path: string, filter: string): Promise<void>;
  loadMoreDirectory(path: string): Promise<void>;
  loadMoreFile(path: string): Promise<void>;
  openFile(path: string): Promise<void>;
  refreshDirectory(path: string): Promise<void>;
  refreshFile(path: string): Promise<void>;
  selectLines(selection?: TinyOsFileSelection): void;
  setSearch(path: string, query: string, activeMatch: number): void;
  showTree(): void;
  state: TinyOsFilesState;
  toggleDirectory(path: string): Promise<void>;
  activateFile(path: string): void;
  markStale(path: string): void;
  queryAvailable: boolean;
  revealFile(path: string): Promise<void>;
};

export function useTinyOsFilesController(
  sessionKey: string,
  workspace?: WorkspaceQueries,
  enabled = true,
): TinyOsFilesController {
  const activeKey = sessionKey || "draft";
  const [states, setStates] = useState<Record<string, TinyOsFilesState>>({});
  const statesRef = useRef(states);
  const requestSequence = useRef(0);
  statesRef.current = states;
  const state = states[activeKey] ?? createTinyOsFilesState();

  const dispatchFor = useCallback((key: string, action: TinyOsFilesAction) => {
    setStates((current) => {
      const previous = current[key] ?? createTinyOsFilesState();
      const next = reduceTinyOsFilesState(previous, action);
      return next === previous ? current : { ...current, [key]: next };
    });
  }, []);

  const requestId = useCallback((kind: string, path: string) => {
    requestSequence.current += 1;
    return `${kind}:${requestSequence.current}:${path}`;
  }, []);

  const loadDirectoryFor = useCallback(async (
    key: string,
    path: string,
    options: { append?: boolean; filter?: string; initialize?: boolean } = {},
  ) => {
    const id = requestId("directory", path);
    const current = statesRef.current[key] ?? createTinyOsFilesState();
    const currentValue = resourceValue(current.directories[path]);
    const filter = options.filter ?? currentValue?.filter ?? "";
    if (options.initialize) dispatchFor(key, { requestId: id, type: "initialize" });
    else dispatchFor(key, { filter, path, requestId: id, type: "directory_loading" });
    if (!workspace) {
      const error = queryError("not_configured", "Configure a workspace to browse files.", path);
      dispatchFor(key, options.initialize
        ? { error, requestId: id, type: "initialize_failed" }
        : { error, path, requestId: id, type: "directory_failed" });
      return;
    }
    try {
      const page = await workspace.listDirectory({
        path,
        ...(options.append && currentValue?.nextCursor ? { cursor: currentValue.nextCursor } : {}),
        ...(filter ? { nameQuery: filter } : {}),
      });
      dispatchFor(key, options.initialize
        ? { page, requestId: id, type: "initialized" }
        : { append: Boolean(options.append), page, requestId: id, type: "directory_loaded" });
    } catch (error) {
      const normalized = normalizeQueryError(error, path);
      dispatchFor(key, options.initialize
        ? { error: normalized, requestId: id, type: "initialize_failed" }
        : { error: normalized, path, requestId: id, type: "directory_failed" });
    }
  }, [dispatchFor, requestId, workspace]);

  const loadFileFor = useCallback(async (
    key: string,
    path: string,
    options: { append?: boolean } = {},
  ) => {
    const id = requestId("file", path);
    const current = statesRef.current[key] ?? createTinyOsFilesState();
    const currentValue = resourceValue(current.documents[path]);
    dispatchFor(key, { path, requestId: id, type: "file_loading" });
    if (!workspace) {
      dispatchFor(key, {
        error: queryError("not_configured", "Configure a workspace to read files.", path),
        path,
        requestId: id,
        type: "file_failed",
      });
      return;
    }
    try {
      const chunk = await workspace.readFile({
        path,
        ...(options.append && currentValue?.nextCursor ? { cursor: currentValue.nextCursor } : {}),
      });
      dispatchFor(key, { append: Boolean(options.append), chunk, requestId: id, type: "file_loaded" });
    } catch (error) {
      dispatchFor(key, {
        error: normalizeQueryError(error, path),
        path,
        requestId: id,
        type: "file_failed",
      });
    }
  }, [dispatchFor, requestId, workspace]);

  useEffect(() => {
    if (!enabled) return;
    const current = statesRef.current[activeKey];
    if (!current || current.appStatus === "idle") void loadDirectoryFor(activeKey, ".", { initialize: true });
  }, [activeKey, enabled, loadDirectoryFor]);

  return {
    queryAvailable: Boolean(workspace),
    state,
    activateFile: (path) => dispatchFor(activeKey, { path, type: "activate_file" }),
    closeFile: (path) => dispatchFor(activeKey, { path, type: "close_file" }),
    filterDirectory: (path, filter) => loadDirectoryFor(activeKey, path, { filter }),
    loadMoreDirectory: (path) => loadDirectoryFor(activeKey, path, { append: true }),
    loadMoreFile: (path) => loadFileFor(activeKey, path, { append: true }),
    markStale: (path) => dispatchFor(activeKey, { path, type: "mark_stale" }),
    openFile: (path) => {
      const current = statesRef.current[activeKey] ?? createTinyOsFilesState();
      if (resourceValue(current.documents[path])) {
        dispatchFor(activeKey, { path, type: "activate_file" });
        return Promise.resolve();
      }
      return loadFileFor(activeKey, path);
    },
    refreshDirectory: (path) => {
      const current = statesRef.current[activeKey] ?? createTinyOsFilesState();
      return loadDirectoryFor(activeKey, path, { initialize: path === "." && current.appStatus !== "ready" && current.appStatus !== "empty" });
    },
    refreshFile: (path) => loadFileFor(activeKey, path),
    revealFile: async (path) => {
      const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
      const directories = parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"));
      for (const directory of directories) {
        const current = statesRef.current[activeKey] ?? createTinyOsFilesState();
        if (!current.expandedPaths.includes(directory)) dispatchFor(activeKey, { path: directory, type: "toggle_directory" });
        if (!resourceValue(current.directories[directory])) await loadDirectoryFor(activeKey, directory);
      }
      await loadFileFor(activeKey, path);
    },
    selectLines: (selection) => dispatchFor(activeKey, { selection, type: "select_lines" }),
    setSearch: (path, query, activeMatch) => dispatchFor(activeKey, { activeMatch, path, query, type: "set_search" }),
    showTree: () => dispatchFor(activeKey, { type: "show_tree" }),
    toggleDirectory: async (path) => {
      const current = statesRef.current[activeKey] ?? createTinyOsFilesState();
      const expanding = !current.expandedPaths.includes(path);
      dispatchFor(activeKey, { path, type: "toggle_directory" });
      if (expanding && !resourceValue(current.directories[path])) await loadDirectoryFor(activeKey, path);
    },
  };
}

function normalizeQueryError(error: unknown, path: string): WorkspaceQueryError {
  if (error instanceof Error && "code" in error && "retryable" in error) return error as WorkspaceQueryError;
  return queryError("io_error", error instanceof Error ? error.message : String(error), path, true);
}

function queryError(
  code: WorkspaceQueryError["code"],
  message: string,
  path: string,
  retryable = false,
): WorkspaceQueryError {
  return Object.assign(new Error(message), { code, path, retryable });
}
