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
  droppedBytes?: number;
  durationMs?: number;
  executionContract: "retained_execution_v1";
  exitCode?: number;
  kind: "terminal_process";
  networkMode?: "denied" | "unavailable";
  nativeProcessId: string;
  outputTruncated?: boolean;
  runId: string;
  sandboxMode?: "read_only" | "unavailable";
  sessionId: string;
  state: TinyOsProcessState;
  stderrBytes?: number;
  stdoutBytes?: number;
  toolCallId?: string;
  workingDirectory?: string;
};

export type TinyOsRetainedTerminalCapabilityV1 = {
  cancel: boolean;
  contract: "retained_execution_v1";
  persistentPty: false;
  start: boolean;
};

export type TinyOsNativeBrowserCapture = {
  browserSessionId?: string;
  captureId: string;
  kind: "browser_capture";
  realCapture: boolean;
  stale?: boolean;
  tabId?: string;
  title?: string;
  url?: string;
};

export type TinyOsBrowserNavigationEntryV1 = {
  captureId?: string;
  observedAt?: string;
  title?: string;
  url: string;
};

export type TinyOsBrowserCaptureV1 = {
  captureId: string;
  observedAt: string;
  stale: boolean;
};

export type TinyOsBrowserTabV1 = {
  activeHistoryIndex: number;
  captures: TinyOsBrowserCaptureV1[];
  currentCaptureId?: string;
  history: TinyOsBrowserNavigationEntryV1[];
  loading: boolean;
  tabId: string;
  title: string;
  url: string;
};

export type TinyOsNativeBrowserSession = {
  activeTabId: string;
  browserSessionId: string;
  contract: "browser_session_v1";
  interaction: {
    click: boolean;
    navigate: boolean;
    type: boolean;
  };
  kind: "browser_session";
  runId: string;
  sessionId: string;
  state: TinyOsProcessState;
  tabs: TinyOsBrowserTabV1[];
};

export type TinyOsNativeSnapshotData =
  | TinyOsNativeWorkspaceResource
  | TinyOsNativeTerminalProcess
  | TinyOsNativeBrowserCapture
  | TinyOsNativeBrowserSession;

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
  data: Omit<TinyOsNativeTerminalProcess, "executionContract"> & { executionContract?: "retained_execution_v1" },
  metadata: NativeSnapshotMetadata,
): TinyOsNativeSnapshot<TinyOsNativeTerminalProcess> {
  return createTinyOsNativeSnapshot({
    ...data,
    executionContract: data.executionContract ?? "retained_execution_v1",
    nativeProcessId: requiredText(data.nativeProcessId, "Native process id"),
    runId: requiredText(data.runId, "Terminal run id"),
    sessionId: requiredText(data.sessionId, "Terminal session id"),
    ...optionalNonNegative(data.droppedBytes, "Terminal dropped bytes", "droppedBytes"),
    ...optionalNonNegative(data.durationMs, "Terminal duration", "durationMs"),
    ...optionalNonNegative(data.stderrBytes, "Terminal stderr bytes", "stderrBytes"),
    ...optionalNonNegative(data.stdoutBytes, "Terminal stdout bytes", "stdoutBytes"),
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

export function createTinyOsBrowserSessionSnapshot(
  data: TinyOsNativeBrowserSession,
  metadata: NativeSnapshotMetadata,
): TinyOsNativeSnapshot<TinyOsNativeBrowserSession> {
  if (data.contract !== "browser_session_v1") {
    throw new Error("TinyOS browser session uses an unsupported contract.");
  }
  const tabs = data.tabs.map(normalizeBrowserTab);
  if (!tabs.length) throw new Error("TinyOS browser session requires at least one tab.");
  assertUnique(tabs.map(({ tabId }) => tabId), "TinyOS browser tab id");
  const activeTabId = requiredText(data.activeTabId, "Active browser tab id");
  if (!tabs.some(({ tabId }) => tabId === activeTabId)) {
    throw new Error(`Active browser tab ${activeTabId} is not present in the session snapshot.`);
  }
  return createTinyOsNativeSnapshot({
    ...data,
    activeTabId,
    browserSessionId: requiredText(data.browserSessionId, "Browser session id"),
    runId: requiredText(data.runId, "Browser run id"),
    sessionId: requiredText(data.sessionId, "Browser owner session id"),
    tabs,
  }, metadata, "native_query");
}

function normalizeBrowserTab(tab: TinyOsBrowserTabV1): TinyOsBrowserTabV1 {
  const tabId = requiredText(tab.tabId, "Browser tab id");
  const history = tab.history.map((entry) => ({
    ...entry,
    ...(entry.captureId ? { captureId: requiredText(entry.captureId, "Browser history capture id") } : {}),
    ...(entry.observedAt ? { observedAt: requiredObservationTime(entry.observedAt) } : {}),
    url: requiredText(entry.url, "Browser history URL"),
  }));
  const maxHistoryIndex = history.length - 1;
  if (tab.activeHistoryIndex < 0 || tab.activeHistoryIndex > maxHistoryIndex) {
    throw new Error(`Browser tab ${tabId} active history index is outside its history.`);
  }
  const captures = tab.captures.map((capture) => ({
    ...capture,
    captureId: requiredText(capture.captureId, "Browser capture id"),
    observedAt: requiredObservationTime(capture.observedAt),
  }));
  assertUnique(captures.map(({ captureId }) => captureId), `Browser tab ${tabId} capture id`);
  const currentCaptureId = tab.currentCaptureId
    ? requiredText(tab.currentCaptureId, "Current browser capture id")
    : undefined;
  if (currentCaptureId && !captures.some(({ captureId }) => captureId === currentCaptureId)) {
    throw new Error(`Browser tab ${tabId} current capture ${currentCaptureId} is missing.`);
  }
  return {
    ...tab,
    captures,
    ...(currentCaptureId ? { currentCaptureId } : {}),
    history,
    tabId,
    title: requiredText(tab.title, "Browser tab title"),
    url: requiredText(tab.url, "Browser tab URL"),
  };
}

function assertUnique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label}s must be unique.`);
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

function optionalNonNegative<TName extends "droppedBytes" | "durationMs" | "stderrBytes" | "stdoutBytes">(
  value: number | undefined,
  label: string,
  name: TName,
): Partial<Record<TName, number>> {
  if (value === undefined) return {};
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be non-negative.`);
  return { [name]: value } as Partial<Record<TName, number>>;
}
