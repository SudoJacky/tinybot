import type { NativeWorkspaceApi } from "../../app-core/native/desktopNativeWorkspace";
import type {
  WorkspaceDirectoryPage,
  WorkspaceFileChunk,
  WorkspaceFileSummary,
  WorkspaceQueryError,
  WorkspaceQueryErrorCode,
  WorkspaceStore,
} from "../services";

type NativeWorkspaceQueryApi = Pick<NativeWorkspaceApi, "directory" | "fileChunk" | "files">;

export function createDesktopWorkspaceStore({
  initialize,
  nativeWorkspace,
}: {
  initialize: () => Promise<void>;
  nativeWorkspace?: NativeWorkspaceQueryApi;
}): WorkspaceStore {
  return {
    async listFiles() {
      await initialize();
      return normalizeWorkspaceFiles(await requireNativeWorkspace(nativeWorkspace).files());
    },
    async listDirectory(request) {
      await initialize();
      return normalizeWorkspaceDirectoryPage(await requireNativeWorkspace(nativeWorkspace).directory(request));
    },
    async readFile(request) {
      await initialize();
      return normalizeWorkspaceFileChunk(await requireNativeWorkspace(nativeWorkspace).fileChunk(request));
    },
  };
}

function normalizeWorkspaceFiles(payload: unknown): WorkspaceFileSummary[] {
  return payloadItems(payload, ["files", "items"]).map((item) => {
    const path = stringValue(item.path ?? item.name ?? item.file ?? item.relative_path);
    return {
      path: path || "Untitled file",
      size: numberValue(item.size ?? item.bytes),
      updatedAtMs: timestampMs(stringValue(item.updated_at ?? item.updatedAt ?? item.modified_at)) ?? undefined,
    };
  });
}

function normalizeWorkspaceDirectoryPage(payload: unknown): WorkspaceDirectoryPage {
  const value = workspaceQueryResult(payload);
  if (!isRecord(value)) throw workspaceQueryError("io_error", "Workspace directory response must be an object.");
  const entries = Array.isArray(value.entries) ? value.entries : [];
  return {
    entries: entries.flatMap((entry): WorkspaceDirectoryPage["entries"] => {
      if (!isRecord(entry)) return [];
      const path = stringValue(entry.path);
      const rawKind = stringValue(entry.kind);
      if (!path || (rawKind !== "dir" && rawKind !== "directory" && rawKind !== "file")) return [];
      const normalizedPath = path.replace(/\\/g, "/");
      const trimmedPath = normalizedPath.replace(/\/$/, "");
      return [{
        kind: rawKind === "file" ? "file" : "directory",
        name: trimmedPath.split("/").filter(Boolean).pop() || trimmedPath,
        path: trimmedPath,
        sizeBytes: numberValue(entry.size_bytes ?? entry.sizeBytes) ?? undefined,
        updatedAt: stringValue(entry.updated_at ?? entry.updatedAt) || undefined,
      }];
    }),
    listingRevision: stringValue(value.listing_revision ?? value.listingRevision),
    nextCursor: stringValue(value.next_cursor ?? value.nextCursor) || undefined,
    path: stringValue(value.path) || ".",
    workspaceKey: stringValue(value.workspace_key ?? value.workspaceKey) || undefined,
  };
}

function normalizeWorkspaceFileChunk(payload: unknown): WorkspaceFileChunk {
  const value = workspaceQueryResult(payload);
  if (!isRecord(value)) throw workspaceQueryError("io_error", "Workspace file response must be an object.");
  const rawContentType = stringValue(value.content_type ?? value.contentType);
  const contentType = rawContentType === "text" || rawContentType === "binary" || rawContentType === "unsupported"
    ? rawContentType
    : "unsupported";
  return {
    content: typeof value.content === "string" ? value.content : undefined,
    contentType,
    lineEnd: numberValue(value.line_end ?? value.lineEnd) ?? undefined,
    lineStart: numberValue(value.line_start ?? value.lineStart) ?? undefined,
    nextCursor: stringValue(value.next_cursor ?? value.nextCursor) || undefined,
    path: stringValue(value.path),
    revision: stringValue(value.revision),
    sizeBytes: numberValue(value.size_bytes ?? value.sizeBytes) ?? 0,
    updatedAt: stringValue(value.updated_at ?? value.updatedAt) || undefined,
  };
}

function workspaceQueryResult(payload: unknown): unknown {
  if (!isRecord(payload)) throw workspaceQueryError("io_error", "Workspace query response must be an object.");
  if (isRecord(payload.error)) {
    const details = isRecord(payload.error.details) ? payload.error.details : {};
    const protocolCode = stringValue(payload.error.code);
    const queryCode = stringValue(details.query_code ?? details.queryCode);
    const code = isWorkspaceQueryErrorCode(queryCode)
      ? queryCode
      : protocolCode === "capability_denied" ? "capability_denied" : "io_error";
    throw workspaceQueryError(
      code,
      stringValue(payload.error.message) || "Workspace query failed.",
      stringValue(details.path) || undefined,
      Boolean(payload.error.retryable),
    );
  }
  if (!("result" in payload)) return payload;
  if (payload.result === undefined || payload.result === null) {
    throw workspaceQueryError("io_error", "Workspace query returned no result.");
  }
  return payload.result;
}

function workspaceQueryError(
  code: WorkspaceQueryErrorCode,
  message: string,
  path?: string,
  retryable = false,
): WorkspaceQueryError {
  return Object.assign(new Error(message), { code, path, retryable });
}

function isWorkspaceQueryErrorCode(value: string): value is WorkspaceQueryErrorCode {
  return [
    "not_configured",
    "capability_denied",
    "root_unavailable",
    "invalid_path",
    "not_found",
    "not_directory",
    "listing_changed",
    "source_changed",
    "io_error",
  ].includes(value);
}

function requireNativeWorkspace(value: NativeWorkspaceQueryApi | undefined): NativeWorkspaceQueryApi {
  if (!value) throw new Error("Workspace Native API is unavailable outside the Tauri runtime");
  return value;
}

function payloadItems(payload: unknown, keys: string[]): Record<string, unknown>[] {
  if (Array.isArray(payload)) {
    return payload.filter(isRecord);
  }
  if (!isRecord(payload)) {
    return [];
  }
  for (const key of keys) {
    const value = payload[key];
    if (Array.isArray(value)) {
      return value.filter(isRecord);
    }
  }
  return [];
}

function timestampMs(value: string): number | null {
  if (!value) return null;
  if (value.startsWith("unix-ms:")) {
    const parsed = Number(value.slice("unix-ms:".length));
    return Number.isFinite(parsed) ? parsed : null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}
