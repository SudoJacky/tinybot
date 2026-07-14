import type {
  TinyOsProcessState,
  TinyOsProvenance,
  TinyOsResourceAccess,
} from "./tinyOsKernelModel";

export type TinyOsNativeWorkspaceResource = {
  access: TinyOsResourceAccess;
  kind: "workspace_resource";
  path: string;
  resourceKind: "directory" | "file";
  workspaceKey: string;
};

export type TinyOsNativeTerminalProcess = {
  command?: string;
  kind: "terminal_process";
  nativeProcessId: string;
  runId: string;
  sessionId: string;
  state: TinyOsProcessState;
  toolCallId?: string;
  workingDirectory?: string;
};

export type TinyOsNativeBrowserCapture = {
  browserSessionId?: string;
  captureId: string;
  kind: "browser_capture";
  realCapture: boolean;
  title?: string;
  url?: string;
};

export type TinyOsNativeSnapshotData =
  | TinyOsNativeWorkspaceResource
  | TinyOsNativeTerminalProcess
  | TinyOsNativeBrowserCapture;

export type TinyOsNativeSnapshot<T extends TinyOsNativeSnapshotData = TinyOsNativeSnapshotData> = {
  data: T;
  observedAt: string;
  provenance: TinyOsProvenance;
  revision: number | string;
  schemaVersion: "tinybot.tinyos_native_snapshot.v1";
  sourceId: string;
};

type NativeSnapshotMetadata = {
  observedAt: string;
  revision: number | string;
  sourceId: string;
};

export function createTinyOsWorkspaceResourceSnapshot(
  data: TinyOsNativeWorkspaceResource,
  metadata: NativeSnapshotMetadata,
): TinyOsNativeSnapshot<TinyOsNativeWorkspaceResource> {
  return createTinyOsNativeSnapshot({
    ...data,
    path: requiredText(data.path, "Workspace resource path"),
    workspaceKey: requiredText(data.workspaceKey, "Workspace key"),
  }, metadata, "native_query");
}

export function createTinyOsTerminalProcessSnapshot(
  data: TinyOsNativeTerminalProcess,
  metadata: NativeSnapshotMetadata,
): TinyOsNativeSnapshot<TinyOsNativeTerminalProcess> {
  return createTinyOsNativeSnapshot({
    ...data,
    nativeProcessId: requiredText(data.nativeProcessId, "Native process id"),
    runId: requiredText(data.runId, "Terminal run id"),
    sessionId: requiredText(data.sessionId, "Terminal session id"),
  }, metadata, "native_query");
}

export function createTinyOsBrowserCaptureSnapshot(
  data: TinyOsNativeBrowserCapture,
  metadata: NativeSnapshotMetadata,
): TinyOsNativeSnapshot<TinyOsNativeBrowserCapture> {
  return createTinyOsNativeSnapshot({
    ...data,
    captureId: requiredText(data.captureId, "Browser capture id"),
  }, metadata, data.realCapture ? "real_capture" : "native_query");
}

function createTinyOsNativeSnapshot<T extends TinyOsNativeSnapshotData>(
  data: T,
  metadata: NativeSnapshotMetadata,
  provenanceKind: Extract<TinyOsProvenance["kind"], "native_query" | "real_capture">,
): TinyOsNativeSnapshot<T> {
  const sourceId = requiredText(metadata.sourceId, "Native snapshot source id");
  const observedAt = requiredObservationTime(metadata.observedAt);
  const revision = requiredRevision(metadata.revision);
  return {
    data,
    observedAt,
    provenance: {
      kind: provenanceKind,
      observedAt,
      revision,
      sourceId,
    },
    revision,
    schemaVersion: "tinybot.tinyos_native_snapshot.v1",
    sourceId,
  };
}

function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

function requiredObservationTime(value: string): string {
  const normalized = requiredText(value, "Native snapshot observation time");
  if (!Number.isFinite(Date.parse(normalized))) {
    throw new Error("Native snapshot observation time must be a valid timestamp.");
  }
  return normalized;
}

function requiredRevision(value: number | string): number | string {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) throw new Error("Native snapshot revision must be non-negative.");
    return value;
  }
  return requiredText(value, "Native snapshot revision");
}
