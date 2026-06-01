import {
  buildDesktopKnowledgeTaskOperation,
  buildDesktopKnowledgeUploadTaskOperation,
} from "./desktopKnowledgeTraceability";
import type { DesktopTaskSourceOperation } from "./desktopTaskCenter";

export type DesktopUploadKind = "knowledge-document" | "session-temporary-file";
export type DesktopDropTargetKind = DesktopUploadKind | "workspace-file";

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
  uploadWorkspaceFile,
  getSessionKey,
  onKnowledgeUploaded,
  onKnowledgeTaskUpdated,
  onSessionFileUploaded,
  onWorkspaceFileImported,
}: DesktopFileUploadActions): void {
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
      onSessionFileUploaded,
    });
  });

  if (uploadWorkspaceFile) {
    installDesktopFileDropActions({
      targetDocument,
      uploadKnowledgeDocument,
      uploadSessionTemporaryFile,
      uploadWorkspaceFile,
      getSessionKey,
      onKnowledgeUploaded,
      onKnowledgeTaskUpdated,
      onSessionFileUploaded,
      onWorkspaceFileImported,
    });
  }
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
