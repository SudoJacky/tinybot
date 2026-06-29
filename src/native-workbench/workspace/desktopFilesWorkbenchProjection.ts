import type { DesktopWorkspaceFileState } from "./desktopWorkspaceFiles";

export type DesktopFilesWorkbenchScope = "session" | "knowledge" | "workspace";
export type DesktopFilesWorkbenchJobState = "queued" | "running" | "complete" | "failed";

export interface DesktopFilesWorkbenchSessionFile {
  id: string;
  name: string;
  status: string;
  sizeBytes?: number;
  mimeType?: string;
  updatedAt?: string;
  actions: string[];
}

export interface DesktopFilesWorkbenchKnowledgeDocument {
  id: string;
  title: string;
  path: string;
  status: string;
  references: number;
  collection: string;
}

export interface DesktopFilesWorkbenchUploadJob {
  id: string;
  destination: DesktopFilesWorkbenchScope;
  label: string;
  progress: number;
  state: DesktopFilesWorkbenchJobState;
}

export interface DesktopFilesWorkbenchPromotionJob {
  id: string;
  sourceId: string;
  collection: string;
  progress: number;
  state: DesktopFilesWorkbenchJobState;
}

export interface DesktopFilesWorkbenchProjectionInput {
  activeScope: DesktopFilesWorkbenchScope;
  workspaceState: DesktopWorkspaceFileState;
  sessionFiles?: DesktopFilesWorkbenchSessionFile[];
  knowledgeDocuments?: DesktopFilesWorkbenchKnowledgeDocument[];
  selectedIds?: Set<string>;
  uploadJobs?: DesktopFilesWorkbenchUploadJob[];
  promotionJobs?: DesktopFilesWorkbenchPromotionJob[];
}

export interface DesktopFilesWorkbenchProjection {
  scopeTabs: DesktopFilesWorkbenchScopeTab[];
  toolbar: {
    scope: DesktopFilesWorkbenchScope;
    searchQuery: string;
    filters: string[];
    actions: string[];
  };
  table: {
    columns: string[];
    rows: DesktopFilesWorkbenchTableRow[];
  };
  detail: DesktopFilesWorkbenchDetail | null;
  editor: DesktopFilesWorkbenchEditor | null;
  uploadDestinations: DesktopFilesWorkbenchUploadDestination[];
  jobs: DesktopFilesWorkbenchJob[];
}

export interface DesktopFilesWorkbenchScopeTab {
  id: DesktopFilesWorkbenchScope;
  label: string;
  count: number;
  active: boolean;
}

export interface DesktopFilesWorkbenchTableRow {
  id: string;
  name: string;
  scope: DesktopFilesWorkbenchScope;
  status: string;
  updated: string;
  meta: string;
  selected: boolean;
  actions: string[];
}

export interface DesktopFilesWorkbenchDetail {
  id: string;
  title: string;
  scope: DesktopFilesWorkbenchScope;
  metadata: string[];
  preview: string;
  references: string[];
  actions: string[];
}

export interface DesktopFilesWorkbenchEditor {
  activePath: string;
  dirty: boolean;
  saveState: DesktopWorkspaceFileState["saveState"];
  diff: {
    before: string;
    after: string;
  };
  conflict: {
    hasConflict: boolean;
    message: string;
  };
  actions: string[];
}

export interface DesktopFilesWorkbenchUploadDestination {
  id: DesktopFilesWorkbenchScope;
  label: string;
  active: boolean;
}

export interface DesktopFilesWorkbenchJob {
  id: string;
  label: string;
  destination: DesktopFilesWorkbenchScope;
  progress: number;
  state: DesktopFilesWorkbenchJobState;
}

const TABLE_COLUMNS = ["name", "scope", "status", "updated", "meta", "actions"];

export function buildDesktopFilesWorkbenchProjection(
  input: DesktopFilesWorkbenchProjectionInput,
): DesktopFilesWorkbenchProjection {
  const sessionFiles = input.sessionFiles ?? [];
  const knowledgeDocuments = input.knowledgeDocuments ?? [];
  const allRows = [
    ...sessionFiles.map((file) => sessionRow(file, input.selectedIds)),
    ...knowledgeDocuments.map((document) => knowledgeRow(document, input.selectedIds)),
    ...input.workspaceState.files.map((file) => workspaceRow(file, input.workspaceState, input.selectedIds)),
  ];
  const rows = allRows.filter((row) => row.scope === input.activeScope);

  return {
    scopeTabs: [
      scopeTab("session", "Session", sessionFiles.length, input.activeScope),
      scopeTab("knowledge", "Knowledge", knowledgeDocuments.length, input.activeScope),
      scopeTab("workspace", "Workspace", input.workspaceState.files.length, input.activeScope),
    ],
    toolbar: buildToolbar(input),
    table: {
      columns: [...TABLE_COLUMNS],
      rows,
    },
    detail: buildDetail(input, allRows),
    editor: buildEditor(input.workspaceState),
    uploadDestinations: uploadDestinations(input.activeScope),
    jobs: [
      ...(input.uploadJobs ?? []).map((job) => ({ ...job })),
      ...(input.promotionJobs ?? []).map((job) => ({
        id: job.id,
        label: `Promote ${job.sourceId} to ${job.collection}`,
        destination: "knowledge" as const,
        progress: job.progress,
        state: job.state,
      })),
    ],
  };
}

function buildToolbar(input: DesktopFilesWorkbenchProjectionInput): DesktopFilesWorkbenchProjection["toolbar"] {
  return {
    scope: input.activeScope,
    searchQuery: input.workspaceState.searchQuery,
    filters: ["all", "recent", "dirty", "conflicts"],
    actions: ["upload", "refresh", "promote-to-knowledge"],
  };
}

function buildDetail(
  input: DesktopFilesWorkbenchProjectionInput,
  rows: DesktopFilesWorkbenchTableRow[],
): DesktopFilesWorkbenchDetail | null {
  const activeWorkspaceId = input.workspaceState.activePath ? workspaceId(input.workspaceState.activePath) : "";
  const activeRow = rows.find((row) => row.id === activeWorkspaceId)
    ?? rows.find((row) => row.scope === input.activeScope)
    ?? rows[0];
  if (!activeRow) {
    return null;
  }
  if (activeRow.scope === "workspace" && input.workspaceState.activePath) {
    return {
      id: activeRow.id,
      title: input.workspaceState.activePath,
      scope: "workspace",
      metadata: [
        formatBytes(input.workspaceState.activeSizeBytes),
        input.workspaceState.activeUpdatedAt ? `Updated ${input.workspaceState.activeUpdatedAt}` : "Not saved",
        workspaceStatusLabel(input.workspaceState),
      ].filter(Boolean),
      preview: input.workspaceState.draft,
      references: [],
      actions: ["save", "reload", "reveal", "open-external", "promote-to-knowledge"],
    };
  }
  return {
    id: activeRow.id,
    title: activeRow.name,
    scope: activeRow.scope,
    metadata: [activeRow.meta, activeRow.updated, activeRow.status].filter(Boolean),
    preview: "",
    references: activeRow.scope === "knowledge" ? [activeRow.id] : [],
    actions: activeRow.actions,
  };
}

function buildEditor(state: DesktopWorkspaceFileState): DesktopFilesWorkbenchEditor | null {
  if (!state.activePath) {
    return null;
  }
  return {
    activePath: state.activePath,
    dirty: state.dirty,
    saveState: state.saveState,
    diff: {
      before: state.savedDraft,
      after: state.draft,
    },
    conflict: {
      hasConflict: state.saveState === "conflict-error",
      message: state.saveState === "conflict-error" ? state.error ?? "" : "",
    },
    actions: ["save", "reload", "reveal", "open-external"],
  };
}

function sessionRow(
  file: DesktopFilesWorkbenchSessionFile,
  selectedIds: Set<string> | undefined,
): DesktopFilesWorkbenchTableRow {
  const id = `session:${file.id}`;
  return {
    id,
    name: file.name,
    scope: "session",
    status: file.status,
    updated: file.updatedAt ?? "",
    meta: [file.mimeType, formatBytes(file.sizeBytes)].filter(Boolean).join(" / "),
    selected: Boolean(selectedIds?.has(id)),
    actions: [...file.actions],
  };
}

function knowledgeRow(
  document: DesktopFilesWorkbenchKnowledgeDocument,
  selectedIds: Set<string> | undefined,
): DesktopFilesWorkbenchTableRow {
  const id = `knowledge:${document.id}`;
  return {
    id,
    name: document.title,
    scope: "knowledge",
    status: document.status,
    updated: document.collection,
    meta: `${document.references} references`,
    selected: Boolean(selectedIds?.has(id)),
    actions: ["open", "use-in-chat", "promote-refresh"],
  };
}

function workspaceRow(
  file: DesktopWorkspaceFileState["files"][number],
  state: DesktopWorkspaceFileState,
  selectedIds: Set<string> | undefined,
): DesktopFilesWorkbenchTableRow {
  const id = workspaceId(file.path);
  const active = state.activePath === file.path;
  return {
    id,
    name: file.path,
    scope: "workspace",
    status: active && state.dirty ? "dirty" : file.exists ? "ready" : "missing",
    updated: file.updatedAt ?? "",
    meta: file.meta,
    selected: Boolean(selectedIds?.has(id)),
    actions: ["open", "reveal", "promote-to-knowledge"],
  };
}

function scopeTab(
  id: DesktopFilesWorkbenchScope,
  label: string,
  count: number,
  activeScope: DesktopFilesWorkbenchScope,
): DesktopFilesWorkbenchScopeTab {
  return { id, label, count, active: id === activeScope };
}

function uploadDestinations(activeScope: DesktopFilesWorkbenchScope): DesktopFilesWorkbenchUploadDestination[] {
  return [
    { id: "session", label: "Attach to Session", active: activeScope === "session" },
    { id: "knowledge", label: "Import to Knowledge", active: activeScope === "knowledge" },
    { id: "workspace", label: "Import to Workspace", active: activeScope === "workspace" },
  ];
}

function workspaceId(path: string): string {
  return `workspace:${path}`;
}

function workspaceStatusLabel(state: DesktopWorkspaceFileState): string {
  if (state.saveState === "conflict-error") {
    return "Conflict";
  }
  if (state.dirty) {
    return "Dirty";
  }
  return state.saveState === "idle" ? "Ready" : state.saveState;
}

function formatBytes(bytes: number | undefined | null): string {
  if (typeof bytes !== "number") {
    return "";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const kib = bytes / 1024;
  return `${kib.toFixed(kib >= 4 ? 0 : 1)} KB`;
}
