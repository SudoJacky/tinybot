import { listen as tauriListen } from "@tauri-apps/api/event";
import type { NativePickedFile } from "./desktopNativeFilePicker";

const DESKTOP_PET_FILE_DROP_RESULT_EVENT = "desktop-pet-file-drop-result";
const DESKTOP_PET_FILE_DROP_SCHEMA_VERSION = "tinybot.desktop_pet_file_drop.v1";
const DEFAULT_IMPORT_TIMEOUT_MS = 15_000;
export const MAX_DESKTOP_PET_DROPPED_FILES = 10;

type FileDropEvent = { payload: unknown };
type FileDropListener = (
  event: string,
  listener: (event: FileDropEvent) => void,
) => Promise<() => void>;
type FileDropPost = (requestId: string, files: readonly File[]) => Promise<void>;

type DesktopPetFileDropResult = {
  schemaVersion: typeof DESKTOP_PET_FILE_DROP_SCHEMA_VERSION;
  requestId: string;
  files?: NativePickedFile[];
  error?: string;
};

declare global {
  interface Window {
    __TINYBOT_DESKTOP_PET_POST_DROPPED_FILES__?: FileDropPost;
  }
}

export function createDesktopNativePetFileDropImporter(options: {
  listen?: FileDropListener;
  post?: FileDropPost;
  requestId?: () => string;
  timeoutMs?: number;
} = {}) {
  const listen = options.listen ?? ((event, listener) => tauriListen<unknown>(event, listener));
  const post = options.post ?? postDroppedFiles;
  const nextRequestId = options.requestId ?? (() => (
    `pet-file-drop-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  ));
  const timeoutMs = options.timeoutMs ?? DEFAULT_IMPORT_TIMEOUT_MS;

  return async (files: readonly File[]): Promise<NativePickedFile[]> => {
    if (!files.length) throw new Error("Cannot import an empty desktop pet file drop.");
    if (files.length > MAX_DESKTOP_PET_DROPPED_FILES) {
      throw new Error(`Desktop pet file drops support at most ${MAX_DESKTOP_PET_DROPPED_FILES} files.`);
    }
    const requestId = nextRequestId();
    if (!requestId.trim()) throw new Error("Desktop pet file-drop request ID cannot be empty.");

    let resolveResult: (files: NativePickedFile[]) => void = () => undefined;
    let rejectResult: (error: Error) => void = () => undefined;
    const result = new Promise<NativePickedFile[]>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const unlisten = await listen(DESKTOP_PET_FILE_DROP_RESULT_EVENT, ({ payload }) => {
      if (!isRecord(payload) || payload.requestId !== requestId) return;
      try {
        const parsed = parseDesktopPetFileDropResult(payload);
        if (parsed.error) rejectResult(new Error(parsed.error));
        else resolveResult(parsed.files ?? []);
      } catch (error) {
        rejectResult(error instanceof Error ? error : new Error(String(error)));
      }
    });
    const timeout = globalThis.setTimeout(() => {
      rejectResult(new Error(`Desktop pet file import timed out after ${timeoutMs} ms.`));
    }, timeoutMs);
    try {
      const [, importedFiles] = await Promise.all([
        post(requestId, files),
        result,
      ]);
      return importedFiles;
    } finally {
      globalThis.clearTimeout(timeout);
      unlisten();
    }
  };
}

export const importDesktopPetDroppedFiles = createDesktopNativePetFileDropImporter();

export function parseNativePickedFiles(value: unknown): NativePickedFile[] {
  if (!Array.isArray(value) || value.length > MAX_DESKTOP_PET_DROPPED_FILES) {
    throw new Error("Received an invalid desktop pet attachment list.");
  }
  return value.map((item) => {
    if (!isRecord(item)
      || typeof item.name !== "string"
      || !item.name.trim()
      || typeof item.path !== "string"
      || !item.path.trim()
      || typeof item.mimeType !== "string"
      || !item.mimeType.trim()
      || !Number.isSafeInteger(item.sizeBytes)
      || (item.sizeBytes as number) < 0
      || (item.contentHash !== undefined
        && (typeof item.contentHash !== "string" || !item.contentHash.trim()))) {
      throw new Error("Received invalid desktop pet attachment metadata.");
    }
    return {
      name: item.name,
      path: item.path,
      mimeType: item.mimeType,
      sizeBytes: item.sizeBytes as number,
      ...(typeof item.contentHash === "string" ? { contentHash: item.contentHash } : {}),
    };
  });
}

function parseDesktopPetFileDropResult(value: unknown): DesktopPetFileDropResult {
  if (!isRecord(value)
    || value.schemaVersion !== DESKTOP_PET_FILE_DROP_SCHEMA_VERSION
    || typeof value.requestId !== "string"
    || !value.requestId.trim()) {
    throw new Error("Received an invalid desktop pet file-drop result.");
  }
  const hasFiles = value.files !== undefined;
  const hasError = value.error !== undefined;
  if (hasFiles === hasError) {
    throw new Error("Desktop pet file-drop results must contain files or an error.");
  }
  if (hasError) {
    if (typeof value.error !== "string" || !value.error.trim()) {
      throw new Error("Received an invalid desktop pet file-drop error.");
    }
    return {
      schemaVersion: DESKTOP_PET_FILE_DROP_SCHEMA_VERSION,
      requestId: value.requestId,
      error: value.error,
    };
  }
  return {
    schemaVersion: DESKTOP_PET_FILE_DROP_SCHEMA_VERSION,
    requestId: value.requestId,
    files: parseNativePickedFiles(value.files),
  };
}

function postDroppedFiles(requestId: string, files: readonly File[]): Promise<void> {
  const post = window.__TINYBOT_DESKTOP_PET_POST_DROPPED_FILES__;
  if (!post) throw new Error("The Windows desktop pet file-drop bridge is unavailable.");
  return post(requestId, files);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
