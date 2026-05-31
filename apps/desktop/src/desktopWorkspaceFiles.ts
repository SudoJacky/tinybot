import {
  buildDesktopWorkspaceContentExport,
  normalizeDesktopExportResult,
  type DesktopFileExportRequest,
} from "./desktopFileExport";
import { buildDesktopFileTaskOperation } from "./desktopTaskCenterSources";
import type { DesktopTaskSourceOperation } from "./desktopTaskCenter";

export type DesktopWorkspaceSaveState = "idle" | "dirty" | "saving" | "saved" | "protected-path-error" | "conflict-error" | "error";

export interface DesktopWorkspaceFileRow {
  path: string;
  exists: boolean;
  updatedAt: string | null;
  meta: string;
}

export interface DesktopWorkspaceFileState {
  files: DesktopWorkspaceFileRow[];
  recentPaths: string[];
  activePath: string | null;
  activeUpdatedAt: string | null;
  draft: string;
  savedDraft: string;
  dirty: boolean;
  saveState: DesktopWorkspaceSaveState;
  error: string | null;
  exportedPath: string | null;
}

export interface DesktopWorkspaceFilePayload {
  path?: unknown;
  content?: unknown;
  updated_at?: unknown;
  exists?: unknown;
}

export interface DesktopWorkspaceSaveBody {
  content: string;
  expected_updated_at: string | null;
}

export interface DesktopWorkspaceSaveRequest {
  path: string;
  body: DesktopWorkspaceSaveBody;
}

export interface DesktopWorkspaceRevealRequest {
  path: string;
}

export interface DesktopWorkspaceFileActions {
  targetDocument?: Document;
  listWorkspaceFiles: () => Promise<unknown>;
  loadWorkspaceFile: (path: string) => Promise<unknown>;
  saveWorkspaceFile: (path: string, body: DesktopWorkspaceSaveBody) => Promise<unknown>;
  revealWorkspaceFile?: (path: string) => Promise<unknown>;
  exportWorkspaceFile?: (request: DesktopFileExportRequest) => Promise<unknown>;
  onFileTaskUpdated?: (operation: DesktopTaskSourceOperation) => void;
}

export function buildDesktopWorkspaceFileRows(payload: unknown): DesktopWorkspaceFileRow[] {
  const items = isRecord(payload) && Array.isArray(payload.items) ? payload.items : [];
  return items
    .filter(isRecord)
    .map((item) => {
      const path = stringValue(item.path);
      const exists = item.exists !== false;
      const updatedAt = typeof item.updated_at === "string" ? item.updated_at : null;
      return {
        path,
        exists,
        updatedAt,
        meta: exists ? (updatedAt ? `Updated ${updatedAt}` : "Available") : "Not created",
      };
    })
    .filter((row) => row.path);
}

export function updateDesktopWorkspaceRecentFiles(
  recentPaths: readonly string[],
  path: string,
  limit = 6,
): string[] {
  const cleanPath = path.trim();
  if (!cleanPath) {
    return [...recentPaths];
  }
  return [cleanPath, ...recentPaths.filter((item) => item !== cleanPath)].slice(0, limit);
}

export function createDesktopWorkspaceFileState(
  previous: DesktopWorkspaceFileState | undefined = undefined,
  payload?: unknown,
): DesktopWorkspaceFileState {
  if (!isRecord(payload)) {
    return {
      files: previous?.files ?? [],
      recentPaths: previous?.recentPaths ?? [],
      activePath: previous?.activePath ?? null,
      activeUpdatedAt: previous?.activeUpdatedAt ?? null,
      draft: previous?.draft ?? "",
      savedDraft: previous?.savedDraft ?? "",
      dirty: previous?.dirty ?? false,
      saveState: previous?.saveState ?? "idle",
      error: previous?.error ?? null,
      exportedPath: previous?.exportedPath ?? null,
    };
  }

  const path = stringValue(payload.path) || previous?.activePath || "";
  const content = stringValue(payload.content);
  const updatedAt = typeof payload.updated_at === "string" ? payload.updated_at : null;
  return {
    files: previous?.files ?? [],
    recentPaths: updateDesktopWorkspaceRecentFiles(previous?.recentPaths ?? [], path),
    activePath: path,
    activeUpdatedAt: updatedAt,
    draft: content,
    savedDraft: content,
    dirty: false,
    saveState: previous?.dirty ? "saved" : "idle",
    error: null,
    exportedPath: null,
  };
}

export function applyDesktopWorkspaceDraft(
  state: DesktopWorkspaceFileState,
  draft: string,
): DesktopWorkspaceFileState {
  const dirty = draft !== state.savedDraft;
  return {
    ...state,
    draft,
    dirty,
    saveState: dirty ? "dirty" : "idle",
    error: dirty ? null : state.error,
    exportedPath: dirty ? null : state.exportedPath,
  };
}

export function buildDesktopWorkspaceSaveRequest(
  state: DesktopWorkspaceFileState,
): DesktopWorkspaceSaveRequest | null {
  if (!state.activePath) {
    return null;
  }
  return {
    path: state.activePath,
    body: {
      content: state.draft,
      expected_updated_at: state.activeUpdatedAt,
    },
  };
}

export function buildDesktopWorkspaceRevealRequest(
  state: DesktopWorkspaceFileState,
): DesktopWorkspaceRevealRequest | null {
  return state.activePath ? { path: state.activePath } : null;
}

export function buildDesktopWorkspaceExportRequest(
  state: DesktopWorkspaceFileState,
): DesktopFileExportRequest | null {
  return state.activePath ? buildDesktopWorkspaceContentExport({ path: state.activePath, contents: state.draft }) : null;
}

export function normalizeDesktopWorkspaceSaveError(
  error: unknown,
  state: DesktopWorkspaceFileState,
): DesktopWorkspaceFileState {
  const message = stringifyError(error);
  if (message.includes("409")) {
    return {
      ...state,
      dirty: true,
      saveState: "conflict-error",
      error: "Workspace file changed outside this editor. Reload before saving.",
    };
  }
  if (message.includes("404") || message.toLowerCase().includes("not editable") || message.toLowerCase().includes("protected")) {
    return {
      ...state,
      dirty: true,
      saveState: "protected-path-error",
      error: "This path is not editable from the desktop workspace.",
    };
  }
  return {
    ...state,
    dirty: true,
    saveState: "error",
    error: message,
  };
}

export function normalizeDesktopWorkspaceRevealError(
  error: unknown,
  state: DesktopWorkspaceFileState,
): DesktopWorkspaceFileState {
  const message = stringifyError(error);
  if (message.toLowerCase().includes("not revealable") || message.toLowerCase().includes("protected")) {
    return {
      ...state,
      saveState: "protected-path-error",
      error: "This path cannot be revealed from the desktop workspace.",
    };
  }
  return {
    ...state,
    saveState: "error",
    error: `Failed to reveal workspace file: ${message}`,
  };
}

export function installDesktopWorkspaceFileActions({
  targetDocument = document,
  listWorkspaceFiles,
  loadWorkspaceFile,
  saveWorkspaceFile,
  revealWorkspaceFile,
  exportWorkspaceFile,
  onFileTaskUpdated,
}: DesktopWorkspaceFileActions): void {
  let state = createDesktopWorkspaceFileState();
  const editor = targetDocument.querySelector<HTMLTextAreaElement>("#desktop-workspace-editor");
  const saveButton = targetDocument.querySelector<HTMLButtonElement>("#desktop-workspace-save");
  const revealButton = targetDocument.querySelector<HTMLButtonElement>("#desktop-workspace-reveal");
  const exportButton = targetDocument.querySelector<HTMLButtonElement>("#desktop-workspace-export");

  editor?.addEventListener("input", () => {
    state = applyDesktopWorkspaceDraft(state, editor.value);
    renderWorkspaceState(targetDocument, state, undefined, Boolean(revealWorkspaceFile), Boolean(exportWorkspaceFile));
  });

  saveButton?.addEventListener("click", () => {
    void saveActiveWorkspaceFile();
  });

  revealButton?.addEventListener("click", () => {
    void revealActiveWorkspaceFile();
  });

  exportButton?.addEventListener("click", () => {
    void exportActiveWorkspaceFile();
  });

  void loadWorkspaceFiles();

  async function loadWorkspaceFiles(): Promise<void> {
    try {
      const rows = buildDesktopWorkspaceFileRows(await listWorkspaceFiles());
      state = {
        ...state,
        files: rows,
        recentPaths: rows.map((row) => row.path).slice(0, 6),
      };
      renderWorkspaceState(
        targetDocument,
        state,
        (path) => {
          void loadWorkspaceFileByPath(path);
        },
        Boolean(revealWorkspaceFile),
        Boolean(exportWorkspaceFile),
      );
    } catch (error) {
      state = { ...state, saveState: "error", error: `Failed to load workspace files: ${stringifyError(error)}` };
      renderWorkspaceState(targetDocument, state, undefined, Boolean(revealWorkspaceFile), Boolean(exportWorkspaceFile));
    }
  }

  async function loadWorkspaceFileByPath(path: string): Promise<void> {
    try {
      state = createDesktopWorkspaceFileState(state, await loadWorkspaceFile(path));
      renderWorkspaceState(
        targetDocument,
        state,
        (nextPath) => {
          void loadWorkspaceFileByPath(nextPath);
        },
        Boolean(revealWorkspaceFile),
        Boolean(exportWorkspaceFile),
      );
    } catch (error) {
      state = { ...state, saveState: "error", error: `Failed to load workspace file: ${stringifyError(error)}` };
      renderWorkspaceState(targetDocument, state, undefined, Boolean(revealWorkspaceFile), Boolean(exportWorkspaceFile));
    }
  }

  async function saveActiveWorkspaceFile(): Promise<void> {
    const request = buildDesktopWorkspaceSaveRequest(state);
    if (!request) {
      return;
    }
    state = { ...state, saveState: "saving", error: null };
    onFileTaskUpdated?.(workspaceFileOperation(request.path, "save", "saving"));
    renderWorkspaceState(targetDocument, state, undefined, Boolean(revealWorkspaceFile), Boolean(exportWorkspaceFile));
    try {
      const result = await saveWorkspaceFile(request.path, request.body);
      const resultRecord = isRecord(result) ? result : {};
      state = createDesktopWorkspaceFileState(state, {
        path: stringValue(resultRecord.path) || request.path,
        content: request.body.content,
        updated_at: resultRecord.updated_at,
        exists: true,
      });
      renderWorkspaceState(
        targetDocument,
        state,
        (path) => {
          void loadWorkspaceFileByPath(path);
        },
        Boolean(revealWorkspaceFile),
        Boolean(exportWorkspaceFile),
      );
      onFileTaskUpdated?.(workspaceFileOperation(request.path, "save", "completed"));
      await loadWorkspaceFiles();
    } catch (error) {
      state = normalizeDesktopWorkspaceSaveError(error, state);
      onFileTaskUpdated?.(workspaceFileOperation(request.path, "save", "failed", {
        detail: state.error ?? "Workspace save failed",
        error: stringifyError(error),
        retryable: true,
      }));
      renderWorkspaceState(
        targetDocument,
        state,
        (path) => {
          void loadWorkspaceFileByPath(path);
        },
        Boolean(revealWorkspaceFile),
        Boolean(exportWorkspaceFile),
      );
    }
  }

  async function revealActiveWorkspaceFile(): Promise<void> {
    const request = buildDesktopWorkspaceRevealRequest(state);
    if (!request || !revealWorkspaceFile) {
      return;
    }
    state = { ...state, error: null };
    renderWorkspaceState(
      targetDocument,
      state,
      (path) => {
        void loadWorkspaceFileByPath(path);
      },
      true,
      Boolean(exportWorkspaceFile),
    );
    try {
      await revealWorkspaceFile(request.path);
    } catch (error) {
      state = normalizeDesktopWorkspaceRevealError(error, state);
      renderWorkspaceState(
        targetDocument,
        state,
        (path) => {
          void loadWorkspaceFileByPath(path);
        },
        true,
        Boolean(exportWorkspaceFile),
      );
    }
  }

  async function exportActiveWorkspaceFile(): Promise<void> {
    const request = buildDesktopWorkspaceExportRequest(state);
    if (!request || !exportWorkspaceFile) {
      return;
    }
    state = { ...state, saveState: "saving", error: null };
    onFileTaskUpdated?.(workspaceFileOperation(state.activePath, "export", "exporting"));
    renderWorkspaceState(targetDocument, state, undefined, Boolean(revealWorkspaceFile), true);
    try {
      const result = await exportWorkspaceFile(request);
      const exportedPath = normalizeDesktopExportResult(result);
      state = {
        ...state,
        saveState: exportedPath ? "saved" : state.dirty ? "dirty" : "idle",
        exportedPath,
        error: null,
      };
      renderWorkspaceState(
        targetDocument,
        state,
        (path) => {
          void loadWorkspaceFileByPath(path);
        },
        Boolean(revealWorkspaceFile),
        true,
      );
      onFileTaskUpdated?.(workspaceFileOperation(state.activePath, "export", "completed", {
        detail: exportedPath ? `Exported to ${exportedPath}` : "Export canceled",
      }));
    } catch (error) {
      state = { ...state, saveState: "error", error: `Failed to export workspace file: ${stringifyError(error)}` };
      onFileTaskUpdated?.(workspaceFileOperation(state.activePath, "export", "failed", {
        detail: "Workspace export failed",
        error: stringifyError(error),
        retryable: true,
      }));
      renderWorkspaceState(
        targetDocument,
        state,
        (path) => {
          void loadWorkspaceFileByPath(path);
        },
        Boolean(revealWorkspaceFile),
        true,
      );
    }
  }
}

function workspaceFileOperation(
  path: string | null,
  action: "save" | "export",
  status: string,
  options: { detail?: string; error?: string; retryable?: boolean } = {},
): DesktopTaskSourceOperation {
  const cleanPath = path || "workspace file";
  const title = `${action === "save" ? "Save" : "Export"} ${fileNameFromPath(cleanPath) || cleanPath}`;
  return buildDesktopFileTaskOperation({
    id: `workspace:${cleanPath}:${action}`,
    title,
    status,
    path: cleanPath,
    detail: options.detail,
    error: options.error,
    retryable: options.retryable,
  });
}

function renderWorkspaceState(
  targetDocument: Document,
  state: DesktopWorkspaceFileState,
  onSelect?: (path: string) => void,
  canReveal = false,
  canExport = false,
): void {
  const recent = targetDocument.querySelector<HTMLElement>("#desktop-workspace-recent-files");
  if (recent) {
    const rows = state.recentPaths.length
      ? state.recentPaths
      : state.files.map((file) => file.path).slice(0, 6);
    recent.replaceChildren(
      ...rows.map((path) => {
        const button = targetDocument.createElement("button");
        button.type = "button";
        button.className = "desktop-workspace-file-row";
        button.setAttribute("data-desktop-workspace-file", path);
        button.setAttribute("data-desktop-entity-module", "workspace");
        button.setAttribute("data-desktop-entity-id", path);
        const meta = state.files.find((file) => file.path === path)?.meta ?? "Recent";
        button.textContent = `${path} ${meta}`;
        button.addEventListener("click", () => onSelect?.(path));
        return button;
      }),
    );
  }

  setText(targetDocument, "#desktop-workspace-active-path", state.activePath ? `Active path: ${state.activePath}` : "No workspace file selected.");
  setText(targetDocument, "#desktop-workspace-save-state", workspaceSaveStateText(state));
  setText(targetDocument, "#desktop-workspace-error", state.error ?? "");

  const editor = targetDocument.querySelector<HTMLTextAreaElement>("#desktop-workspace-editor");
  if (editor && editor.value !== state.draft) {
    editor.value = state.draft;
  }
  const save = targetDocument.querySelector<HTMLButtonElement>("#desktop-workspace-save");
  if (save) {
    save.disabled = !state.activePath || !state.dirty || state.saveState === "saving";
  }
  const reveal = targetDocument.querySelector<HTMLButtonElement>("#desktop-workspace-reveal");
  if (reveal) {
    reveal.disabled = !state.activePath || !canReveal || state.saveState === "saving";
  }
  const exportButton = targetDocument.querySelector<HTMLButtonElement>("#desktop-workspace-export");
  if (exportButton) {
    exportButton.disabled = !state.activePath || !canExport || state.saveState === "saving";
  }
}

function workspaceSaveStateText(state: DesktopWorkspaceFileState): string {
  if (state.saveState === "dirty") {
    return "Unsaved changes";
  }
  if (state.saveState === "saving") {
    return "Saving workspace file";
  }
  if (state.saveState === "saved") {
    if (state.exportedPath) {
      return `Exported to ${state.exportedPath}`;
    }
    return "Saved";
  }
  if (state.saveState === "protected-path-error") {
    return "Protected path blocked";
  }
  if (state.saveState === "conflict-error") {
    return "Save conflict";
  }
  if (state.saveState === "error") {
    return "Workspace file error";
  }
  return state.activePath ? "No unsaved changes" : "Select a workspace file";
}

function setText(targetDocument: Document, selector: string, value: string): void {
  const element = targetDocument.querySelector<HTMLElement>(selector);
  if (element) {
    element.textContent = value;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function fileNameFromPath(path = ""): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? "";
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
