type NativeBrowserSnapshotProvenance = {
  kind: "native_query" | "real_capture";
  observedAt?: string;
  revision?: number | string;
  sourceId: string;
};

type NativeBrowserProcessState =
  | "queued"
  | "running"
  | "waiting_for_user"
  | "blocked"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export type NativeBrowserNavigationEntryV1 = {
  captureId?: string;
  observedAt?: string;
  title?: string;
  url: string;
};

export type NativeBrowserCaptureV1 = {
  captureId: string;
  dataUrl?: string;
  deviceScale?: number;
  navigationId?: string;
  observationRevision?: number;
  observedAt: string;
  stale: boolean;
  viewportHeight?: number;
  viewportWidth?: number;
};

export type NativeBrowserTabV1 = {
  activeHistoryIndex: number;
  captures: NativeBrowserCaptureV1[];
  canGoBack?: boolean;
  canGoForward?: boolean;
  currentCaptureId?: string;
  history: NativeBrowserNavigationEntryV1[];
  lifecycle?: "creating" | "ready" | "loading" | "closing" | "closed" | "crashed";
  rendererLifecycle?: "starting" | "running" | "failed" | "restarting" | "stopped";
  loading: boolean;
  navigationId?: string;
  observationRevision?: number;
  semanticObservation?: {
    nodes: Array<{
      disabled: boolean;
      focused: boolean;
      frame: string;
      height: number;
      name: string;
      role: string;
      sensitive: boolean;
      protectedReason?: string;
      targetRef: string;
      width: number;
      x: number;
      y: number;
    }>;
    observationRevision: number;
    observedAt: string;
    truncated: boolean;
  };
  tabId: string;
  title: string;
  url: string;
};

export type NativeBrowserSession = {
  activeTabId: string;
  browserSessionId: string;
  contract: "browser_session_v1";
  interaction: {
    click: boolean;
    key?: boolean;
    navigate: boolean;
    scroll?: boolean;
    semantic?: boolean;
    type: boolean;
    wait?: boolean;
  };
  kind: "browser_session";
  lifecycle?: "creating" | "ready" | "closing" | "closed" | "failed" | "crashed";
  profileId?: string;
  profilePersistence?: "persistent" | "incognito";
  operationId: string;
  runtimeKind?: string;
  runtimeVersion?: string;
  sessionId: string;
  state: NativeBrowserProcessState;
  control?: {
    activeCommandId?: string;
    controlEpoch: number;
    reason?: string;
    state: "idle" | "agent_active" | "user_required" | "interrupted" | "failed" | "recovering";
  };
  surface?: {
    layoutRevision: number;
    lifecycle: "detached" | "attaching" | "visible" | "hidden" | "failed";
    reason?: string;
    rect?: { deviceScale: number; height: number; width: number; x: number; y: number };
    surfaceId?: string;
    tabId?: string;
  };
  pendingPolicyRequest?: {
    kind: "popup" | "external_protocol";
    requestId: string;
    safeUrl: string;
    sourceTabId: string;
  };
  tabs: NativeBrowserTabV1[];
};

export type NativeBrowserSnapshotData = NativeBrowserSession;

export type NativeBrowserSnapshot<T extends NativeBrowserSnapshotData = NativeBrowserSnapshotData> = {
  data: T;
  observedAt: string;
  provenance: NativeBrowserSnapshotProvenance;
  revision: number | string;
  schemaVersion: "tinybot.browser_snapshot.v1";
  sourceId: string;
};

type NativeSnapshotMetadata = {
  observedAt: string;
  revision: number | string;
  sourceId: string;
};

export function createNativeBrowserSessionSnapshot(
  data: NativeBrowserSession,
  metadata: NativeSnapshotMetadata,
): NativeBrowserSnapshot<NativeBrowserSession> {
  if (data.contract !== "browser_session_v1") {
    throw new Error("Native browser session uses an unsupported contract.");
  }
  const tabs = data.tabs.map(normalizeBrowserTab);
  if (!tabs.length) throw new Error("Native browser session requires at least one tab.");
  assertUnique(tabs.map(({ tabId }) => tabId), "Native browser tab id");
  const activeTabId = requiredText(data.activeTabId, "Active browser tab id");
  if (!tabs.some(({ tabId }) => tabId === activeTabId)) {
    throw new Error(`Active browser tab ${activeTabId} is not present in the session snapshot.`);
  }
  return createNativeBrowserSnapshot({
    ...data,
    activeTabId,
    browserSessionId: requiredText(data.browserSessionId, "Browser session id"),
    operationId: requiredText(data.operationId, "Browser operation id"),
    sessionId: requiredText(data.sessionId, "Browser owner session id"),
    tabs,
  }, metadata, "native_query");
}

function normalizeBrowserTab(tab: NativeBrowserTabV1): NativeBrowserTabV1 {
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

function createNativeBrowserSnapshot<T extends NativeBrowserSnapshotData>(
  data: T,
  metadata: NativeSnapshotMetadata,
  provenanceKind: Extract<NativeBrowserSnapshotProvenance["kind"], "native_query" | "real_capture">,
): NativeBrowserSnapshot<T> {
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
    schemaVersion: "tinybot.browser_snapshot.v1",
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
