import type { AgentInputReference } from "./agentInputReference";
import { parseDataViewDocument, type DataViewDocument } from "./dataView";

export type ChatTurnStatus = "pending" | "running" | "awaiting_user" | "completed" | "failed" | "interrupted";
export type ChatStepStatus = "pending" | "running" | "blocked" | "completed" | "failed" | "cancelled";
export type AssistantMessagePhase = "unknown" | "commentary" | "final_answer";
export type AgentContextType = "main" | "spawn" | "subagent" | "team";
export type ArtifactKind =
  | "data_view"
  | "terminal_output"
  | "file_diff"
  | "browser_snapshot"
  | "image"
  | "markdown"
  | "json"
  | "generated_file"
  | "text";

export type AgentContext = {
  id: string;
  title: string;
  type: AgentContextType;
};

export type ArtifactRef = {
  dataView?: DataViewDocument;
  dataViewError?: string;
  fetchPath?: string;
  id: string;
  kind: ArtifactKind | string;
  mimeType?: string;
  preview?: string;
  sizeBytes?: number;
  status?: string;
  title: string;
  warnings?: string[];
};

export type TokenUsage = {
  cachedTokens?: number;
  completionTokens?: number;
  contextWindowRemainingTokens?: number;
  contextWindowStrategy?: string;
  contextWindowTokens?: number;
  contextWindowUsedTokens?: number;
  estimatedContextTokens?: number;
  percent?: number;
  promptTokens?: number;
  totalTokens?: number;
};

export type ToolCallState = {
  argsJson?: unknown;
  argsPreview?: string;
  durationMs?: number;
  id: string;
  name: string;
  resultJson?: unknown;
  resultPreview?: string;
  resultRef?: string;
  stderrPreview?: string;
};

export type DelegatedAgentState = {
  agentCount?: number;
  artifacts?: ArtifactRef[];
  childTurnId?: string;
  childToolCallId?: string;
  finalOutput?: string;
  id: string;
  latestActivity?: string;
  operationPreview?: string;
  parentToolCallId?: string;
  permissionProfile?: string;
  reason?: string;
  status: ChatStepStatus;
  task?: string;
  title: string;
  toolName?: string;
  trace?: DelegatedAgentTraceState;
  traceRef?: string;
  type: AgentContextType;
  workflow?: string;
};

export type DelegatedAgentTraceStep = {
  argsPreview?: string;
  createdAt?: string;
  error?: string;
  id: string;
  kind: string;
  resultPreview?: string;
  status: ChatStepStatus;
  summary?: string;
  title: string;
  toolCallId?: string;
  toolName?: string;
  updatedAt?: string;
};

export type DelegatedAgentTraceState = {
  artifacts?: ArtifactRef[];
  childTurnId?: string;
  delegateId: string;
  finalMessage?: ChatMessage;
  parentTurnId?: string;
  parentSessionKey?: string;
  status: ChatStepStatus;
  steps: DelegatedAgentTraceStep[];
  updatedAt?: string;
};

export type LoadedArtifactDetail = {
  dataView?: DataViewDocument;
  id: string;
  imageDataUrl?: string;
  mimeType?: string;
  textContent?: string;
  title: string;
};

export function projectLoadedArtifactDetail(
  reference: ArtifactRef,
  payload: unknown,
): LoadedArtifactDetail {
  const root = recordValue(payload);
  const artifact = recordValue(root.artifact ?? payload);
  if (!Object.keys(artifact).length) {
    throw new Error(`Artifact payload is invalid for ${reference.id}.`);
  }
  const id = stringValue(artifact.artifactId ?? artifact.artifact_id ?? artifact.id) || reference.id;
  if (id !== reference.id) {
    throw new Error(`Artifact ${id} does not match ${reference.id}.`);
  }
  const content = stringValue(artifact.content ?? artifact.preview);
  const mimeType = stringValue(artifact.mimeType ?? artifact.mime_type) || reference.mimeType;
  const dataView = reference.kind === "data_view"
    ? parseDataViewDocument(artifact.content ?? reference.dataView)
    : undefined;
  const imageDataUrl = safeRasterImageDataUrl(content);
  return {
    ...(dataView ? { dataView } : {}),
    id,
    ...(imageDataUrl ? { imageDataUrl } : {}),
    ...(mimeType ? { mimeType } : {}),
    ...(!imageDataUrl && content ? { textContent: safeArtifactText(content) } : {}),
    title: stringValue(artifact.title) || reference.title,
  };
}

function safeRasterImageDataUrl(value: string): string | undefined {
  return /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i.test(value)
    ? value
    : undefined;
}

export type FormState = {
  action?: string;
  errors?: Record<string, string>;
  fieldIds: string[];
  formId: string;
  values?: unknown;
};

export type PlanState = {
  completed: number;
  currentStep?: string;
  explanation?: string;
  steps: Array<{
    status: "pending" | "in_progress" | "completed" | "failed" | "cancelled";
    step: string;
  }>;
  total: number;
};

export type CompactionState = {
  contextWindowTokens?: number;
  droppedItemCount: number;
  estimatedTokensAfter?: number;
  estimatedTokensBefore?: number;
  strategy?: string;
};

export type ScopedErrorState = {
  cancelled: boolean;
  code: string;
  message: string;
};

export type ChatMessage = {
  clientEventId?: string;
  id: string;
  references?: AgentInputReference[];
  role: "user" | "assistant";
  text: string;
  timestamp: string;
};

export type ChatStepKind =
  | "reasoning"
  | "message"
  | "tool_call"
  | "tool_result"
  | "delegate"
  | "artifact"
  | "browser"
  | "form"
  | "plan"
  | "compaction"
  | "error";

export type ChatStep = {
  agentContext: AgentContext;
  artifacts?: ArtifactRef[];
  compaction?: CompactionState;
  completedAt?: string;
  delegate?: DelegatedAgentState;
  error?: unknown;
  form?: FormState;
  id: string;
  kind: ChatStepKind;
  messageId?: string;
  messagePhase?: AssistantMessagePhase;
  modelCallId?: string;
  parentStepId?: string;
  plan?: PlanState;
  references?: AgentInputReference[];
  scopedErrors?: ScopedErrorState[];
  sequence: number;
  startedAt?: string;
  status: ChatStepStatus;
  summary?: string;
  title: string;
  toolCall?: ToolCallState;
};

export type ChatTurn = {
  canonicalItems?: BackendAgentTurnItem[];
  completedAt?: string;
  executionItems?: ChatStep[];
  finalAnswer?: ChatMessage;
  finalMessage?: ChatMessage;
  id: string;
  sessionKey: string;
  startedAt: string;
  status: ChatTurnStatus;
  steps: ChatStep[];
  updatedAt: string;
  usage?: TokenUsage;
  userMessage: ChatMessage;
  userMessageId: string;
};

export type CanonicalTurnItemKind =
  | "user_message"
  | "assistant_message"
  | "reasoning"
  | "tool_call"
  | "form"
  | "subagent_lifecycle"
  | "subagent_message"
  | "plan_progress"
  | "context_compaction"
  | "usage"
  | "file_reference"
  | "error"
  | "system_notice";

export type CanonicalTurnItemData = Record<string, unknown> & (
  | { type: "user_message"; messageId?: string | null; clientEventId?: string | null; content: string; references?: unknown }
  | { type: "assistant_message"; messageId?: string | null; modelCallId: string; phase: AssistantMessagePhase; content: string }
  | { type: "reasoning"; modelCallId: string; summary: string }
  | { type: "tool_call"; toolCallId: string; name: string; status: string; args: unknown; result: unknown; detailId?: string | null; timing: unknown }
  | { type: "form"; formId: string; status: string; title?: string | null; action?: string | null; fieldIds: string[]; values: unknown; errors?: Record<string, string> | null; detailId?: string | null }
  | { type: "subagent_lifecycle"; agentId: string; action: string; status: string; message?: string | null; childTurnId?: string | null; childThreadId?: string | null; parentAgentId?: string | null; parentTurnId?: string | null; name?: string | null; task?: string | null; traceRef?: string | null }
  | { type: "subagent_message"; agentId: string; messageId: string; content: string; visibility: string }
  | { type: "plan_progress"; id: string; explanation?: string | null; steps: Array<{ step: string; status: "pending" | "in_progress" | "completed" }>; summary: string; completed: number; total: number; currentStep?: string | null }
  | { type: "context_compaction"; id: string; summary: string; droppedItemCount: number; contextWindowTokens?: number | null; strategy?: string | null; estimatedTokensBefore?: number | null; estimatedTokensAfter?: number | null }
  | { type: "usage"; id?: string | null; inputTokens?: number | null; outputTokens?: number | null; totalTokens?: number | null; providerPayload: unknown }
  | { type: "file_reference"; id: string; path: string; mimeType?: string | null; referenceKind: string }
  | { type: "error"; id?: string | null; code: string; message: string; commandId?: string | null; cancelled: boolean }
  | { type: "system_notice"; message: string; detail: unknown }
);

export type BackendAgentTurnItem = {
  schemaVersion: "tinybot.turn_item.v2";
  itemId: string;
  sessionId: string;
  threadId?: string;
  turnId: string;
  parentItemId?: string;
  sequence: number;
  revision: number;
  kind: CanonicalTurnItemKind;
  status: string;
  createdAt: string;
  updatedAt?: string;
  title?: string;
  summary?: string;
  data: CanonicalTurnItemData;
};

export type BackendAgentTimelineSnapshot = {
  schemaVersion: "tinybot.timeline.v2";
  sessionId: string;
  turnId: string;
  snapshotRevision: number;
  items: BackendAgentTurnItem[];
};

export type BackendAgentTurnStatus = "running" | "waiting" | "completed" | "failed" | "cancelled" | "interrupted";

export type BackendAgentTurnRuntimeState = {
  runtimeEvents?: unknown[];
  status?: BackendAgentTurnStatus;
  completedAt?: string;
  stopReason?: string;
  timeline: BackendAgentTimelineSnapshot;
};

export type BackendAgentTimelinePatch = {
  schemaVersion: "tinybot.timeline_patch.v2";
  sessionId: string;
  turnId: string;
  snapshotRevision: number;
  item: BackendAgentTurnItem;
};

const SENSITIVE_KEYS = new Set(["api_key", "token", "secret", "password", "authorization", "cookie", "credential", "private_key"]);
const UNSAFE_KEYS = new Set(["html", "script", "style", "component", "handler", "renderer", "template", "onClick", "onSubmit"]);

export function normalizeAgentTurnRuntimeStatePayload(payload: unknown): BackendAgentTurnRuntimeState {
  const value = recordValue(payload);
  const timeline = normalizeAgentTimelineSnapshotPayload(value.timeline);
  const status = normalizeBackendAgentTurnStatus(value.status);
  const completedAt = stringValue(value.completedAt ?? value.completed_at) || undefined;
  const stopReason = stringValue(value.stopReason ?? value.stop_reason) || undefined;
  return {
    runtimeEvents: Array.isArray(value.runtimeEvents) ? value.runtimeEvents : Array.isArray(value.runtime_events) ? value.runtime_events : [],
    ...(status ? { status } : {}),
    ...(completedAt ? { completedAt } : {}),
    ...(stopReason ? { stopReason } : {}),
    timeline,
  };
}

function normalizeBackendAgentTurnStatus(value: unknown): BackendAgentTurnStatus | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error("Canonical turn runtime status must be a string");
  }
  switch (value) {
    case "running":
    case "waiting":
    case "completed":
    case "failed":
    case "cancelled":
    case "interrupted":
      return value;
    default:
      throw new Error(`Unsupported canonical turn runtime status: ${value}`);
  }
}

export function normalizeAgentTimelineSnapshotPayload(payload: unknown): BackendAgentTimelineSnapshot {
  const timeline = recordValue(payload);
  if (stringValue(timeline.schemaVersion) !== "tinybot.timeline.v2") {
    throw new Error(`Unsupported canonical timeline schema: ${stringValue(timeline.schemaVersion) || "missing"}`);
  }
  const sessionId = requiredCanonicalString(timeline, "sessionId");
  const turnId = requiredCanonicalString(timeline, "turnId");
  const snapshotRevision = requiredCanonicalNumber(timeline, "snapshotRevision");
  if (!Array.isArray(timeline.items)) {
    throw new Error(`Canonical timeline ${turnId} is missing items`);
  }
  const seenItemIds = new Set<string>();
  const items = timeline.items.map((raw, index) => {
    if (!isRecord(raw)) {
      throw new Error(`Canonical timeline ${turnId} item ${index} is not an object`);
    }
    const item = normalizeCanonicalTurnItem(raw, sessionId, turnId);
    if (seenItemIds.has(item.itemId)) {
      throw new Error(`Canonical timeline ${turnId} contains duplicate item ${item.itemId}`);
    }
    seenItemIds.add(item.itemId);
    return item;
  });
  return {
    schemaVersion: "tinybot.timeline.v2",
    sessionId,
    turnId,
    snapshotRevision,
    items,
  };
}

export function normalizeAgentTimelinePatchPayload(payload: unknown): BackendAgentTimelinePatch {
  const value = recordValue(payload);
  if (stringValue(value.schemaVersion) !== "tinybot.timeline_patch.v2") {
    throw new Error(`Unsupported canonical timeline patch schema: ${stringValue(value.schemaVersion) || "missing"}`);
  }
  const sessionId = requiredCanonicalString(value, "sessionId");
  const turnId = requiredCanonicalString(value, "turnId");
  if (!isRecord(value.item)) {
    throw new Error(`Canonical timeline patch ${sessionId}/${turnId} is missing item`);
  }
  return {
    schemaVersion: "tinybot.timeline_patch.v2",
    sessionId,
    turnId,
    snapshotRevision: requiredCanonicalNumber(value, "snapshotRevision"),
    item: normalizeCanonicalTurnItem(value.item, sessionId, turnId),
  };
}

const CANONICAL_ITEM_KINDS = new Set<CanonicalTurnItemKind>([
  "user_message", "assistant_message", "reasoning", "tool_call", "form",
  "subagent_lifecycle", "subagent_message", "plan_progress", "context_compaction", "usage",
  "file_reference", "error", "system_notice",
]);

function normalizeCanonicalTurnItem(
  raw: Record<string, unknown>,
  sessionId: string,
  turnId: string,
): BackendAgentTurnItem {
  if (stringValue(raw.schemaVersion) !== "tinybot.turn_item.v2") {
    throw new Error(`Unsupported canonical item schema for ${stringValue(raw.itemId) || "unknown item"}`);
  }
  const itemId = requiredCanonicalString(raw, "itemId");
  const itemSessionId = requiredCanonicalString(raw, "sessionId");
  const itemTurnId = requiredCanonicalString(raw, "turnId");
  if (itemSessionId !== sessionId || itemTurnId !== turnId) {
    throw new Error(`Canonical item ${itemId} identity does not match timeline ${sessionId}/${turnId}`);
  }
  const kind = stringValue(raw.kind) as CanonicalTurnItemKind;
  if (!CANONICAL_ITEM_KINDS.has(kind)) {
    throw new Error(`Canonical item ${itemId} has unsupported kind ${kind || "missing"}`);
  }
  const data = recordValue(raw.data);
  if (stringValue(data.type) !== kind) {
    throw new Error(`Canonical item ${itemId} kind/data mismatch: ${kind}/${stringValue(data.type) || "missing"}`);
  }
  if (kind === "assistant_message") {
    requiredCanonicalString(data, "modelCallId");
    assistantMessagePhase(data.phase, itemId);
  }
  if (kind === "reasoning") {
    requiredCanonicalString(data, "modelCallId");
  }
  return {
    schemaVersion: "tinybot.turn_item.v2",
    itemId,
    sessionId: itemSessionId,
    ...(stringValue(raw.threadId) ? { threadId: stringValue(raw.threadId) } : {}),
    turnId: itemTurnId,
    ...(stringValue(raw.parentItemId) ? { parentItemId: stringValue(raw.parentItemId) } : {}),
    sequence: requiredCanonicalNumber(raw, "sequence"),
    revision: requiredCanonicalNumber(raw, "revision"),
    kind,
    status: requiredCanonicalString(raw, "status"),
    createdAt: requiredCanonicalString(raw, "createdAt"),
    ...(stringValue(raw.updatedAt) ? { updatedAt: stringValue(raw.updatedAt) } : {}),
    ...(stringValue(raw.title) ? { title: stringValue(raw.title) } : {}),
    ...(stringValue(raw.summary) ? { summary: safeArtifactText(stringValue(raw.summary)) } : {}),
    data: data as CanonicalTurnItemData,
  };
}

function assistantMessagePhase(value: unknown, itemId: string): AssistantMessagePhase {
  const phase = stringValue(value);
  if (phase === "unknown" || phase === "commentary" || phase === "final_answer") {
    return phase;
  }
  throw new Error(`Canonical assistant item ${itemId} has invalid phase ${phase || "missing"}`);
}

function requiredCanonicalString(value: Record<string, unknown>, key: string): string {
  const result = stringValue(value[key]);
  if (!result) {
    throw new Error(`Canonical timeline field ${key} is required`);
  }
  return result;
}

function requiredCanonicalNumber(value: Record<string, unknown>, key: string): number {
  const result = numberValue(value[key]);
  if (result === undefined || !Number.isInteger(result) || result < 0) {
    throw new Error(`Canonical timeline field ${key} must be a non-negative integer`);
  }
  return result;
}

export function backendRuntimeStatesToTurns(
  sessionKey: string,
  runtimeStates: BackendAgentTurnRuntimeState[],
): ChatTurn[] {
  const statesWithItems = runtimeStates
    .filter((state) => state.timeline.sessionId === sessionKey && state.timeline.items.length > 0)
    .sort(compareRuntimeStatesByStart);
  return statesWithItems.map((runtimeState) => runtimeStateToTurn(sessionKey, runtimeState));
}

function compareRuntimeStatesByStart(left: BackendAgentTurnRuntimeState, right: BackendAgentTurnRuntimeState): number {
  return compareRuntimeTimestamps(runtimeStateStart(left), runtimeStateStart(right))
    || left.timeline.turnId.localeCompare(right.timeline.turnId);
}

function runtimeStateStart(state: BackendAgentTurnRuntimeState): string {
  return state.timeline.items
    .map((item) => item.createdAt)
    .filter(Boolean)
    .sort(compareRuntimeTimestamps)[0] || "";
}

function runtimeStateToTurn(
  sessionKey: string,
  runtimeState: BackendAgentTurnRuntimeState,
): ChatTurn {
  const startedAt = runtimeStateStart(runtimeState) || new Date().toISOString();
  const updatedAt = runtimeState.timeline.items
    .map((item) => item.updatedAt || item.createdAt)
    .concat(runtimeState.completedAt ? [runtimeState.completedAt] : [])
    .filter(Boolean)
    .sort(compareRuntimeTimestamps);
  const lastUpdatedAt = updatedAt[updatedAt.length - 1] || startedAt;
  const turn: ChatTurn = {
    canonicalItems: [...runtimeState.timeline.items],
    id: runtimeState.timeline.turnId,
    sessionKey,
    userMessage: {
      id: stableId("user", runtimeState.timeline.turnId),
      role: "user",
      text: "",
      timestamp: startedAt,
    },
    userMessageId: stableId("user", runtimeState.timeline.turnId),
    status: "running",
    steps: [],
    startedAt,
    updatedAt: lastUpdatedAt,
  };

  for (const item of runtimeState.timeline.items) {
    applyTurnItemToTurn(turn, item);
  }
  attachScopedErrors(turn, runtimeState.timeline.items);
  attachFileReferences(turn, runtimeState.timeline.items);
  turn.executionItems = turn.steps;
  turn.status = statusForRuntimeBoundary(
    runtimeState.status,
    statusForTurnItems(runtimeState.timeline.items, turn.status),
  );
  reconcileTerminalStepStatuses(turn);
  if (turn.status === "completed" || turn.status === "failed" || turn.status === "interrupted") {
    turn.completedAt = runtimeState.completedAt ?? turn.completedAt ?? lastUpdatedAt;
  }
  return turn;
}

function compareRuntimeTimestamps(left: string, right: string): number {
  const leftMillis = runtimeTimestampMillis(left);
  const rightMillis = runtimeTimestampMillis(right);
  if (Number.isFinite(leftMillis) && Number.isFinite(rightMillis) && leftMillis !== rightMillis) {
    return leftMillis - rightMillis;
  }
  if (Number.isFinite(leftMillis) !== Number.isFinite(rightMillis)) {
    return Number.isFinite(leftMillis) ? -1 : 1;
  }
  return left.localeCompare(right);
}

function runtimeTimestampMillis(value: string): number {
  const trimmed = value.trim();
  if (!trimmed) {
    return Number.NaN;
  }
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed);
  }
  return Date.parse(trimmed);
}

function applyTurnItemToTurn(turn: ChatTurn, item: BackendAgentTurnItem): void {
  const payload = item.data;
  const sequence = item.sequence;
  const status = itemStatusToStepStatus(item.status);
  if (item.kind === "user_message") {
    const messageId = stringValue(payload.messageId ?? payload.message_id) || turn.userMessage.id;
    const text = stringValue(payload.content ?? payload.text ?? item.summary);
    turn.userMessage = {
      ...(stringValue(payload.clientEventId) ? { clientEventId: stringValue(payload.clientEventId) } : {}),
      id: messageId,
      references: normalizeReferences(payload.references ?? payload.contextReferences ?? payload.context_references),
      role: "user",
      text: text || turn.userMessage.text,
      timestamp: item.createdAt || turn.userMessage.timestamp,
    };
    turn.userMessageId = messageId;
    return;
  }
  if (item.kind === "assistant_message") {
    const text = safeArtifactText(stringValue(payload.content ?? payload.text ?? payload.finalContent ?? item.summary));
    const messageId = stringValue(payload.messageId ?? payload.message_id) || item.itemId;
    const phase = assistantMessagePhase(payload.phase, item.itemId);
    const modelCallId = requiredCanonicalString(payload, "modelCallId");
    if (phase === "final_answer") {
      turn.finalAnswer = {
        id: messageId,
        role: "assistant",
        text,
        timestamp: item.updatedAt || item.createdAt || turn.updatedAt,
      };
      return;
    }
    if (text) {
      turn.steps.push(runtimeStep(item, sequence, {
        kind: "message",
        messageId,
        messagePhase: phase,
        modelCallId,
        status,
        summary: text,
        title: item.title || (phase === "commentary" ? "Progress update" : "Assistant message"),
      }));
    }
    return;
  }
  if (item.kind === "reasoning") {
    turn.steps.push(runtimeStep(item, sequence, {
      kind: "reasoning",
      modelCallId: requiredCanonicalString(payload, "modelCallId"),
      status,
      summary: safeArtifactText(stringValue(payload.content ?? payload.summary ?? item.summary)),
      title: item.title || (status === "completed" ? "Thinking complete" : "Thinking"),
    }));
    return;
  }
  if (item.kind === "tool_call") {
    const toolCall = toolCallFromRuntimeItem(item);
    const envelope = recordValue(item.data.result);
    const resultStatus = stringValue(item.data.resultStatus ?? envelope.status);
    const toolStatus = resultStatus === "error" || resultStatus === "denied" ? "failed" : status;
    turn.steps.push(runtimeStep(item, sequence, {
      artifacts: artifactArray(envelope.artifacts),
      kind: "tool_call",
      status: toolStatus,
      title: item.title || toolCall.name,
      toolCall,
    }));
    return;
  }
  if (item.kind === "form") {
    const errors = recordValue(payload.errors);
    turn.steps.push(runtimeStep(item, sequence, {
      form: {
        ...(stringValue(payload.action) ? { action: stringValue(payload.action) } : {}),
        ...(Object.keys(errors).length > 0
          ? { errors: Object.fromEntries(Object.entries(errors).map(([key, value]) => [key, stringValue(value)])) }
          : {}),
        fieldIds: Array.isArray(payload.fieldIds)
          ? payload.fieldIds.map(stringValue).filter(Boolean)
          : [],
        formId: requiredCanonicalString(payload, "formId"),
        ...(payload.values !== undefined && payload.values !== null ? { values: payload.values } : {}),
      },
      kind: "form",
      status: status === "completed" ? "completed" : "blocked",
      summary: safeArtifactText(stringValue(payload.summary ?? payload.title ?? item.summary)),
      title: item.title || safeArtifactText(stringValue(payload.title)) || "Form requested",
    }));
    return;
  }
  if (item.kind === "subagent_lifecycle") {
    const delegate = delegateFromRuntimeItem(item);
    turn.steps.push(runtimeStep(item, sequence, {
      delegate,
      kind: "delegate",
      status: delegate.status,
      title: delegate.title,
    }));
    return;
  }
  if (item.kind === "subagent_message") {
    if (stringValue(payload.visibility) === "user") {
      turn.steps.push(runtimeStep(item, sequence, {
        kind: "message",
        status,
        summary: safeArtifactText(stringValue(payload.content)),
        title: item.title || "Subagent update",
      }));
    }
    return;
  }
  if (item.kind === "plan_progress") {
    if (!Array.isArray(payload.steps) || payload.steps.length === 0) {
      throw new Error(`Canonical plan ${item.itemId} must contain at least one step`);
    }
    const steps = payload.steps.map((rawStep, index) => {
      if (!isRecord(rawStep)) {
        throw new Error(`Canonical plan ${item.itemId} step ${index} is not an object`);
      }
      const step = requiredCanonicalString(rawStep, "step");
      const planStatus = requiredCanonicalString(rawStep, "status");
      if (planStatus !== "pending" && planStatus !== "in_progress" && planStatus !== "completed") {
        throw new Error(`Canonical plan ${item.itemId} step ${index} has invalid status ${planStatus}`);
      }
      return { status: planStatus as PlanState["steps"][number]["status"], step };
    });
    const completed = steps.filter((step) => step.status === "completed").length;
    const total = steps.length;
    if (numberValue(payload.completed) !== completed || numberValue(payload.total) !== total) {
      throw new Error(`Canonical plan ${item.itemId} progress counters do not match its steps`);
    }
    const currentStep = steps.find((step) => step.status === "in_progress")?.step;
    if (stringValue(payload.currentStep) !== (currentStep ?? "")) {
      throw new Error(`Canonical plan ${item.itemId} currentStep does not match its steps`);
    }
    turn.steps.push(runtimeStep(item, sequence, {
      kind: "plan",
      plan: {
        completed,
        ...(currentStep ? { currentStep } : {}),
        ...(stringValue(payload.explanation) ? { explanation: safeArtifactText(stringValue(payload.explanation)) } : {}),
        steps,
        total,
      },
      status,
      summary: safeArtifactText(stringValue(payload.summary ?? item.summary)),
      title: item.title || `Plan ${completed}/${total}`,
    }));
    return;
  }
  if (item.kind === "context_compaction") {
    turn.steps.push(runtimeStep(item, sequence, {
      compaction: {
        ...(numberValue(payload.contextWindowTokens) !== undefined
          ? { contextWindowTokens: numberValue(payload.contextWindowTokens) }
          : {}),
        droppedItemCount: numberValue(payload.droppedItemCount) ?? 0,
        ...(numberValue(payload.estimatedTokensBefore) !== undefined
          ? { estimatedTokensBefore: numberValue(payload.estimatedTokensBefore) }
          : {}),
        ...(numberValue(payload.estimatedTokensAfter) !== undefined
          ? { estimatedTokensAfter: numberValue(payload.estimatedTokensAfter) }
          : {}),
        ...(stringValue(payload.strategy)
          ? { strategy: stringValue(payload.strategy) }
          : {}),
      },
      kind: "compaction",
      status,
      summary: safeArtifactText(stringValue(payload.summary ?? item.summary)),
      title: item.title || "Context compacted",
    }));
    return;
  }
  if (item.kind === "usage") {
    const providerUsage = normalizeUsage(payload.providerPayload);
    turn.usage = {
      ...(providerUsage ?? {}),
      promptTokens: numberValue(payload.inputTokens) ?? providerUsage?.promptTokens,
      completionTokens: numberValue(payload.outputTokens) ?? providerUsage?.completionTokens,
      totalTokens: numberValue(payload.totalTokens) ?? providerUsage?.totalTokens,
    };
    return;
  }
  if (item.kind === "file_reference") {
    return;
  }
  if (item.kind === "error") {
    if (item.parentItemId) {
      return;
    }
    turn.steps.push(runtimeStep(item, sequence, {
      error: { code: payload.code, message: payload.message },
      kind: "error",
      status,
      summary: safeArtifactText(stringValue(payload.message ?? item.summary)),
      title: item.title || (Boolean(payload.cancelled) ? "Cancelled" : "Error"),
    }));
    return;
  }
  if (item.kind === "system_notice") {
    turn.steps.push(runtimeStep(item, sequence, {
      error: payload.error,
      kind: status === "failed" ? "error" : "message",
      status,
      summary: safeArtifactText(stringValue(payload.message ?? payload.content ?? item.summary ?? item.title)),
      title: item.title || (status === "failed" ? "Error" : "Runtime notice"),
    }));
  }
}

function attachScopedErrors(turn: ChatTurn, items: BackendAgentTurnItem[]): void {
  for (const item of items) {
    if (item.kind !== "error" || !item.parentItemId) {
      continue;
    }
    const scopedError: ScopedErrorState = {
      cancelled: Boolean(item.data.cancelled),
      code: requiredCanonicalString(item.data, "code"),
      message: requiredCanonicalString(item.data, "message"),
    };
    const owner = turn.steps.find((step) => step.id === item.parentItemId);
    if (owner) {
      owner.scopedErrors = [...(owner.scopedErrors ?? []), scopedError];
      continue;
    }
    turn.steps.push(runtimeStep(item, item.sequence, {
      error: scopedError,
      kind: "error",
      status: itemStatusToStepStatus(item.status),
      summary: scopedError.message,
      title: scopedError.cancelled ? "Cancelled" : "Error",
    }));
  }
}

function attachFileReferences(turn: ChatTurn, items: BackendAgentTurnItem[]): void {
  for (const item of items) {
    if (item.kind !== "file_reference") {
      continue;
    }
    const path = requiredCanonicalString(item.data, "path");
    const mimeType = stringValue(item.data.mimeType);
    const artifact: ArtifactRef = {
      id: stringValue(item.data.id) || item.itemId,
      kind: mimeType.startsWith("image/") ? "image" : "generated_file",
      ...(mimeType ? { mimeType } : {}),
      title: path.split(/[\\/]/).pop() || path,
      fetchPath: path,
      status: item.status,
    };
    const owner = item.parentItemId
      ? turn.steps.find((step) => step.id === item.parentItemId)
      : undefined;
    if (owner) {
      owner.artifacts = upsertArtifact(owner.artifacts ?? [], artifact);
      continue;
    }
    turn.steps.push(runtimeStep(item, item.sequence, {
      artifacts: [artifact],
      kind: "artifact",
      status: itemStatusToStepStatus(item.status),
      title: artifact.title,
    }));
  }
}

function runtimeStep(
  item: BackendAgentTurnItem,
  sequence: number,
  patch: Partial<ChatStep> & Pick<ChatStep, "kind" | "status" | "title">,
): ChatStep {
  return {
    agentContext: mainContext(),
    id: item.itemId,
    kind: patch.kind,
    sequence,
    startedAt: item.createdAt,
    ...(item.updatedAt && (patch.status === "completed" || patch.status === "failed" || patch.status === "cancelled") ? { completedAt: item.updatedAt } : {}),
    status: patch.status,
    title: patch.title,
    ...(patch.artifacts ? { artifacts: patch.artifacts } : {}),
    ...(patch.compaction ? { compaction: patch.compaction } : {}),
    ...(patch.delegate ? { delegate: patch.delegate } : {}),
    ...(patch.error !== undefined ? { error: patch.error } : {}),
    ...(patch.form ? { form: patch.form } : {}),
    ...(patch.messageId ? { messageId: patch.messageId } : {}),
    ...(patch.messagePhase ? { messagePhase: patch.messagePhase } : {}),
    ...(patch.modelCallId ? { modelCallId: patch.modelCallId } : {}),
    ...(patch.plan ? { plan: patch.plan } : {}),
    ...(patch.scopedErrors ? { scopedErrors: patch.scopedErrors } : {}),
    ...(patch.summary ? { summary: patch.summary } : {}),
    ...(patch.toolCall ? { toolCall: patch.toolCall } : {}),
  };
}

function toolCallFromRuntimeItem(item: BackendAgentTurnItem): ToolCallState {
  const payload = item.data;
  const envelope = recordValue(payload.result);
  const timing = recordValue(payload.timing);
  return {
    argsJson: payload.args,
    argsPreview: safeArtifactPreview(payload.args),
    durationMs: numberValue(timing.durationMs ?? timing.duration_ms),
    id: stringValue(payload.toolCallId) || item.itemId,
    name: stringValue(payload.name) || item.title || "tool",
    resultJson: payload.result,
    resultPreview: safeArtifactText(stringValue(item.summary ?? envelope.summary)),
    resultRef: stringValue(payload.detailId),
  };
}

function delegateFromRuntimeItem(item: BackendAgentTurnItem): DelegatedAgentState {
  const payload = item.data;
  const status = itemStatusToStepStatus(item.status);
  return {
    childTurnId: stringValue(payload.childTurnId ?? payload.child_turn_id),
    finalOutput: stringValue(payload.finalOutput ?? payload.final_output),
    id: stringValue(payload.agentId) || item.itemId,
    latestActivity: safeArtifactText(stringValue(payload.summary ?? payload.latestActivity ?? payload.latest_activity ?? item.summary)),
    parentToolCallId: stringValue(payload.toolCallId ?? payload.tool_call_id ?? payload.parentToolCallId ?? payload.parent_tool_call_id),
    status,
    task: stringValue(payload.task),
    title: item.title || stringValue(payload.message) || "Subagent activity",
    traceRef: stringValue(payload.traceRef),
    type: "subagent",
  };
}

function itemStatusToStepStatus(status: string): ChatStepStatus {
  switch (status.toLowerCase()) {
    case "queued":
      return "pending";
    case "waiting":
      return "blocked";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
    case "canceled":
      return "cancelled";
    case "running":
    default:
      return "running";
  }
}

function statusForTurnItems(items: BackendAgentTurnItem[], fallback: ChatTurnStatus): ChatTurnStatus {
  if (items.some((item) => item.status === "failed")) {
    return "failed";
  }
  if (items.some((item) => item.status === "cancelled")) {
    return "interrupted";
  }
  if (items.some((item) => item.status === "waiting")) {
    return "awaiting_user";
  }
  if (items.some((item) => (
    item.kind === "assistant_message"
      && stringValue(item.data.phase) === "final_answer"
      && item.status === "completed"
  ))) {
    return "completed";
  }
  if (items.some((item) => item.status === "running" || item.status === "queued")) {
    return "running";
  }
  return fallback;
}

function statusForRuntimeBoundary(
  status: BackendAgentTurnStatus | undefined,
  fallback: ChatTurnStatus,
): ChatTurnStatus {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
    case "interrupted":
      return "interrupted";
    case "waiting":
    case "running":
    case undefined:
      return fallback;
  }
}

function reconcileTerminalStepStatuses(turn: ChatTurn): void {
  if (turn.status !== "completed" && turn.status !== "failed" && turn.status !== "interrupted") {
    return;
  }

  for (const step of turn.steps) {
    if (step.plan) {
      step.plan.steps = step.plan.steps.map((planStep) => {
        if (planStep.status === "completed" || planStep.status === "failed" || planStep.status === "cancelled") {
          return planStep;
        }
        if (turn.status === "failed") {
          return { ...planStep, status: planStep.status === "in_progress" ? "failed" : "cancelled" };
        }
        return { ...planStep, status: "cancelled" };
      });
      step.plan.currentStep = undefined;
    }
    if (step.status === "pending" || step.status === "running" || step.status === "blocked") {
      step.status = turn.status === "completed"
        ? "completed"
        : turn.status === "failed"
          ? "failed"
          : "cancelled";
    }
  }
}

export function redactedPreview(value: unknown): string {
  return serialize(redactSensitive(value));
}

export function safeArtifactPreview(value: unknown): string {
  return serialize(omitUnsafe(redactSensitive(value)));
}

export function redactSensitive(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactSensitive);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    SENSITIVE_KEYS.has(key.toLowerCase()) ? "[redacted]" : redactSensitive(item),
  ]));
}

export function sanitizeTextPreview(value: string): string {
  return value
    .replace(/<\s*script\b[^>]*>[\s\S]*?<\s*\/\s*script\s*>/gi, "[unsafe omitted]")
    .replace(/<[^>]+>/g, "[unsafe omitted]")
    .replace(/\b(api_key|token|secret|password|authorization|cookie|credential|private_key)\s*[:=]\s*([^\s,;]+)/gi, "$1=[redacted]");
}

function artifactFromPayload(value: unknown): ArtifactRef {
  const payload = recordValue(value);
  const fetchPath = stringValue(payload.fetch_path ?? payload.fetchPath);
  const kind = stringValue(payload.kind) || "text";
  let dataView: DataViewDocument | undefined;
  let dataViewError: string | undefined;
  if (kind === "data_view") {
    try {
      dataView = parseDataViewDocument(payload.content);
    } catch (error) {
      dataViewError = error instanceof Error ? error.message : String(error);
    }
  }
  return {
    ...(dataView ? { dataView } : {}),
    ...(dataViewError ? { dataViewError } : {}),
    ...(fetchPath ? { fetchPath } : {}),
    id: stringValue(payload.id ?? payload.artifact_id) || "artifact",
    kind,
    mimeType: stringValue(payload.mime_type ?? payload.mimeType),
    preview: safeArtifactText(stringValue(payload.preview)),
    sizeBytes: numberValue(payload.size_bytes ?? payload.sizeBytes),
    status: stringValue(payload.status) || "available",
    title: stringValue(payload.title) || stringValue(payload.id ?? payload.artifact_id) || "Artifact",
    warnings: Array.isArray(payload.warnings)
      ? payload.warnings.map(stringValue).filter(Boolean)
      : undefined,
  };
}

function artifactArray(value: unknown): ArtifactRef[] | undefined {
  return Array.isArray(value) ? value.map(artifactFromPayload) : undefined;
}

function upsertArtifact(artifacts: ArtifactRef[], artifact: ArtifactRef): ArtifactRef[] {
  const index = artifacts.findIndex((item) => item.id === artifact.id);
  if (index === -1) {
    return [...artifacts, artifact];
  }
  return artifacts.map((item, itemIndex) => itemIndex === index ? { ...item, ...artifact } : item);
}

function delegatedTraceFromPayload(value: unknown): DelegatedAgentTraceState | undefined {
  const payload = recordValue(value);
  if (!Object.keys(payload).length) {
    return undefined;
  }
  const delegateId = stringValue(payload.delegate_id ?? payload.delegateId);
  if (!delegateId) {
    return undefined;
  }
  return {
    artifacts: artifactArray(payload.artifacts),
    childTurnId: stringValue(payload.child_turn_id ?? payload.childTurnId),
    delegateId,
    finalMessage: chatMessageFromTrace(payload.final_message ?? payload.finalMessage),
    parentTurnId: stringValue(payload.parent_turn_id ?? payload.parentTurnId),
    parentSessionKey: stringValue(payload.parent_session_key ?? payload.parentSessionKey),
    status: statusValue(payload.status) || "running",
    steps: Array.isArray(payload.steps)
      ? traceStepArray(payload.steps)
      : backgroundTraceStepArray(payload.events),
    updatedAt: stringValue(payload.updated_at ?? payload.updatedAt),
  };
}

export function applyLoadedDelegatedAgentTrace(
  delegate: DelegatedAgentState,
  payload: unknown,
): DelegatedAgentState {
  const root = recordValue(payload);
  const rawTrace = recordValue(root.trace ?? payload);
  const trace = delegatedTraceFromPayload(rawTrace);
  if (!trace) {
    throw new Error(`Delegate trace payload is invalid for ${delegate.id}.`);
  }
  if (trace.delegateId !== delegate.id) {
    throw new Error(`Delegate trace ${trace.delegateId} does not match ${delegate.id}.`);
  }
  return {
    ...delegate,
    finalOutput: stringValue(rawTrace.finalOutput ?? rawTrace.final_output) || delegate.finalOutput,
    status: trace.status,
    trace: mergeDelegatedTrace(delegate.trace, trace),
  };
}

function backgroundTraceStepArray(value: unknown): DelegatedAgentTraceStep[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => {
    const event = recordValue(item);
    const payload = recordValue(event.payload);
    const eventType = stringValue(event.event_type ?? event.eventType) || "trace_event";
    return {
      argsPreview: safeArtifactText(stringValue(payload.argsPreview ?? payload.args_preview)),
      createdAt: stringValue(event.created_at ?? event.createdAt),
      error: safeArtifactText(stringValue(payload.error)),
      id: stringValue(event.event_id ?? event.eventId) || stableId("trace-event", eventType, numberValue(event.sequence)),
      kind: eventType,
      resultPreview: safeArtifactText(stringValue(payload.resultPreview ?? payload.result_preview)),
      status: statusValue(payload.status) || "running",
      summary: safeArtifactText(stringValue(payload.summary ?? payload.content ?? payload.message)),
      title: stringValue(payload.title ?? payload.toolName ?? payload.tool_name) || eventType,
      toolCallId: stringValue(payload.toolCallId ?? payload.tool_call_id),
      toolName: stringValue(payload.toolName ?? payload.tool_name),
      updatedAt: stringValue(event.created_at ?? event.createdAt),
    };
  });
}

function traceStepArray(value: unknown): DelegatedAgentTraceStep[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => {
    const payload = recordValue(item);
    return {
      argsPreview: safeArtifactText(stringValue(payload.args_preview ?? payload.argsPreview)),
      createdAt: stringValue(payload.created_at ?? payload.createdAt),
      error: safeArtifactText(stringValue(payload.error)),
      id: stringValue(payload.id) || stableId("trace-step", stringValue(payload.kind), stringValue(payload.title)),
      kind: stringValue(payload.kind) || "message",
      resultPreview: safeArtifactText(stringValue(payload.result_preview ?? payload.resultPreview)),
      status: statusValue(payload.status) || "running",
      summary: safeArtifactText(stringValue(payload.summary)),
      title: stringValue(payload.title) || stringValue(payload.kind) || "Trace step",
      toolCallId: stringValue(payload.tool_call_id ?? payload.toolCallId),
      toolName: stringValue(payload.tool_name ?? payload.toolName),
      updatedAt: stringValue(payload.updated_at ?? payload.updatedAt),
    };
  });
}

function chatMessageFromTrace(value: unknown): ChatMessage | undefined {
  const payload = recordValue(value);
  const text = stringValue(payload.text ?? payload.content);
  if (!text) {
    return undefined;
  }
  return {
    id: stringValue(payload.id) || "child-final",
    role: "assistant",
    text,
    timestamp: stringValue(payload.timestamp ?? payload.created_at ?? payload.createdAt),
  };
}

function mergeDelegatedTrace(
  current: DelegatedAgentTraceState | undefined,
  next: DelegatedAgentTraceState | undefined,
): DelegatedAgentTraceState | undefined {
  if (!next) {
    return current;
  }
  if (!current) {
    return next;
  }
  const steps = [...current.steps];
  for (const step of next.steps) {
    const index = steps.findIndex((item) => item.id === step.id);
    if (index >= 0) {
      steps[index] = { ...steps[index], ...step };
    } else {
      steps.push(step);
    }
  }
  return {
    ...current,
    ...next,
    artifacts: next.artifacts ?? current.artifacts,
    finalMessage: next.finalMessage ?? current.finalMessage,
    steps,
  };
}

function normalizeUsage(value: unknown): TokenUsage | undefined {
  const payload = recordValue(value);
  if (!Object.keys(payload).length) {
    return undefined;
  }
  const promptTokens = numberValue(payload.prompt_tokens ?? payload.promptTokens);
  const totalTokens = numberValue(payload.total_tokens ?? payload.totalTokens);
  const reportedContextWindowUsedTokens = numberValue(payload.context_window_used_tokens ?? payload.contextWindowUsedTokens);
  const estimatedContextTokens = numberValue(payload.estimated_context_tokens ?? payload.estimatedContextTokens);
  const contextWindowUsedTokens = normalizeContextWindowUsedTokens(
    reportedContextWindowUsedTokens,
    estimatedContextTokens,
    promptTokens,
    totalTokens,
  );
  return {
    cachedTokens: numberValue(payload.cached_tokens ?? payload.cachedTokens),
    completionTokens: numberValue(payload.completion_tokens ?? payload.completionTokens),
    contextWindowRemainingTokens: numberValue(payload.context_window_remaining_tokens ?? payload.contextWindowRemainingTokens),
    contextWindowStrategy: stringValue(payload.context_window_strategy ?? payload.contextWindowStrategy) || undefined,
    contextWindowTokens: numberValue(
      payload.context_window_tokens
        ?? payload.contextWindowTokens
        ?? payload.context_window
        ?? payload.contextWindow
        ?? payload.max_context_tokens
        ?? payload.maxContextTokens,
    ),
    contextWindowUsedTokens,
    estimatedContextTokens,
    percent: numberValue(payload.percent ?? payload.percentage ?? payload.token_usage_percent ?? payload.tokenUsagePercent),
    promptTokens,
    totalTokens,
  };
}

function normalizeContextWindowUsedTokens(
  reported: number | undefined,
  estimated: number | undefined,
  promptTokens: number | undefined,
  totalTokens: number | undefined,
): number | undefined {
  if (reported !== undefined) {
    if (estimated !== undefined && reported <= estimated) {
      return totalTokens ?? promptTokens ?? reported;
    }
    return reported;
  }
  return totalTokens ?? promptTokens;
}

function normalizeReferences(value: unknown): AgentInputReference[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.map((item) => {
    const row = recordValue(item);
    const evidenceId = stringValue(row.evidenceId ?? row.evidence_id);
    const noteId = stringValue(row.noteId ?? row.note_id);
    const rawLine = numberValue(row.rawLine ?? row.raw_line);
    const rawPath = stringValue(row.rawPath ?? row.raw_path);
    const scope = stringValue(row.scope);
    const sourceLine = numberValue(row.sourceLine ?? row.source_line);
    const sourcePath = stringValue(row.sourcePath ?? row.source_path);
    const sourceText = stringValue(row.sourceText ?? row.source_text);
    const type = stringValue(row.type);
    return {
      detail: stringValue(row.detail ?? row.content ?? row.summary ?? row.url),
      ...(evidenceId ? { evidenceId } : {}),
      kind: "reference",
      ...(noteId ? { noteId } : {}),
      ...(rawLine !== undefined ? { rawLine } : {}),
      ...(rawPath ? { rawPath } : {}),
      ...(scope ? { scope } : {}),
      ...(sourceLine !== undefined ? { sourceLine } : {}),
      ...(sourcePath ? { sourcePath } : {}),
      ...(sourceText ? { sourceText } : {}),
      title: stringValue(row.title ?? row.name ?? row.id) || "Reference",
      ...(type ? { type } : {}),
    };
  });
}

function mainContext(): AgentContext {
  return { id: "main", title: "Tinybot", type: "main" };
}

function statusValue(value: unknown): ChatStepStatus | "" {
  const normalized = stringValue(value).toLowerCase().replace(/[\s-]+/g, "_");
  if (["pending", "running", "blocked", "completed", "failed", "cancelled"].includes(normalized)) {
    return normalized as ChatStepStatus;
  }
  if (["waiting", "awaiting_user"].includes(normalized)) {
    return "blocked";
  }
  if (["complete", "success", "succeeded", "done"].includes(normalized)) {
    return "completed";
  }
  if (["error", "errored", "failure"].includes(normalized)) {
    return "failed";
  }
  if (["canceled", "interrupted", "stopped"].includes(normalized)) {
    return "cancelled";
  }
  return "";
}

function stableId(...parts: Array<string | number | undefined>): string {
  return parts
    .filter((part) => part !== undefined && String(part).length > 0)
    .map((part) => String(part).replace(/\s+/g, "-"))
    .join(":");
}

function omitUnsafe(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(omitUnsafe);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    UNSAFE_KEYS.has(key) ? "[unsafe omitted]" : omitUnsafe(item),
  ]));
}

function safeArtifactText(value: string): string {
  return sanitizeTextPreview(value);
}

function serialize(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}
