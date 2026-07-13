import type {
  WorkspaceDirectoryEntry,
  WorkspaceDirectoryPage,
  WorkspaceFileChunk,
  WorkspaceQueryError,
} from "../workspace/workspaceExplorer";

export type TinyOsResourceState<T> =
  | { status: "idle" }
  | { requestId: string; status: "loading" }
  | { status: "ready"; value: T }
  | { requestId: string; status: "refreshing"; value: T }
  | { error: WorkspaceQueryError; previous?: T; status: "error" };

export type TinyOsDirectoryView = {
  entries: WorkspaceDirectoryEntry[];
  filter: string;
  listingRevision: string;
  nextCursor?: string;
  path: string;
};

export type TinyOsDocumentView = {
  content: string;
  contentType: WorkspaceFileChunk["contentType"];
  lineEnd?: number;
  nextCursor?: string;
  path: string;
  revision: string;
  sizeBytes: number;
  stale: boolean;
  updatedAt?: string;
};

export type TinyOsFileSelection = {
  endLine: number;
  path: string;
  selectedText: string;
  startLine: number;
};

export type TinyOsFilesState = {
  activePath?: string;
  appStatus: "idle" | "loading" | "not_configured" | "capability_denied" | "root_unavailable" | "empty" | "ready";
  compactSurface: "tree" | "document";
  directories: Record<string, TinyOsResourceState<TinyOsDirectoryView>>;
  documents: Record<string, TinyOsResourceState<TinyOsDocumentView>>;
  expandedPaths: string[];
  mruPaths: string[];
  openPaths: string[];
  searchByPath: Record<string, { activeMatch: number; query: string }>;
  selection?: TinyOsFileSelection;
  workspaceKey?: string;
};

export type TinyOsFilesAction =
  | { requestId: string; type: "initialize" }
  | { page: WorkspaceDirectoryPage; requestId: string; type: "initialized" }
  | { error: WorkspaceQueryError; requestId: string; type: "initialize_failed" }
  | { path: string; type: "toggle_directory" }
  | { filter: string; path: string; requestId: string; type: "directory_loading" }
  | { append: boolean; page: WorkspaceDirectoryPage; requestId: string; type: "directory_loaded" }
  | { error: WorkspaceQueryError; path: string; requestId: string; type: "directory_failed" }
  | { path: string; requestId: string; type: "file_loading" }
  | { append: boolean; chunk: WorkspaceFileChunk; requestId: string; type: "file_loaded" }
  | { error: WorkspaceQueryError; path: string; requestId: string; type: "file_failed" }
  | { path: string; type: "activate_file" }
  | { path: string; type: "close_file" }
  | { type: "show_tree" }
  | { path: string; type: "mark_stale" }
  | { selection?: TinyOsFileSelection; type: "select_lines" }
  | { activeMatch: number; path: string; query: string; type: "set_search" };

export function createTinyOsFilesState(): TinyOsFilesState {
  return {
    appStatus: "idle",
    compactSurface: "tree",
    directories: {},
    documents: {},
    expandedPaths: [],
    mruPaths: [],
    openPaths: [],
    searchByPath: {},
  };
}

export function reduceTinyOsFilesState(state: TinyOsFilesState, action: TinyOsFilesAction): TinyOsFilesState {
  switch (action.type) {
    case "initialize":
      return {
        ...state,
        appStatus: "loading",
        directories: { ...state.directories, ".": { requestId: action.requestId, status: "loading" } },
      };
    case "initialized":
      if (!matchesRequest(state.directories["."], action.requestId)) return state;
      if (state.workspaceKey && action.page.workspaceKey && state.workspaceKey !== action.page.workspaceKey) {
        return {
          ...createTinyOsFilesState(),
          appStatus: action.page.entries.length ? "ready" : "empty",
          directories: { ".": { status: "ready", value: directoryView(action.page, "") } },
          expandedPaths: ["."],
          workspaceKey: action.page.workspaceKey,
        };
      }
      return {
        ...state,
        appStatus: action.page.entries.length ? "ready" : "empty",
        directories: { ...state.directories, ".": { status: "ready", value: directoryView(action.page, "") } },
        expandedPaths: unique([".", ...state.expandedPaths]),
        workspaceKey: action.page.workspaceKey ?? state.workspaceKey,
      };
    case "initialize_failed":
      if (!matchesRequest(state.directories["."], action.requestId)) return state;
      return {
        ...state,
        appStatus: appStatusForError(action.error),
        directories: { ...state.directories, ".": { error: action.error, status: "error" } },
      };
    case "toggle_directory":
      return {
        ...state,
        expandedPaths: state.expandedPaths.includes(action.path)
          ? state.expandedPaths.filter((path) => path !== action.path)
          : [...state.expandedPaths, action.path],
      };
    case "directory_loading": {
      const current = state.directories[action.path];
      const previous = resourceValue(current);
      return {
        ...state,
        directories: {
          ...state.directories,
          [action.path]: previous
            ? { requestId: action.requestId, status: "refreshing", value: { ...previous, filter: action.filter } }
            : { requestId: action.requestId, status: "loading" },
        },
      };
    }
    case "directory_loaded": {
      const current = state.directories[action.page.path];
      if (!matchesRequest(current, action.requestId)) return state;
      if (action.page.path === "." && state.workspaceKey && action.page.workspaceKey && state.workspaceKey !== action.page.workspaceKey) {
        return {
          ...createTinyOsFilesState(),
          appStatus: action.page.entries.length ? "ready" : "empty",
          directories: { ".": { status: "ready", value: directoryView(action.page, "") } },
          expandedPaths: ["."],
          workspaceKey: action.page.workspaceKey,
        };
      }
      const previous = resourceValue(current);
      const filter = previous?.filter ?? "";
      const value = directoryView(action.page, filter);
      return {
        ...state,
        appStatus: action.page.path === "."
          ? (value.entries.length ? "ready" : "empty")
          : state.appStatus,
        directories: {
          ...state.directories,
          [action.page.path]: {
            status: "ready",
            value: action.append && previous
              ? { ...value, entries: mergeEntries(previous.entries, value.entries) }
              : value,
          },
        },
      };
    }
    case "directory_failed": {
      const current = state.directories[action.path];
      if (!matchesRequest(current, action.requestId)) return state;
      return {
        ...state,
        appStatus: action.path === "." ? appStatusForError(action.error) : state.appStatus,
        directories: {
          ...state.directories,
          [action.path]: { error: action.error, previous: resourceValue(current), status: "error" },
        },
      };
    }
    case "file_loading": {
      const current = state.documents[action.path];
      const previous = resourceValue(current);
      return {
        ...state,
        activePath: action.path,
        compactSurface: "document",
        documents: {
          ...state.documents,
          [action.path]: previous
            ? { requestId: action.requestId, status: "refreshing", value: previous }
            : { requestId: action.requestId, status: "loading" },
        },
        mruPaths: focusOrder(state.mruPaths, action.path),
        openPaths: unique([...state.openPaths, action.path]),
        selection: state.selection?.path === action.path ? state.selection : undefined,
      };
    }
    case "file_loaded": {
      const current = state.documents[action.chunk.path];
      if (!matchesRequest(current, action.requestId)) return state;
      const previous = resourceValue(current);
      const next = documentView(action.chunk, action.append ? previous : undefined);
      return {
        ...state,
        documents: { ...state.documents, [action.chunk.path]: { status: "ready", value: next } },
        selection: action.append ? state.selection : undefined,
      };
    }
    case "file_failed": {
      const current = state.documents[action.path];
      if (!matchesRequest(current, action.requestId)) return state;
      return {
        ...state,
        documents: {
          ...state.documents,
          [action.path]: { error: action.error, previous: resourceValue(current), status: "error" },
        },
      };
    }
    case "activate_file":
      if (!state.openPaths.includes(action.path)) return state;
      return {
        ...state,
        activePath: action.path,
        compactSurface: "document",
        mruPaths: focusOrder(state.mruPaths, action.path),
        selection: state.selection?.path === action.path ? state.selection : undefined,
      };
    case "close_file": {
      const openPaths = state.openPaths.filter((path) => path !== action.path);
      const mruPaths = state.mruPaths.filter((path) => path !== action.path);
      const activePath = state.activePath === action.path ? mruPaths[mruPaths.length - 1] : state.activePath;
      return {
        ...state,
        activePath,
        compactSurface: activePath ? state.compactSurface : "tree",
        mruPaths,
        openPaths,
        selection: state.selection?.path === action.path ? undefined : state.selection,
      };
    }
    case "show_tree":
      return { ...state, compactSurface: "tree" };
    case "mark_stale": {
      const current = state.documents[action.path];
      const value = resourceValue(current);
      if (!value) return state;
      return { ...state, documents: { ...state.documents, [action.path]: { status: "ready", value: { ...value, stale: true } } } };
    }
    case "select_lines":
      return { ...state, selection: action.selection };
    case "set_search":
      return {
        ...state,
        searchByPath: { ...state.searchByPath, [action.path]: { activeMatch: action.activeMatch, query: action.query } },
      };
  }
}

export function resourceValue<T>(resource: TinyOsResourceState<T> | undefined): T | undefined {
  if (!resource) return undefined;
  if (resource.status === "ready" || resource.status === "refreshing") return resource.value;
  if (resource.status === "error") return resource.previous;
  return undefined;
}

function matchesRequest(resource: TinyOsResourceState<unknown> | undefined, requestId: string): boolean {
  return Boolean(resource && (resource.status === "loading" || resource.status === "refreshing") && resource.requestId === requestId);
}

function directoryView(page: WorkspaceDirectoryPage, filter: string): TinyOsDirectoryView {
  return {
    entries: page.entries,
    filter,
    listingRevision: page.listingRevision,
    nextCursor: page.nextCursor,
    path: page.path,
  };
}

function documentView(chunk: WorkspaceFileChunk, previous?: TinyOsDocumentView): TinyOsDocumentView {
  return {
    content: `${previous?.content ?? ""}${chunk.content ?? ""}`,
    contentType: chunk.contentType,
    lineEnd: chunk.lineEnd ?? previous?.lineEnd,
    nextCursor: chunk.nextCursor,
    path: chunk.path,
    revision: chunk.revision,
    sizeBytes: chunk.sizeBytes,
    stale: false,
    updatedAt: chunk.updatedAt,
  };
}

function appStatusForError(error: WorkspaceQueryError): TinyOsFilesState["appStatus"] {
  if (error.code === "not_configured") return "not_configured";
  if (error.code === "capability_denied") return "capability_denied";
  return "root_unavailable";
}

function mergeEntries(left: WorkspaceDirectoryEntry[], right: WorkspaceDirectoryEntry[]): WorkspaceDirectoryEntry[] {
  const entries = new Map(left.map((entry) => [entry.path, entry]));
  right.forEach((entry) => entries.set(entry.path, entry));
  return [...entries.values()];
}

function focusOrder(paths: string[], path: string): string[] {
  return [...paths.filter((candidate) => candidate !== path), path];
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}
