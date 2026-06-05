import {
  buildDesktopKnowledgeTaskOperation,
  buildDesktopKnowledgeUploadTaskOperation,
} from "./desktopKnowledgeTraceability";
import type { DesktopTaskSourceOperation } from "./desktopTaskCenter";
import { mountOrUpdateSessionFileListIsland } from "./native-vue/sessionFileListIsland";

export type DesktopUploadKind = "knowledge-document" | "session-temporary-file" | "workspace-file";
export type DesktopDropTargetKind = DesktopUploadKind;

export interface DesktopUploadPickerFilter {
  name: string;
  extensions: string[];
}

export interface DesktopUploadPickerOptions {
  title: string;
  filters: DesktopUploadPickerFilter[];
}

export interface DesktopPickedUploadFile {
  name: string;
  path?: string;
  mime_type?: string;
  size_bytes?: number;
  bytes: number[];
}

export interface DesktopFileUploadActions {
  targetDocument?: Document;
  pickFile: (kind: DesktopUploadKind, options: DesktopUploadPickerOptions) => Promise<DesktopPickedUploadFile | null>;
  uploadKnowledgeDocument: (form: FormData) => Promise<unknown>;
  uploadSessionTemporaryFile: (sessionKey: string, form: FormData) => Promise<unknown>;
  listSessionTemporaryFiles?: (sessionKey: string) => Promise<unknown>;
  uploadWorkspaceFile?: (path: string, body: DesktopWorkspaceImportBody) => Promise<unknown>;
  getSessionKey?: () => string;
  onKnowledgeUploaded?: () => Promise<void>;
  onKnowledgeTaskUpdated?: (operation: DesktopTaskSourceOperation) => void;
  onSessionFileUploaded?: (sessionKey: string) => Promise<void>;
  onWorkspaceFileImported?: (path: string) => Promise<void>;
}

export interface DesktopDroppedFileRejection {
  name: string;
  reason: string;
}

export interface DesktopDroppedFileClassification {
  accepted: File[];
  rejected: DesktopDroppedFileRejection[];
}

export interface DesktopWorkspaceImportBody {
  content: string;
  expected_updated_at: null;
}

export interface DesktopWorkspaceImportPayload {
  path: string;
  body: DesktopWorkspaceImportBody;
}

export interface DesktopSessionTemporaryFileRow {
  id: string;
  name: string;
  status: string;
  sizeBytes?: number;
  mimeType?: string;
  updatedAt?: string;
  actions: string[];
}

export interface DesktopDroppedFileHandlerOptions {
  targetDocument?: Document;
  targetKind: DesktopDropTargetKind;
  files: readonly File[];
  sessionKey?: string;
  uploadKnowledgeDocument: (form: FormData) => Promise<unknown>;
  uploadSessionTemporaryFile: (sessionKey: string, form: FormData) => Promise<unknown>;
  uploadWorkspaceFile: (path: string, body: DesktopWorkspaceImportBody) => Promise<unknown>;
  onKnowledgeUploaded?: () => Promise<void>;
  onKnowledgeTaskUpdated?: (operation: DesktopTaskSourceOperation) => void;
  onSessionFileUploaded?: (sessionKey: string) => Promise<void>;
  onWorkspaceFileImported?: (path: string) => Promise<void>;
}

export interface DesktopDroppedFileHandlerResult extends DesktopDroppedFileClassification {
  summary: string;
}

const ACCEPTED_DROP_EXTENSIONS: Record<DesktopDropTargetKind, string[]> = {
  "knowledge-document": ["md", "markdown", "txt", "pdf", "docx", "csv", "json"],
  "session-temporary-file": ["md", "txt", "pdf", "docx", "csv", "json", "png", "jpg", "jpeg"],
  "workspace-file": ["md", "markdown", "txt", "json", "csv", "py", "js", "ts", "tsx", "jsx", "html", "css", "yaml", "yml", "toml"],
};

export function desktopUploadPickerOptions(kind: DesktopUploadKind): DesktopUploadPickerOptions {
  if (kind === "knowledge-document") {
    return {
      title: "Import knowledge document",
      filters: [
        {
          name: "Knowledge documents",
          extensions: ["md", "markdown", "txt", "pdf", "docx", "csv", "json"],
        },
      ],
    };
  }
  if (kind === "workspace-file") {
    return {
      title: "Import workspace file",
      filters: [
        {
          name: "Workspace files",
          extensions: ["md", "markdown", "txt", "json", "csv", "py", "js", "ts", "tsx", "jsx", "html", "css", "yaml", "yml", "toml"],
        },
      ],
    };
  }
  return {
    title: "Attach temporary session file",
    filters: [
      {
        name: "Session files",
        extensions: ["md", "txt", "pdf", "docx", "csv", "json", "png", "jpg", "jpeg"],
      },
    ],
  };
}

export function buildDesktopUploadFile(file: DesktopPickedUploadFile): File {
  const bytes = Uint8Array.from(file.bytes);
  return new File([bytes], file.name || fileNameFromPath(file.path) || "upload", {
    type: file.mime_type || inferMimeType(file.name || file.path || ""),
  });
}

export function buildDesktopKnowledgeUploadForm(
  file: DesktopPickedUploadFile,
  options: { category?: string; tags?: string } = {},
): FormData {
  const form = new FormData();
  form.append("file", buildDesktopUploadFile(file));
  const category = options.category?.trim() ?? "";
  const tags = options.tags?.trim() ?? "";
  if (category) {
    form.append("category", category);
  }
  if (tags) {
    form.append("tags", tags);
  }
  return form;
}

export function buildDesktopSessionTemporaryUploadForm(file: DesktopPickedUploadFile): FormData {
  const form = new FormData();
  form.append("file", buildDesktopUploadFile(file));
  return form;
}

export function classifyDesktopDroppedFiles(
  targetKind: DesktopDropTargetKind,
  files: readonly File[],
  options: { sessionKey?: string } = {},
): DesktopDroppedFileClassification {
  const accepted: File[] = [];
  const rejected: DesktopDroppedFileRejection[] = [];
  const sessionKey = options.sessionKey?.trim() ?? "";

  for (const file of files) {
    const name = fileNameFromPath(file.name) || "dropped-file";
    if (targetKind === "session-temporary-file" && !sessionKey) {
      rejected.push({ name, reason: "Select a session before attaching temporary files" });
      continue;
    }
    if (!ACCEPTED_DROP_EXTENSIONS[targetKind].includes(fileExtension(name))) {
      rejected.push({ name, reason: unsupportedDropReason(targetKind) });
      continue;
    }
    accepted.push(file);
  }

  return { accepted, rejected };
}

export async function buildDesktopWorkspaceImport(file: File): Promise<DesktopWorkspaceImportPayload> {
  return {
    path: fileNameFromPath(file.name) || "dropped-file.txt",
    body: {
      content: await file.text(),
      expected_updated_at: null,
    },
  };
}

export function normalizeDesktopSessionTemporaryFiles(payload: unknown): DesktopSessionTemporaryFileRow[] {
  return temporaryFileItems(payload).map((item, index) => {
    const record = asRecord(item);
    const sourceName = stringField(record, ["name", "filename", "file_name", "path", "id"]) || `session-file-${index + 1}`;
    const size = numberField(record, ["size_bytes", "size", "bytes"]);
    return {
      id: stringField(record, ["id", "file_id", "path", "name", "filename"]) || `${index}:${sourceName}`,
      name: fileNameFromPath(sourceName) || sourceName,
      status: stringField(record, ["status", "indexing_status", "state"]) || "available",
      sizeBytes: typeof size === "number" ? size : undefined,
      mimeType: stringField(record, ["mime_type", "content_type", "type"]) || undefined,
      updatedAt: stringField(record, ["updated_at", "created_at", "uploaded_at"]) || undefined,
      actions: stringArrayField(record, "actions"),
    };
  });
}

export function renderDesktopSessionTemporaryFiles(
  targetDocument: Document | undefined,
  sessionKey: string,
  payload: unknown,
): DesktopSessionTemporaryFileRow[] {
  const rows = normalizeDesktopSessionTemporaryFiles(payload);
  const ownerDocument = targetDocument ?? document;
  const container = ownerDocument.querySelector<HTMLElement>("#desktop-session-file-list");
  if (!container) {
    return rows;
  }
  const count = ownerDocument.querySelector<HTMLElement>("#desktop-session-file-count");
  if (count) {
    count.textContent = String(rows.length);
  }
  if (canMountSessionFileListVueIsland(container)) {
    mountOrUpdateSessionFileListIsland(container, { sessionKey, rows });
    return rows;
  }
  renderDesktopSessionTemporaryFilesFallback(ownerDocument, container, sessionKey, rows);
  return rows;
}

function canMountSessionFileListVueIsland(container: HTMLElement): boolean {
  return typeof window !== "undefined" && container instanceof window.HTMLElement;
}

function renderDesktopSessionTemporaryFilesFallback(
  ownerDocument: Document,
  container: HTMLElement,
  sessionKey: string,
  rows: DesktopSessionTemporaryFileRow[],
): void {
  container.replaceChildren();
  container.dataset.sessionKey = sessionKey;
  container.dataset.fileCount = String(rows.length);
  if (!sessionKey) {
    container.textContent = "Select a chat session to view temporary files.";
    return;
  }
  if (!rows.length) {
    container.textContent = "No temporary files attached to this session.";
    return;
  }

  const list = ownerDocument.createElement("ul");
  list.className = "desktop-session-temporary-file-list";
  for (const row of rows) {
    const item = ownerDocument.createElement("li");
    item.className = "desktop-session-temporary-file-row";
    item.dataset.sessionTemporaryFileId = row.id;
    const details = [
      row.status,
      row.mimeType,
      typeof row.sizeBytes === "number" ? formatFileSize(row.sizeBytes) : "",
      row.updatedAt,
    ].filter(Boolean);
    const actions = row.actions.length ? row.actions.join(", ") : "No cleanup action exposed";
    item.textContent = `${row.name} - ${details.join(" / ")} - ${actions}`;
    list.append(item);
  }
  container.append(list);
}

export async function handleDesktopDroppedFiles({
  targetDocument,
  targetKind,
  files,
  sessionKey = "",
  uploadKnowledgeDocument,
  uploadSessionTemporaryFile,
  uploadWorkspaceFile,
  onKnowledgeUploaded,
  onKnowledgeTaskUpdated,
  onSessionFileUploaded,
  onWorkspaceFileImported,
}: DesktopDroppedFileHandlerOptions): Promise<DesktopDroppedFileHandlerResult> {
  const classification = classifyDesktopDroppedFiles(targetKind, files, { sessionKey });
  const cleanSessionKey = sessionKey.trim();
  let actionSummary = "No accepted files to import.";

  if (classification.accepted.length) {
    if (targetKind === "knowledge-document") {
      for (const file of classification.accepted) {
        onKnowledgeTaskUpdated?.(buildDesktopKnowledgeUploadTaskOperation(file.name));
        const result = await uploadKnowledgeDocument(buildKnowledgeUploadFormFromFile(file));
        const operation = buildDesktopKnowledgeTaskOperation(result);
        if (operation) {
          onKnowledgeTaskUpdated?.(operation);
        }
      }
      await onKnowledgeUploaded?.();
      actionSummary = `Uploaded ${plural(classification.accepted.length, "knowledge file")}.`;
    } else if (targetKind === "session-temporary-file") {
      for (const file of classification.accepted) {
        await uploadSessionTemporaryFile(cleanSessionKey, buildSessionTemporaryUploadFormFromFile(file));
      }
      await onSessionFileUploaded?.(cleanSessionKey);
      actionSummary = `Attached ${plural(classification.accepted.length, "session file")} to ${cleanSessionKey}.`;
    } else {
      for (const file of classification.accepted) {
        const payload = await buildDesktopWorkspaceImport(file);
        await uploadWorkspaceFile(payload.path, payload.body);
        await onWorkspaceFileImported?.(payload.path);
      }
      actionSummary = `Imported ${plural(classification.accepted.length, "workspace file")}.`;
    }
  }

  const summary = `${actionSummary} ${formatDropFeedback(classification)}`.trim();
  setUploadStatus(targetDocument, summary);
  return { ...classification, summary };
}

export function installDesktopFileUploadActions({
  targetDocument = document,
  pickFile,
  uploadKnowledgeDocument,
  uploadSessionTemporaryFile,
  listSessionTemporaryFiles,
  uploadWorkspaceFile,
  getSessionKey,
  onKnowledgeUploaded,
  onKnowledgeTaskUpdated,
  onSessionFileUploaded,
  onWorkspaceFileImported,
}: DesktopFileUploadActions): void {
  const refreshSessionTemporaryFiles = async (sessionKey: string): Promise<void> => {
    const cleanSessionKey = sessionKey.trim();
    if (!listSessionTemporaryFiles || !cleanSessionKey) {
      return;
    }
    setUploadStatus(targetDocument, `Refreshing temporary files for ${cleanSessionKey}.`);
    const payload = await listSessionTemporaryFiles(cleanSessionKey);
    const rows = renderDesktopSessionTemporaryFiles(targetDocument, cleanSessionKey, payload);
    setUploadStatus(targetDocument, `Loaded ${plural(rows.length, "temporary file")} for ${cleanSessionKey}.`);
  };
  const notifySessionFileUploaded = async (sessionKey: string): Promise<void> => {
    await onSessionFileUploaded?.(sessionKey);
    await refreshSessionTemporaryFiles(sessionKey);
  };

  targetDocument.querySelector<HTMLButtonElement>("#desktop-knowledge-upload")?.addEventListener("click", () => {
    void runKnowledgeUpload({ targetDocument, pickFile, uploadKnowledgeDocument, onKnowledgeUploaded, onKnowledgeTaskUpdated });
  });

  targetDocument.querySelector<HTMLButtonElement>("#desktop-session-file-upload")?.addEventListener("click", () => {
    const sessionKey = (
      getSessionKey?.() ||
      targetDocument.querySelector<HTMLInputElement>("#desktop-session-upload-key")?.value ||
      targetDocument.querySelector<HTMLElement>("#desktop-workbench-shell")?.dataset.activeSessionKey ||
      ""
    ).trim();
    void runSessionFileUpload({
      targetDocument,
      sessionKey,
      pickFile,
      uploadSessionTemporaryFile,
      onSessionFileUploaded: notifySessionFileUploaded,
    });
  });

  targetDocument.querySelector<HTMLButtonElement>("#desktop-session-files-refresh")?.addEventListener("click", () => {
    const sessionKey = (
      getSessionKey?.() ||
      targetDocument.querySelector<HTMLInputElement>("#desktop-session-upload-key")?.value ||
      targetDocument.querySelector<HTMLElement>("#desktop-workbench-shell")?.dataset.activeSessionKey ||
      ""
    ).trim();
    void refreshSessionTemporaryFiles(sessionKey).catch((error) => {
      setUploadStatus(targetDocument, `Temporary file refresh failed: ${stringifyError(error)}`);
    });
  });

  targetDocument.querySelector<HTMLElement>("#desktop-workspace-file-drop")?.addEventListener("click", (event) => {
    if (!uploadWorkspaceFile) {
      return;
    }
    event.preventDefault();
    void runWorkspaceFileImport({
      targetDocument,
      pickFile,
      uploadWorkspaceFile,
      onWorkspaceFileImported,
    });
  });

  targetDocument.addEventListener("tinybot:desktop-session-key-changed", (event) => {
    const sessionKey = ((event as CustomEvent<{ sessionKey?: string }>).detail?.sessionKey ?? "").trim();
    void refreshSessionTemporaryFiles(sessionKey).catch((error) => {
      setUploadStatus(targetDocument, `Temporary file refresh failed: ${stringifyError(error)}`);
    });
  });

  const initialSessionKey = (getSessionKey?.() || targetDocument.querySelector<HTMLInputElement>("#desktop-session-upload-key")?.value || "").trim();
  if (initialSessionKey) {
    void refreshSessionTemporaryFiles(initialSessionKey).catch((error) => {
      setUploadStatus(targetDocument, `Temporary file refresh failed: ${stringifyError(error)}`);
    });
  }

  if (uploadWorkspaceFile) {
    installDesktopFileDropActions({
      targetDocument,
      uploadKnowledgeDocument,
      uploadSessionTemporaryFile,
      uploadWorkspaceFile,
      getSessionKey,
      onKnowledgeUploaded,
      onKnowledgeTaskUpdated,
      onSessionFileUploaded: notifySessionFileUploaded,
      onWorkspaceFileImported,
    });
  }
}

async function runWorkspaceFileImport({
  targetDocument,
  pickFile,
  uploadWorkspaceFile,
  onWorkspaceFileImported,
}: Pick<DesktopFileUploadActions, "targetDocument" | "pickFile" | "uploadWorkspaceFile" | "onWorkspaceFileImported"> & {
  uploadWorkspaceFile: NonNullable<DesktopFileUploadActions["uploadWorkspaceFile"]>;
}): Promise<void> {
  setUploadStatus(targetDocument, "Opening workspace file picker.");
  const picked = await pickFile("workspace-file", desktopUploadPickerOptions("workspace-file"));
  if (!picked) {
    setUploadStatus(targetDocument, "Workspace import canceled.");
    return;
  }
  const payload = await buildDesktopWorkspaceImport(buildDesktopUploadFile(picked));
  setUploadStatus(targetDocument, `Importing ${payload.path} into workspace.`);
  await uploadWorkspaceFile(payload.path, payload.body);
  await onWorkspaceFileImported?.(payload.path);
  setUploadStatus(targetDocument, `Imported ${payload.path} into workspace.`);
}

function installDesktopFileDropActions({
  targetDocument,
  uploadKnowledgeDocument,
  uploadSessionTemporaryFile,
  uploadWorkspaceFile,
  getSessionKey,
  onKnowledgeUploaded,
  onKnowledgeTaskUpdated,
  onSessionFileUploaded,
  onWorkspaceFileImported,
}: Required<Pick<DesktopFileUploadActions, "targetDocument" | "uploadWorkspaceFile">> &
  Pick<
    DesktopFileUploadActions,
    "uploadKnowledgeDocument" | "uploadSessionTemporaryFile" | "getSessionKey" | "onKnowledgeUploaded" | "onKnowledgeTaskUpdated" | "onSessionFileUploaded" | "onWorkspaceFileImported"
  >): void {
  targetDocument.querySelectorAll<HTMLElement>("[data-desktop-drop-target]").forEach((target) => {
    target.addEventListener("dragover", (event) => {
      if (!event.dataTransfer) {
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      target.classList.add("is-desktop-drop-hover");
      setUploadStatus(targetDocument, `Drop files to ${dropTargetLabel(target)}.`);
    });

    target.addEventListener("dragleave", () => {
      target.classList.remove("is-desktop-drop-hover");
    });

    target.addEventListener("drop", (event) => {
      event.preventDefault();
      target.classList.remove("is-desktop-drop-hover");
      const targetKind = target.getAttribute("data-desktop-drop-target") as DesktopDropTargetKind | null;
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (!targetKind || !files.length) {
        setUploadStatus(targetDocument, "Drop one or more files onto a desktop import target.");
        return;
      }
      const sessionKey =
        getSessionKey?.() ||
        targetDocument.querySelector<HTMLInputElement>("#desktop-session-upload-key")?.value ||
        targetDocument.querySelector<HTMLElement>("#desktop-workbench-shell")?.dataset.activeSessionKey ||
        "";
      void handleDesktopDroppedFiles({
        targetDocument,
        targetKind,
        files,
        sessionKey,
        uploadKnowledgeDocument,
        uploadSessionTemporaryFile,
        uploadWorkspaceFile,
        onKnowledgeUploaded,
        onKnowledgeTaskUpdated,
        onSessionFileUploaded,
        onWorkspaceFileImported,
      }).catch((error) => {
        setUploadStatus(targetDocument, `File drop failed: ${stringifyError(error)}`);
      });
    });
  });
}

async function runKnowledgeUpload({
  targetDocument,
  pickFile,
  uploadKnowledgeDocument,
  onKnowledgeUploaded,
  onKnowledgeTaskUpdated,
}: Pick<DesktopFileUploadActions, "targetDocument" | "pickFile" | "uploadKnowledgeDocument" | "onKnowledgeUploaded" | "onKnowledgeTaskUpdated">): Promise<void> {
  setUploadStatus(targetDocument, "Opening knowledge document picker.");
  const picked = await pickFile("knowledge-document", desktopUploadPickerOptions("knowledge-document"));
  if (!picked) {
    setUploadStatus(targetDocument, "Knowledge upload canceled.");
    return;
  }
  setUploadStatus(targetDocument, `Uploading ${picked.name}.`);
  onKnowledgeTaskUpdated?.(buildDesktopKnowledgeUploadTaskOperation(picked.name));
  const result = await uploadKnowledgeDocument(buildDesktopKnowledgeUploadForm(picked));
  const operation = buildDesktopKnowledgeTaskOperation(result);
  if (operation) {
    onKnowledgeTaskUpdated?.(operation);
  }
  await onKnowledgeUploaded?.();
  setUploadStatus(targetDocument, `Uploaded ${picked.name} through the knowledge upload contract.`);
}

async function runSessionFileUpload({
  targetDocument,
  sessionKey,
  pickFile,
  uploadSessionTemporaryFile,
  onSessionFileUploaded,
}: Pick<DesktopFileUploadActions, "targetDocument" | "pickFile" | "uploadSessionTemporaryFile" | "onSessionFileUploaded"> & {
  sessionKey: string;
}): Promise<void> {
  if (!sessionKey) {
    setUploadStatus(targetDocument, "Select a session before attaching a temporary file.");
    return;
  }
  setUploadStatus(targetDocument, "Opening temporary file picker.");
  const picked = await pickFile("session-temporary-file", desktopUploadPickerOptions("session-temporary-file"));
  if (!picked) {
    setUploadStatus(targetDocument, "Temporary file upload canceled.");
    return;
  }
  setUploadStatus(targetDocument, `Attaching ${picked.name}.`);
  await uploadSessionTemporaryFile(sessionKey, buildDesktopSessionTemporaryUploadForm(picked));
  await onSessionFileUploaded?.(sessionKey);
  setUploadStatus(targetDocument, `Attached ${picked.name} to ${sessionKey}.`);
}

function setUploadStatus(targetDocument: Document | undefined, message: string): void {
  if (!targetDocument && typeof document === "undefined") {
    return;
  }
  const status = (targetDocument ?? document).querySelector<HTMLElement>("#desktop-file-upload-status");
  if (status) {
    status.textContent = message;
  }
}

function buildKnowledgeUploadFormFromFile(file: File): FormData {
  const form = new FormData();
  form.append("file", file);
  return form;
}

function buildSessionTemporaryUploadFormFromFile(file: File): FormData {
  const form = new FormData();
  form.append("file", file);
  return form;
}

function formatDropFeedback({ accepted, rejected }: DesktopDroppedFileClassification): string {
  const parts: string[] = [];
  if (accepted.length) {
    parts.push(`Accepted ${plural(accepted.length, "file")}: ${accepted.map((file) => fileNameFromPath(file.name)).join(", ")}.`);
  }
  if (rejected.length) {
    parts.push(`Rejected ${plural(rejected.length, "file")}: ${rejected.map((item) => `${item.name} (${item.reason})`).join(", ")}.`);
  }
  return parts.join(" ");
}

function unsupportedDropReason(targetKind: DesktopDropTargetKind): string {
  if (targetKind === "knowledge-document") {
    return "Unsupported file type for knowledge import";
  }
  if (targetKind === "session-temporary-file") {
    return "Unsupported file type for session attachment";
  }
  return "Unsupported file type for workspace import";
}

function dropTargetLabel(target: HTMLElement): string {
  const targetKind = target.getAttribute("data-desktop-drop-target") as DesktopDropTargetKind | null;
  if (targetKind === "knowledge-document") {
    return "knowledge import";
  }
  if (targetKind === "session-temporary-file") {
    return "session attachment";
  }
  return "workspace import";
}

function fileNameFromPath(path = ""): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? "";
}

function fileExtension(name: string): string {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

function temporaryFileItems(payload: unknown): unknown[] {
  if (Array.isArray(payload)) {
    return payload;
  }
  const record = asRecord(payload);
  for (const key of ["files", "items", "temporary_files", "temporaryFiles"]) {
    const value = record[key];
    if (Array.isArray(value)) {
      return value;
    }
  }
  return [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringField(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function numberField(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function stringArrayField(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim());
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const kib = bytes / 1024;
  return `${kib.toFixed(kib >= 10 ? 0 : 1)} KiB`;
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

function inferMimeType(name: string): string {
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  const types: Record<string, string> = {
    csv: "text/csv",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    json: "application/json",
    markdown: "text/markdown",
    md: "text/markdown",
    pdf: "application/pdf",
    txt: "text/plain",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    png: "image/png",
  };
  return types[extension] ?? "application/octet-stream";
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
