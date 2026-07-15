import type { BackendAgentTurnItem } from "./chatRunModel";
import type { TinyOsNativeBrowserSession, TinyOsNativeSnapshot } from "./tinyOsNativeSnapshot";

export type TinyOsProvenanceKind =
  | "canonical_event"
  | "native_query"
  | "real_capture"
  | "derived_measurement"
  | "local_presentation";

export type TinyOsProvenance = {
  kind: TinyOsProvenanceKind;
  observedAt?: string;
  revision?: number | string;
  sourceId: string;
};

export type TinyOsProcessState =
  | "queued"
  | "running"
  | "waiting_for_user"
  | "blocked"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export type TinyOsProcessKind =
  | "agent_run"
  | "agent_turn"
  | "tool_operation"
  | "terminal_process"
  | "browser_session"
  | "subagent"
  | "user_input_wait";

export type TinyOsProcessCorrelation = {
  browserSessionId?: string;
  commandId?: string;
  itemId?: string;
  nativeProcessId?: string;
  runId: string;
  sessionId: string;
  threadId?: string;
  toolCallId?: string;
  turnId?: string;
};

export type TinyOsProcess = {
  applicationId?: string;
  correlation: TinyOsProcessCorrelation;
  id: string;
  kind: TinyOsProcessKind;
  ownerAgentId?: string;
  parentProcessId?: string;
  provenance: TinyOsProvenance;
  state: TinyOsProcessState;
  title: string;
};

export type TinyOsResourceKind =
  | "file"
  | "directory"
  | "terminal_execution"
  | "terminal_session"
  | "browser_capture"
  | "browser_session"
  | "artifact"
  | "memory_result"
  | "plan"
  | "approval"
  | "form";

export type TinyOsResourceAccess = "read_only" | "read_write" | "execute" | "unavailable";

export type TinyOsResource = {
  access: TinyOsResourceAccess;
  id: string;
  kind: TinyOsResourceKind;
  path?: string;
  provenance: TinyOsProvenance;
  relatedProcessIds: string[];
  revision?: number | string;
  title: string;
};

export type TinyOsCapability = {
  available: boolean;
  id: string;
  provenance: TinyOsProvenance;
  processId?: string;
  reason?: string;
  reasonCode?: string;
};

export type TinyOsNotification = {
  id: string;
  kind: "info" | "success" | "warning" | "error";
  message: string;
  processId?: string;
  provenance: TinyOsProvenance;
  resourceId?: string;
  timestamp?: string;
  title: string;
};

export type TinyOsMetric = {
  calculation?: string;
  id: string;
  inputIds?: string[];
  label: string;
  provenance: TinyOsProvenance;
  processId?: string;
  resourceId?: string;
  unit?: string;
  value: number;
};

export type TinyOsDiscrepancy = {
  canonical: {
    entityId: string;
    provenance: TinyOsProvenance;
    value: string;
  };
  id: string;
  kind: "lifecycle" | "revision";
  message: string;
  native: {
    entityId: string;
    provenance: TinyOsProvenance;
    value: string;
  };
};

export type TinyOsSimulationCursor = {
  boundary?: {
    itemId: string;
    runId: string;
    sequence: number;
    turnId: string;
  };
  eventCount: number;
  eventIndex: number;
  mode: "live" | "history";
  wallClockTime?: string;
};

export type TinyOsKernelSnapshot = {
  browserSessions: TinyOsBrowserSessionProjection[];
  capabilities: TinyOsCapability[];
  cursor: TinyOsSimulationCursor;
  discrepancies: TinyOsDiscrepancy[];
  metrics: TinyOsMetric[];
  notifications: TinyOsNotification[];
  processes: TinyOsProcess[];
  resources: TinyOsResource[];
  truth: "derived";
};

export type TinyOsBrowserSessionProjection = TinyOsNativeBrowserSession & {
  observedAt: string;
  provenance: TinyOsProvenance;
  revision: number | string;
};

export type TinyOsResourceIdentityInput = {
  discriminator?: string;
  itemId: string;
  kind: TinyOsResourceKind;
  runId: string;
  sessionId: string;
  turnId: string;
};

export type TinyOsProcessIdentityInput =
  | { kind: "agent_run"; runId: string; sessionId: string }
  | { kind: "agent_turn"; runId: string; sessionId: string; turnId: string }
  | {
      itemId: string;
      kind: "tool_operation" | "subagent" | "user_input_wait";
      runId: string;
      sessionId: string;
      turnId: string;
    }
  | { kind: "terminal_process"; nativeProcessId: string; runId: string; sessionId: string }
  | { browserSessionId: string; kind: "browser_session"; runId: string; sessionId: string };

export type TinyOsKernelCursorInput =
  | { mode: "live" }
  | { eventIndex?: number; itemId: string; mode: "history"; runId?: string; turnId?: string };

export type TinyOsKernelProjectionOptions = {
  nativeSnapshots?: readonly TinyOsNativeSnapshot[];
};

export function createTinyOsProcessId(input: TinyOsProcessIdentityInput): string {
  const parts = [input.sessionId, input.runId];
  if (input.kind === "agent_turn") parts.push(input.turnId);
  if (input.kind === "tool_operation" || input.kind === "subagent" || input.kind === "user_input_wait") {
    parts.push(input.turnId, input.itemId);
  }
  if (input.kind === "terminal_process") parts.push(input.nativeProcessId);
  if (input.kind === "browser_session") parts.push(input.browserSessionId);
  return `tinyos:process:${input.kind}:${parts.map(stableIdentityPart).join(":")}`;
}

export function createTinyOsResourceId(input: TinyOsResourceIdentityInput): string {
  const parts = [input.sessionId, input.runId, input.turnId, input.itemId];
  if (input.discriminator) parts.push(input.discriminator);
  return `tinyos:resource:${input.kind}:${parts.map(stableIdentityPart).join(":")}`;
}

export function createTinyOsDerivedMetric(input: {
  calculation: string;
  id: string;
  inputIds: string[];
  label: string;
  unit?: string;
  value: number;
}): TinyOsMetric {
  const id = stableIdentityPart(input.id);
  const calculation = requiredKernelText(input.calculation, "TinyOS metric calculation");
  const inputIds = [...new Set(input.inputIds.map((value) => requiredKernelText(value, "TinyOS metric input id")))];
  if (!inputIds.length) throw new Error("TinyOS derived metrics require at least one input identity.");
  if (!Number.isFinite(input.value)) throw new Error("TinyOS metric value must be finite.");
  const metric: TinyOsMetric = {
    calculation,
    id: `tinyos:metric:${id}`,
    inputIds,
    label: requiredKernelText(input.label, "TinyOS metric label"),
    provenance: {
      kind: "derived_measurement",
      sourceId: `tinyos:metric:${id}`,
    },
    ...(input.unit ? { unit: input.unit } : {}),
    value: input.value,
  };
  assertTinyOsMetricSupported(metric);
  return metric;
}

export function assertTinyOsMetricSupported(metric: TinyOsMetric): void {
  if (!Number.isFinite(metric.value)) throw new Error(`TinyOS metric ${metric.id} has a non-finite value.`);
  if (metric.provenance.kind === "canonical_event" || metric.provenance.kind === "native_query") return;
  if (metric.provenance.kind !== "derived_measurement") {
    throw new Error(`TinyOS metric ${metric.id} has unsupported provenance ${metric.provenance.kind}.`);
  }
  if (!metric.calculation?.trim() || !metric.inputIds?.length) {
    throw new Error(`TinyOS derived metric ${metric.id} is missing auditable inputs or calculation.`);
  }
}

export function assertTinyOsResourceMutationReady(resource: TinyOsResource): void {
  if (resource.kind !== "file") throw new Error(`TinyOS resource ${resource.id} is not a mutable file.`);
  if (resource.access !== "read_write") throw new Error(`TinyOS file resource ${resource.id} is not writable.`);
  if (resource.revision === undefined || String(resource.revision).trim() === "") {
    throw new Error(`TinyOS file resource ${resource.id} requires a base revision.`);
  }
}

export function mergeTinyOsProcessObservation(
  current: TinyOsProcess,
  next: TinyOsProcess,
): TinyOsProcess {
  if (current.id !== next.id) throw new Error("TinyOS process observations must share an identity.");
  assertTinyOsProcessStateTransition(current.state, next.state, current.id);
  return next;
}

export function projectTinyOsKernel(
  items: readonly BackendAgentTurnItem[],
  cursorInput: TinyOsKernelCursorInput = { mode: "live" },
  options: TinyOsKernelProjectionOptions = {},
): TinyOsKernelSnapshot {
  const visibleItems = items.slice(0, projectionEndIndex(items, cursorInput));
  const latestItems = latestCanonicalItemRevisions(visibleItems);
  const processItems = latestItems.filter(isProcessItem);
  const processIdByItemId = new Map(processItems.map((item) => [item.itemId, itemProcessId(item)]));
  const processIdByToolCallId = new Map(processItems.filter((item) => item.kind === "tool_call").flatMap((item) => {
    const toolCallId = canonicalToolCallId(item);
    return toolCallId ? [[toolCallId, itemProcessId(item)] as const] : [];
  }));
  const grouped = groupCanonicalItems(latestItems);
  const processes: TinyOsProcess[] = [];

  for (const runItems of grouped.runs.values()) {
    const first = runItems[0];
    const latest = runItems[runItems.length - 1];
    processes.push({
      correlation: canonicalCorrelation(first),
      id: createTinyOsProcessId({ kind: "agent_run", runId: first.runId, sessionId: first.sessionId }),
      kind: "agent_run",
      ...(canonicalOwnerAgentId(latest) ? { ownerAgentId: canonicalOwnerAgentId(latest) } : {}),
      provenance: canonicalProvenance(latest),
      state: aggregateCanonicalState(runItems),
      title: `Agent run ${shortIdentity(first.runId)}`,
    });
  }

  for (const turnItems of grouped.turns.values()) {
    const first = turnItems[0];
    const latest = turnItems[turnItems.length - 1];
    processes.push({
      correlation: canonicalCorrelation(first),
      id: createTinyOsProcessId({
        kind: "agent_turn",
        runId: first.runId,
        sessionId: first.sessionId,
        turnId: first.turnId,
      }),
      kind: "agent_turn",
      ...(canonicalOwnerAgentId(latest) ? { ownerAgentId: canonicalOwnerAgentId(latest) } : {}),
      parentProcessId: createTinyOsProcessId({ kind: "agent_run", runId: first.runId, sessionId: first.sessionId }),
      provenance: canonicalProvenance(latest),
      state: aggregateCanonicalState(turnItems),
      title: `Agent turn ${shortIdentity(first.turnId)}`,
    });
  }

  for (const item of processItems) {
    const kind = processKind(item);
    const toolParentProcessId = item.kind === "tool_call"
      ? undefined
      : processIdByToolCallId.get(canonicalToolCallId(item));
    const parentProcessId = item.parentItemId && processIdByItemId.get(item.parentItemId)
      || toolParentProcessId
      || createTinyOsProcessId({
        kind: "agent_turn",
        runId: item.runId,
        sessionId: item.sessionId,
        turnId: item.turnId,
      });
    processes.push({
      ...(canonicalApplicationId(item) ? { applicationId: canonicalApplicationId(item) } : {}),
      correlation: canonicalCorrelation(item),
      id: itemProcessId(item),
      kind,
      ...(canonicalOwnerAgentId(item) ? { ownerAgentId: canonicalOwnerAgentId(item) } : {}),
      parentProcessId,
      provenance: canonicalProvenance(item),
      state: canonicalItemState(item),
      title: canonicalProcessTitle(item),
    });
  }

  const canonicalResources = projectCanonicalResources(latestItems, processIdByItemId, processIdByToolCallId);
  const native = projectNativeSnapshots(
    nativeSnapshotsAtCursor(options.nativeSnapshots ?? [], visibleItems, cursorInput),
    processIdByToolCallId,
  );
  const resources = [...canonicalResources, ...native.resources];
  const allProcesses = [...processes, ...native.processes];

  return {
    browserSessions: native.browserSessions,
    capabilities: [],
    cursor: simulationCursor(items, visibleItems, cursorInput),
    discrepancies: projectDiscrepancies(processes, canonicalResources, native.processes, native.resources),
    metrics: [],
    notifications: [],
    processes: allProcesses,
    resources,
    truth: "derived",
  };
}

function projectNativeSnapshots(
  snapshots: readonly TinyOsNativeSnapshot[],
  processIdByToolCallId: ReadonlyMap<string, string>,
): { browserSessions: TinyOsBrowserSessionProjection[]; processes: TinyOsProcess[]; resources: TinyOsResource[] } {
  const browserSessions: TinyOsBrowserSessionProjection[] = [];
  const processes: TinyOsProcess[] = [];
  const resources: TinyOsResource[] = [];
  for (const snapshot of latestNativeSnapshots(snapshots)) {
    const { data } = snapshot;
    if (data.kind === "workspace_resource") {
      resources.push({
        access: data.access,
        id: nativeResourceId(data.resourceKind, [data.workspaceKey, data.path]),
        kind: data.resourceKind,
        path: data.path,
        provenance: snapshot.provenance,
        relatedProcessIds: [],
        revision: snapshot.revision,
        title: data.path,
      });
      continue;
    }
    if (data.kind === "browser_capture") {
      resources.push({
        access: "read_only",
        id: nativeResourceId("browser_capture", [data.captureId]),
        kind: "browser_capture",
        provenance: snapshot.provenance,
        relatedProcessIds: [],
        revision: snapshot.revision,
        title: data.title || data.url || data.captureId,
      });
      continue;
    }
    if (data.kind === "browser_session") {
      const processId = createTinyOsProcessId({
        browserSessionId: data.browserSessionId,
        kind: "browser_session",
        runId: data.runId,
        sessionId: data.sessionId,
      });
      browserSessions.push({
        ...data,
        observedAt: snapshot.observedAt,
        provenance: snapshot.provenance,
        revision: snapshot.revision,
      });
      processes.push({
        applicationId: "browser",
        correlation: {
          browserSessionId: data.browserSessionId,
          runId: data.runId,
          sessionId: data.sessionId,
        },
        id: processId,
        kind: "browser_session",
        provenance: snapshot.provenance,
        state: data.state,
        title: data.tabs.find(({ tabId }) => tabId === data.activeTabId)?.title || `Browser session ${shortIdentity(data.browserSessionId)}`,
      });
      resources.push({
        access: data.interaction.navigate || data.interaction.click || data.interaction.type ? "execute" : "read_only",
        id: nativeResourceId("browser_session", [data.browserSessionId]),
        kind: "browser_session",
        provenance: snapshot.provenance,
        relatedProcessIds: [processId],
        revision: snapshot.revision,
        title: `Browser session ${shortIdentity(data.browserSessionId)}`,
      });
      for (const tab of data.tabs) {
        for (const capture of tab.captures) {
          resources.push({
            access: "read_only",
            id: nativeResourceId("browser_capture", [data.browserSessionId, tab.tabId, capture.captureId]),
            kind: "browser_capture",
            provenance: snapshot.provenance,
            relatedProcessIds: [processId],
            revision: snapshot.revision,
            title: `${tab.title} capture ${shortIdentity(capture.captureId)}`,
          });
        }
      }
      continue;
    }
    const id = createTinyOsProcessId({
      kind: "terminal_process",
      nativeProcessId: data.nativeProcessId,
      runId: data.runId,
      sessionId: data.sessionId,
    });
    const toolParentId = data.toolCallId ? processIdByToolCallId.get(data.toolCallId) : undefined;
    processes.push({
      applicationId: "terminal",
      correlation: {
        nativeProcessId: data.nativeProcessId,
        runId: data.runId,
        sessionId: data.sessionId,
        ...(data.toolCallId ? { toolCallId: data.toolCallId } : {}),
      },
      id,
      kind: "terminal_process",
      parentProcessId: toolParentId || createTinyOsProcessId({
        kind: "agent_run",
        runId: data.runId,
        sessionId: data.sessionId,
      }),
      provenance: snapshot.provenance,
      state: data.state,
      title: data.command || `Terminal process ${shortIdentity(data.nativeProcessId)}`,
    });
    resources.push({
      access: "execute",
      id: nativeResourceId("terminal_execution", [data.sessionId, data.runId, data.nativeProcessId]),
      kind: "terminal_execution",
      provenance: snapshot.provenance,
      relatedProcessIds: [id],
      revision: snapshot.revision,
      title: data.command || `Terminal execution ${shortIdentity(data.nativeProcessId)}`,
    });
  }
  return { browserSessions, processes, resources };
}

function latestNativeSnapshots(snapshots: readonly TinyOsNativeSnapshot[]): TinyOsNativeSnapshot[] {
  const latest = new Map<string, TinyOsNativeSnapshot>();
  for (const snapshot of snapshots) {
    if (snapshot.schemaVersion !== "tinybot.tinyos_native_snapshot.v1") {
      throw new Error(`Unsupported TinyOS native snapshot schema: ${snapshot.schemaVersion}`);
    }
    const key = nativeSnapshotEntityKey(snapshot);
    const current = latest.get(key);
    if (!current || Date.parse(snapshot.observedAt) >= Date.parse(current.observedAt)) latest.set(key, snapshot);
  }
  return [...latest.values()];
}

function nativeSnapshotEntityKey(snapshot: TinyOsNativeSnapshot): string {
  const { data } = snapshot;
  if (data.kind === "workspace_resource") return `${data.kind}:${data.workspaceKey}:${data.path}`;
  if (data.kind === "browser_capture") return `${data.kind}:${data.captureId}`;
  if (data.kind === "browser_session") return `${data.kind}:${data.browserSessionId}`;
  return `${data.kind}:${data.sessionId}:${data.runId}:${data.nativeProcessId}`;
}

function nativeResourceId(kind: TinyOsResourceKind, parts: string[]): string {
  return `tinyos:resource:${kind}:native:${parts.map(stableIdentityPart).join(":")}`;
}

function projectDiscrepancies(
  canonicalProcesses: readonly TinyOsProcess[],
  canonicalResources: readonly TinyOsResource[],
  nativeProcesses: readonly TinyOsProcess[],
  nativeResources: readonly TinyOsResource[],
): TinyOsDiscrepancy[] {
  const discrepancies: TinyOsDiscrepancy[] = [];
  for (const canonical of canonicalResources) {
    if (canonical.kind !== "file" || !canonical.path || canonical.revision === undefined) continue;
    const native = nativeResources.find((resource) => resource.kind === "file"
      && normalizeResourcePath(resource.path) === normalizeResourcePath(canonical.path));
    if (!native || native.revision === undefined || String(native.revision) === String(canonical.revision)) continue;
    discrepancies.push(discrepancy(
      "revision",
      canonical,
      String(canonical.revision),
      native,
      String(native.revision),
      `File revision differs for ${canonical.path}.`,
    ));
  }
  for (const native of nativeProcesses) {
    if (!native.correlation.toolCallId) continue;
    const canonical = canonicalProcesses.find((process) => process.kind === "tool_operation"
      && process.correlation.toolCallId === native.correlation.toolCallId);
    if (!canonical || canonical.state === native.state) continue;
    discrepancies.push(discrepancy(
      "lifecycle",
      canonical,
      canonical.state,
      native,
      native.state,
      `Process lifecycle differs for Tool call ${native.correlation.toolCallId}.`,
    ));
  }
  return discrepancies;
}

function discrepancy(
  kind: TinyOsDiscrepancy["kind"],
  canonical: Pick<TinyOsProcess | TinyOsResource, "id" | "provenance">,
  canonicalValue: string,
  native: Pick<TinyOsProcess | TinyOsResource, "id" | "provenance">,
  nativeValue: string,
  message: string,
): TinyOsDiscrepancy {
  return {
    canonical: { entityId: canonical.id, provenance: canonical.provenance, value: canonicalValue },
    id: `tinyos:discrepancy:${kind}:${stableIdentityPart(canonical.id)}:${stableIdentityPart(native.id)}`,
    kind,
    message,
    native: { entityId: native.id, provenance: native.provenance, value: nativeValue },
  };
}

function normalizeResourcePath(value?: string): string {
  return (value ?? "").replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

function projectCanonicalResources(
  items: readonly BackendAgentTurnItem[],
  processIdByItemId: ReadonlyMap<string, string>,
  processIdByToolCallId: ReadonlyMap<string, string>,
): TinyOsResource[] {
  return items.flatMap((item): TinyOsResource[] => {
    const relatedProcessIds = relatedProcessIdsForResource(item, processIdByItemId, processIdByToolCallId);
    if (item.kind === "file_reference") {
      const path = stringValue(item.data.path);
      if (!path) return [];
      return [canonicalResource(item, "file", path, relatedProcessIds, {
        path,
        revision: scalarRevision(item.data.revision),
      })];
    }
    if (item.kind === "plan_progress") {
      return [canonicalResource(item, "plan", item.title || "Plan", relatedProcessIds)];
    }
    if (item.kind === "approval") {
      return [canonicalResource(item, "approval", item.title || "Approval", relatedProcessIds, {
        revision: item.revision,
      })];
    }
    if (item.kind === "form") {
      return [canonicalResource(item, "form", stringValue(item.data.title) || item.title || "Form", relatedProcessIds, {
        revision: item.revision,
      })];
    }
    if (item.kind !== "tool_call") return [];
    const toolName = stringValue(item.data.name);
    const resources: TinyOsResource[] = [];
    if (TERMINAL_TOOL_RE.test(toolName)) {
      resources.push(canonicalResource(item, "terminal_execution", toolName, relatedProcessIds));
    }
    if (MEMORY_TOOL_RE.test(toolName)) {
      resources.push(canonicalResource(item, "memory_result", toolName, relatedProcessIds));
    }
    for (const artifact of canonicalArtifacts(item)) {
      const artifactId = stringValue(artifact.id ?? artifact.artifactId ?? artifact.artifact_id);
      if (!artifactId) continue;
      const artifactKind = stringValue(artifact.kind);
      const kind: TinyOsResourceKind = artifactKind === "browser_snapshot" ? "browser_capture" : "artifact";
      resources.push(canonicalResource(
        item,
        kind,
        stringValue(artifact.title) || artifactId,
        relatedProcessIds,
        { discriminator: artifactId },
      ));
    }
    return resources;
  });
}

function canonicalResource(
  item: BackendAgentTurnItem,
  kind: TinyOsResourceKind,
  title: string,
  relatedProcessIds: string[],
  options: { discriminator?: string; path?: string; revision?: number | string } = {},
): TinyOsResource {
  return {
    access: "read_only",
    id: createTinyOsResourceId({
      ...(options.discriminator ? { discriminator: options.discriminator } : {}),
      itemId: item.itemId,
      kind,
      runId: item.runId,
      sessionId: item.sessionId,
      turnId: item.turnId,
    }),
    kind,
    ...(options.path ? { path: options.path } : {}),
    provenance: canonicalProvenance(item),
    relatedProcessIds,
    ...(options.revision !== undefined ? { revision: options.revision } : {}),
    title,
  };
}

function relatedProcessIdsForResource(
  item: BackendAgentTurnItem,
  processIdByItemId: ReadonlyMap<string, string>,
  processIdByToolCallId: ReadonlyMap<string, string>,
): string[] {
  const itemProcessId = processIdByItemId.get(item.itemId);
  if (itemProcessId) return [itemProcessId];
  const toolProcessId = processIdByToolCallId.get(canonicalToolCallId(item));
  if (toolProcessId) return [toolProcessId];
  return [createTinyOsProcessId({
    kind: "agent_turn",
    runId: item.runId,
    sessionId: item.sessionId,
    turnId: item.turnId,
  })];
}

function canonicalArtifacts(item: BackendAgentTurnItem): Record<string, unknown>[] {
  const result = recordValue(item.data.result);
  const candidates = [item.data.artifacts, result.artifacts];
  return candidates.flatMap((value) => Array.isArray(value) ? value.filter(isRecord) : []);
}

function scalarRevision(value: unknown): number | string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const normalized = stringValue(value);
  return normalized || undefined;
}

function stableIdentityPart(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error("TinyOS stable identity parts must be non-empty.");
  return encodeURIComponent(normalized);
}

function projectionEndIndex(items: readonly BackendAgentTurnItem[], cursor: TinyOsKernelCursorInput): number {
  if (cursor.mode === "live") return items.length;
  if (cursor.eventIndex !== undefined) {
    if (!Number.isInteger(cursor.eventIndex) || cursor.eventIndex < 0 || cursor.eventIndex >= items.length) {
      throw new Error(`TinyOS history event index is unavailable: ${cursor.eventIndex}`);
    }
    const boundary = items[cursor.eventIndex];
    if (boundary.itemId !== cursor.itemId
      || (cursor.runId && boundary.runId !== cursor.runId)
      || (cursor.turnId && boundary.turnId !== cursor.turnId)) {
      throw new Error(`TinyOS history boundary identity does not match event index ${cursor.eventIndex}.`);
    }
    return cursor.eventIndex + 1;
  }
  const index = items.findIndex((item) => item.itemId === cursor.itemId
    && (!cursor.runId || item.runId === cursor.runId)
    && (!cursor.turnId || item.turnId === cursor.turnId));
  if (index < 0) throw new Error(`TinyOS history boundary is unavailable: ${cursor.itemId}`);
  return index + 1;
}

function nativeSnapshotsAtCursor(
  snapshots: readonly TinyOsNativeSnapshot[],
  visibleItems: readonly BackendAgentTurnItem[],
  cursor: TinyOsKernelCursorInput,
): readonly TinyOsNativeSnapshot[] {
  if (cursor.mode === "live") return snapshots;
  const boundaryTime = reliableCanonicalTimestamp(visibleItems[visibleItems.length - 1]);
  if (!boundaryTime) return [];
  const boundaryMs = Date.parse(boundaryTime);
  return snapshots.filter((snapshot) => Date.parse(snapshot.observedAt) <= boundaryMs);
}

function latestCanonicalItemRevisions(items: readonly BackendAgentTurnItem[]): BackendAgentTurnItem[] {
  const latestByIdentity = new Map<string, BackendAgentTurnItem>();
  for (const item of items) {
    const key = `${item.sessionId}:${item.runId}:${item.itemId}`;
    const current = latestByIdentity.get(key);
    if (!current) {
      latestByIdentity.set(key, item);
      continue;
    }
    if (item.revision >= current.revision) {
      if (isProcessItem(current) && isProcessItem(item)) {
        assertTinyOsProcessStateTransition(canonicalItemState(current), canonicalItemState(item), item.itemId);
      }
      latestByIdentity.set(key, item);
    }
  }
  return [...latestByIdentity.values()];
}

function groupCanonicalItems(items: readonly BackendAgentTurnItem[]) {
  const runs = new Map<string, BackendAgentTurnItem[]>();
  const turns = new Map<string, BackendAgentTurnItem[]>();
  for (const item of items) {
    appendGrouped(runs, `${item.sessionId}:${item.runId}`, item);
    appendGrouped(turns, `${item.sessionId}:${item.runId}:${item.turnId}`, item);
  }
  return { runs, turns };
}

function appendGrouped(
  groups: Map<string, BackendAgentTurnItem[]>,
  key: string,
  item: BackendAgentTurnItem,
): void {
  const group = groups.get(key) ?? [];
  group.push(item);
  groups.set(key, group);
}

function isProcessItem(item: BackendAgentTurnItem): boolean {
  return item.kind === "tool_call"
    || item.kind === "approval"
    || item.kind === "form"
    || item.kind === "subagent_lifecycle";
}

function processKind(item: BackendAgentTurnItem): Extract<
  TinyOsProcessKind,
  "tool_operation" | "subagent" | "user_input_wait"
> {
  if (item.kind === "tool_call") return "tool_operation";
  if (item.kind === "subagent_lifecycle") return "subagent";
  return "user_input_wait";
}

function itemProcessId(item: BackendAgentTurnItem): string {
  return createTinyOsProcessId({
    itemId: item.itemId,
    kind: processKind(item),
    runId: item.runId,
    sessionId: item.sessionId,
    turnId: item.turnId,
  });
}

function canonicalCorrelation(item: BackendAgentTurnItem): TinyOsProcessCorrelation {
  const toolCallId = canonicalToolCallId(item);
  const commandId = stringValue(item.data.commandId ?? item.data.command_id);
  return {
    itemId: item.itemId,
    runId: item.runId,
    sessionId: item.sessionId,
    ...(item.threadId ? { threadId: item.threadId } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    ...(item.turnId ? { turnId: item.turnId } : {}),
    ...(commandId ? { commandId } : {}),
  };
}

function canonicalToolCallId(item: BackendAgentTurnItem): string {
  return stringValue(item.data.toolCallId ?? item.data.tool_call_id);
}

function canonicalOwnerAgentId(item: BackendAgentTurnItem): string {
  return stringValue(item.data.agentId ?? item.data.agent_id);
}

function canonicalApplicationId(item: BackendAgentTurnItem): string {
  if (item.kind === "approval" || item.kind === "form") return "inspector";
  if (item.kind === "subagent_lifecycle") return "subagents";
  if (item.kind !== "tool_call") return "";
  const toolName = stringValue(item.data.name);
  if (TERMINAL_TOOL_RE.test(toolName)) return "terminal";
  if (MEMORY_TOOL_RE.test(toolName)) return "memory";
  if (BROWSER_TOOL_RE.test(toolName)) return "browser";
  if (PLAN_TOOL_RE.test(toolName)) return "plan";
  if (FILE_TOOL_RE.test(toolName)) return "files";
  return "inspector";
}

function canonicalProvenance(item: BackendAgentTurnItem): TinyOsProvenance {
  return {
    kind: "canonical_event",
    observedAt: item.updatedAt || item.createdAt,
    revision: item.revision,
    sourceId: item.itemId,
  };
}

function canonicalItemState(item: BackendAgentTurnItem): TinyOsProcessState {
  const status = item.status.trim().toLowerCase();
  if ((item.kind === "approval" || item.kind === "form") && !isTerminalStatus(status)) return "waiting_for_user";
  if (status === "running" || status === "in_progress") return "running";
  if (status === "waiting_for_user" || status === "awaiting_user" || status === "awaiting_approval") return "waiting_for_user";
  if (status === "blocked" || status === "denied") return "blocked";
  if (status === "paused") return "paused";
  if (status === "completed" || status === "succeeded" || status === "success") return "completed";
  if (status === "failed" || status === "error") return "failed";
  if (status === "cancelled" || status === "canceled" || status === "interrupted") return "cancelled";
  return "queued";
}

function aggregateCanonicalState(items: readonly BackendAgentTurnItem[]): TinyOsProcessState {
  const latest = items[items.length - 1];
  if (!latest) return "queued";
  if (latest.kind === "error") {
    return latest.data.cancelled || latest.status === "cancelled" ? "cancelled" : "failed";
  }
  if (latest.kind === "assistant_message" && latest.data.phase === "final_answer" && latest.status === "completed") {
    return "completed";
  }
  const itemStates = items.map(canonicalItemState);
  if (itemStates.includes("waiting_for_user")) return "waiting_for_user";
  if (itemStates.includes("paused")) return "paused";
  if (itemStates.includes("blocked")) return "blocked";
  if (itemStates.includes("running")) return "running";
  return "queued";
}

function isTerminalStatus(status: string): boolean {
  return status === "completed"
    || status === "succeeded"
    || status === "success"
    || status === "failed"
    || status === "error"
    || status === "cancelled"
    || status === "canceled"
    || status === "interrupted";
}

function assertTinyOsProcessStateTransition(
  current: TinyOsProcessState,
  next: TinyOsProcessState,
  processId: string,
): void {
  if (!TERMINAL_PROCESS_STATES.has(current)) return;
  if (current !== next) {
    throw new Error(`TinyOS process ${processId} cannot transition from terminal state ${current} to ${next}.`);
  }
}

function canonicalProcessTitle(item: BackendAgentTurnItem): string {
  if (item.title?.trim()) return item.title;
  if (item.kind === "tool_call") return stringValue(item.data.name) || "Tool operation";
  if (item.kind === "approval") return "Approval required";
  if (item.kind === "form") return stringValue(item.data.title) || "Input required";
  if (item.kind === "subagent_lifecycle") return stringValue(item.data.agentId) || "Subagent";
  return item.kind;
}

function simulationCursor(
  allItems: readonly BackendAgentTurnItem[],
  visibleItems: readonly BackendAgentTurnItem[],
  input: TinyOsKernelCursorInput,
): TinyOsSimulationCursor {
  const boundary = visibleItems[visibleItems.length - 1];
  const wallClockTime = reliableCanonicalTimestamp(boundary);
  return {
    ...(boundary ? {
      boundary: {
        itemId: boundary.itemId,
        runId: boundary.runId,
        sequence: boundary.sequence,
        turnId: boundary.turnId,
      },
      ...(wallClockTime ? { wallClockTime } : {}),
    } : {}),
    eventCount: allItems.length,
    eventIndex: visibleItems.length - 1,
    mode: input.mode,
  };
}

function reliableCanonicalTimestamp(item: BackendAgentTurnItem | undefined): string {
  const value = item?.updatedAt || item?.createdAt || "";
  return value && Number.isFinite(Date.parse(value)) ? value : "";
}

function shortIdentity(value: string): string {
  return value.length <= 12 ? value : value.slice(0, 12);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function requiredKernelText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

const TERMINAL_TOOL_RE = /(?:^|[._-])(shell|terminal|command|exec|process|powershell|bash)(?:$|[._-])/i;
const MEMORY_TOOL_RE = /(?:^|[._-])(memory|recall)(?:$|[._-])/i;
const BROWSER_TOOL_RE = /(?:^|[._-])(browser|web|navigate|screenshot|page)(?:$|[._-])/i;
const PLAN_TOOL_RE = /(?:^|[._-])(plan|update_plan|task_progress)(?:$|[._-])/i;
const FILE_TOOL_RE = /(?:^|[._-])(file|workspace|path|directory|search|grep|glob|read|write|patch)(?:$|[._-])/i;
const TERMINAL_PROCESS_STATES = new Set<TinyOsProcessState>(["completed", "failed", "cancelled"]);
