import type { NativeChatMessage, NativeChatReference } from "./nativeChat";

export type ChatTurnStatus = "pending" | "running" | "awaiting_approval" | "awaiting_user" | "completed" | "failed" | "interrupted";
export type ChatStepStatus = "pending" | "running" | "blocked" | "completed" | "failed" | "cancelled";
export type AssistantMessagePhase = "unknown" | "commentary" | "final_answer";
export type AgentContextType = "main" | "spawn" | "subagent" | "cowork" | "team";
export type ArtifactKind =
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
  fetchPath?: string;
  id: string;
  kind: ArtifactKind | string;
  mimeType?: string;
  preview?: string;
  sizeBytes?: number;
  status?: string;
  title: string;
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
  approvalId?: string;
  approvalStatus?: string;
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

export interface ChatReferenceProjection {
  detail: string;
  evidenceId?: string;
  kind: string;
  noteId?: string;
  rawLine?: number;
  rawPath?: string;
  scope?: string;
  sourceLine?: number;
  sourceEndLine?: number;
  sourcePath?: string;
  sourceText?: string;
  title: string;
  type?: string;
  revision?: string;
}

export interface ChatToolActivityProjection {
  approvalId?: string;
  argsText: string;
  approvalStatus: string;
  childRunId?: string;
  delegatedTrace?: Record<string, unknown>;
  delegateId?: string;
  delegateTask?: string;
  delegateTitle?: string;
  delegateType?: string;
  finalOutput?: string;
  id: string;
  kind: "call" | "result";
  name: string;
  parentRunId?: string;
  parentTurnId?: string;
  responseText: string;
  runChainItemKey?: string;
  selected?: boolean;
  sessionKey?: string;
  status?: string;
  traceRef?: string;
}

export interface ChatMessageProjection {
  attachment?: string;
  author: string;
  body: string[];
  copyable?: boolean;
  messageId?: string;
  references: ChatReferenceProjection[];
  reasoningContent?: string;
  reasoningLabel?: string;
  time: string;
  tone: "assistant" | "user";
  toolActivities?: ChatToolActivityProjection[];
  turnId?: string;
  turnStatus?: ChatTurnStatus;
  usage?: TokenUsage;
}

export type DelegatedAgentState = {
  agentCount?: number;
  approvalId?: string;
  approvalPolicy?: string;
  approvalStatus?: string;
  artifacts?: ArtifactRef[];
  childRunId?: string;
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
  approvalId?: string;
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
  approvals?: unknown[];
  artifacts?: ArtifactRef[];
  childRunId?: string;
  delegateId: string;
  finalMessage?: ChatMessage;
  parentRunId?: string;
  parentSessionKey?: string;
  status: ChatStepStatus;
  steps: DelegatedAgentTraceStep[];
  updatedAt?: string;
};

export type ApprovalState = {
  actions?: string[];
  approvalId: string;
  decision?: string;
  riskLevel?: string;
  title?: string;
  toolCallId?: string;
};

export type LoadedArtifactDetail = {
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
  const imageDataUrl = safeRasterImageDataUrl(content);
  return {
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
  droppedItemCount: number;
  estimatedTokensAfter?: number;
  estimatedTokensBefore?: number;
};

export type ScopedErrorState = {
  cancelled: boolean;
  code: string;
  message: string;
};

export type ChatMessage = {
  clientEventId?: string;
  id: string;
  references?: NativeChatReference[];
  role: "user" | "assistant";
  text: string;
  timestamp: string;
};

export type ChatStepKind =
  | "reasoning"
  | "message"
  | "tool_call"
  | "tool_result"
  | "approval"
  | "delegate"
  | "artifact"
  | "browser"
  | "form"
  | "plan"
  | "compaction"
  | "memory"
  | "error";

export type ChatStep = {
  agentContext: AgentContext;
  approval?: ApprovalState;
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
  references?: NativeChatReference[];
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

export type ChatInspectorSelection =
  | { kind: "tool_call"; sessionKey: string; turnId: string; stepId: string; toolCallId: string }
  | { kind: "delegate"; sessionKey: string; turnId: string; stepId: string; delegateId: string }
  | { kind: "approval"; sessionKey: string; turnId: string; stepId: string; approvalId: string }
  | { kind: "artifact"; sessionKey: string; artifactId: string }
  | { kind: "reference"; sessionKey: string; referenceId: string }
  | { kind: "error"; sessionKey: string; turnId: string; stepId: string };

export type ChatRunState = {
  appliedEventIds: Set<string>;
  artifactsBySession: Map<string, Map<string, ArtifactRef>>;
  delegatedRunsBySession: Map<string, Map<string, DelegatedAgentState>>;
  legacyMessagesBySession: Map<string, NativeChatMessage[]>;
  selectedInspector: ChatInspectorSelection | null;
  turnsBySession: Map<string, ChatTurn[]>;
};

export type AgentEventEnvelope = {
  chat_id: string;
  created_at: string;
  event_id: string;
  event_type: string;
  parent_step_id?: string;
  payload: Record<string, unknown>;
  schema_version: "tinybot.agent_event.v1";
  sequence: number;
  session_key: string;
  step_id?: string;
  turn_id: string;
};

export type CanonicalTurnItemKind =
  | "user_message"
  | "assistant_message"
  | "reasoning"
  | "tool_call"
  | "approval"
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
  | { type: "approval"; approvalId: string; toolCallId?: string | null; status: string; reason?: string | null; decision?: string | null; scope?: string | null; guidance?: string | null; detailId?: string | null }
  | { type: "form"; formId: string; status: string; title?: string | null; action?: string | null; fieldIds: string[]; values: unknown; errors?: Record<string, string> | null; detailId?: string | null }
  | { type: "subagent_lifecycle"; agentId: string; action: string; status: string; message?: string | null; childRunId?: string | null; childThreadId?: string | null; parentAgentId?: string | null; parentRunId?: string | null; name?: string | null; task?: string | null; traceRef?: string | null }
  | { type: "subagent_message"; agentId: string; messageId: string; content: string; visibility: string }
  | { type: "plan_progress"; id: string; explanation?: string | null; steps: Array<{ step: string; status: "pending" | "in_progress" | "completed" }>; summary: string; completed: number; total: number; currentStep?: string | null }
  | { type: "context_compaction"; id: string; summary: string; droppedItemCount: number; estimatedTokensBefore?: number | null; estimatedTokensAfter?: number | null }
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
  runId: string;
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
  runId: string;
  snapshotRevision: number;
  items: BackendAgentTurnItem[];
};

export type BackendAgentRunRuntimeState = {
  runtimeEvents?: unknown[];
  timeline: BackendAgentTimelineSnapshot;
};

export type BackendAgentTimelinePatch = {
  schemaVersion: "tinybot.timeline_patch.v2";
  sessionId: string;
  runId: string;
  snapshotRevision: number;
  item: BackendAgentTurnItem;
};

export type ChatInspectorPanel = {
  body: string;
  kind: ChatInspectorSelection["kind"];
  status?: string;
  subtitle?: string;
  title: string;
};

export type ChatInspectorRegistry = Record<ChatInspectorSelection["kind"], (state: ChatRunState, selection: ChatInspectorSelection) => ChatInspectorPanel>;

const SENSITIVE_KEYS = new Set(["api_key", "token", "secret", "password", "authorization", "cookie", "credential", "private_key"]);
const UNSAFE_KEYS = new Set(["html", "script", "style", "component", "handler", "renderer", "template", "onClick", "onSubmit"]);

export function createChatRunState(): ChatRunState {
  return {
    appliedEventIds: new Set(),
    artifactsBySession: new Map(),
    delegatedRunsBySession: new Map(),
    legacyMessagesBySession: new Map(),
    selectedInspector: null,
    turnsBySession: new Map(),
  };
}

export function createChatInspectorRegistry(): ChatInspectorRegistry {
  return {
    approval: resolveApprovalInspectorPanel,
    artifact: resolveArtifactInspectorPanel,
    delegate: resolveDelegateInspectorPanel,
    error: resolveErrorInspectorPanel,
    reference: resolveReferenceInspectorPanel,
    tool_call: resolveToolCallInspectorPanel,
  };
}

export function selectChatInspector(state: ChatRunState, selection: ChatInspectorSelection | null): ChatRunState {
  state.selectedInspector = selection;
  return state;
}

export function resolveChatInspectorPanel(state: ChatRunState, selection = state.selectedInspector): ChatInspectorPanel | null {
  if (!selection) {
    return null;
  }
  return createChatInspectorRegistry()[selection.kind](state, selection);
}

export function getArtifactRef(state: ChatRunState, sessionKey: string, artifactId: string): ArtifactRef | null {
  return state.artifactsBySession.get(sessionKey)?.get(artifactId) ?? null;
}

export function legacyMessagesToTurns(sessionKey: string, messages: NativeChatMessage[]): ChatTurn[] {
  const turns: ChatTurn[] = [];
  let current: ChatTurn | null = null;
  let sequence = 0;
  for (const message of messages) {
    if (message.role === "user") {
      current = {
        id: stableId("turn", sessionKey, message.messageId || String(turns.length + 1)),
        sessionKey,
        userMessageId: message.messageId || stableId("user", sessionKey, String(turns.length + 1)),
        userMessage: {
          id: message.messageId || stableId("user", sessionKey, String(turns.length + 1)),
          role: "user",
          text: message.content,
          timestamp: message.timestamp,
        },
        status: "running",
        steps: [],
        startedAt: message.timestamp,
        updatedAt: message.timestamp,
      };
      turns.push(current);
      sequence = 0;
      continue;
    }

    if (!current) {
      current = syntheticTurn(sessionKey, turns.length + 1, message.timestamp);
      turns.push(current);
      sequence = 0;
    }

    const isFinal = Boolean(message.content.trim());
    const processSteps = stepsFromLegacyMessage(message, current, sequence);
    sequence += processSteps.length;
    current.steps.push(...processSteps);
    current.updatedAt = message.timestamp || current.updatedAt;
    if (isFinal) {
      current.finalMessage = {
        id: message.messageId || stableId("message", current.id, "final"),
        references: message.references,
        role: "assistant",
        text: message.content,
        timestamp: message.timestamp,
      };
      current.status = "completed";
      current.completedAt = message.timestamp;
      for (const step of current.steps) {
        if (step.status === "pending") {
          step.status = "completed";
        }
      }
    }
  }
  return turns;
}

export function normalizeAgentRunRuntimeStatePayload(payload: unknown): BackendAgentRunRuntimeState {
  const value = recordValue(payload);
  const timeline = normalizeAgentTimelineSnapshotPayload(value.timeline);
  return {
    runtimeEvents: Array.isArray(value.runtimeEvents) ? value.runtimeEvents : Array.isArray(value.runtime_events) ? value.runtime_events : [],
    timeline,
  };
}

export function normalizeAgentTimelineSnapshotPayload(payload: unknown): BackendAgentTimelineSnapshot {
  const timeline = recordValue(payload);
  if (stringValue(timeline.schemaVersion) !== "tinybot.timeline.v2") {
    throw new Error(`Unsupported canonical timeline schema: ${stringValue(timeline.schemaVersion) || "missing"}`);
  }
  const sessionId = requiredCanonicalString(timeline, "sessionId");
  const runId = requiredCanonicalString(timeline, "runId");
  const snapshotRevision = requiredCanonicalNumber(timeline, "snapshotRevision");
  if (!Array.isArray(timeline.items)) {
    throw new Error(`Canonical timeline ${runId} is missing items`);
  }
  const seenItemIds = new Set<string>();
  let previousSequence = -1;
  const items = timeline.items.map((raw, index) => {
    if (!isRecord(raw)) {
      throw new Error(`Canonical timeline ${runId} item ${index} is not an object`);
    }
    const item = normalizeCanonicalTurnItem(raw, sessionId, runId);
    if (seenItemIds.has(item.itemId)) {
      throw new Error(`Canonical timeline ${runId} contains duplicate item ${item.itemId}`);
    }
    if (item.sequence < previousSequence) {
      throw new Error(`Canonical timeline ${runId} item ${item.itemId} has non-monotonic sequence ${item.sequence}`);
    }
    seenItemIds.add(item.itemId);
    previousSequence = item.sequence;
    return item;
  });
  validateCanonicalFinalAnswerBoundary(items, runId);
  return {
    schemaVersion: "tinybot.timeline.v2",
    sessionId,
    runId,
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
  const runId = requiredCanonicalString(value, "runId");
  if (!isRecord(value.item)) {
    throw new Error(`Canonical timeline patch ${sessionId}/${runId} is missing item`);
  }
  return {
    schemaVersion: "tinybot.timeline_patch.v2",
    sessionId,
    runId,
    snapshotRevision: requiredCanonicalNumber(value, "snapshotRevision"),
    item: normalizeCanonicalTurnItem(value.item, sessionId, runId),
  };
}

const CANONICAL_ITEM_KINDS = new Set<CanonicalTurnItemKind>([
  "user_message", "assistant_message", "reasoning", "tool_call", "approval", "form",
  "subagent_lifecycle", "subagent_message", "plan_progress", "context_compaction", "usage",
  "file_reference", "error", "system_notice",
]);

function normalizeCanonicalTurnItem(
  raw: Record<string, unknown>,
  sessionId: string,
  runId: string,
): BackendAgentTurnItem {
  if (stringValue(raw.schemaVersion) !== "tinybot.turn_item.v2") {
    throw new Error(`Unsupported canonical item schema for ${stringValue(raw.itemId) || "unknown item"}`);
  }
  const itemId = requiredCanonicalString(raw, "itemId");
  const itemSessionId = requiredCanonicalString(raw, "sessionId");
  const itemRunId = requiredCanonicalString(raw, "runId");
  if (itemSessionId !== sessionId || itemRunId !== runId) {
    throw new Error(`Canonical item ${itemId} identity does not match timeline ${sessionId}/${runId}`);
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
    runId: itemRunId,
    turnId: requiredCanonicalString(raw, "turnId"),
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

function validateCanonicalFinalAnswerBoundary(items: BackendAgentTurnItem[], runId: string): void {
  const finalItem = items.find((item) => (
    item.kind === "assistant_message" && stringValue(item.data.phase) === "final_answer"
  ));
  if (!finalItem) {
    return;
  }
  const invalid = items.find((item) => item.sequence > finalItem.sequence && (
    item.kind === "assistant_message"
      || item.kind === "reasoning"
      || item.kind === "tool_call"
      || item.kind === "approval"
      || item.kind === "form"
      || item.kind === "subagent_lifecycle"
      || item.kind === "subagent_message"
      || item.kind === "plan_progress"
      || item.kind === "context_compaction"
  ));
  if (invalid) {
    throw new Error(`Canonical timeline ${runId} item ${invalid.itemId} appears after final answer ${finalItem.itemId}`);
  }
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
  runtimeStates: BackendAgentRunRuntimeState[],
): ChatTurn[] {
  const statesWithItems = runtimeStates
    .filter((state) => state.timeline.sessionId === sessionKey && state.timeline.items.length > 0)
    .sort(compareRuntimeStatesByStart);
  return statesWithItems.map((runtimeState) => runtimeStateToTurn(sessionKey, runtimeState));
}

export function applyBackendRuntimeStates(
  state: ChatRunState,
  sessionKey: string,
  runtimeStates: BackendAgentRunRuntimeState[],
): boolean {
  const turns = backendRuntimeStatesToTurns(sessionKey, runtimeStates);
  state.turnsBySession.set(sessionKey, turns);
  return runtimeStates.some((runtimeState) => runtimeState.timeline.items.length > 0);
}

export function reduceAgentEvent(state: ChatRunState, event: AgentEventEnvelope): ChatRunState {
  if (state.appliedEventIds.has(event.event_id)) {
    return state;
  }
  state.appliedEventIds.add(event.event_id);
  const turn = ensureTurn(state, event);
  turn.updatedAt = event.created_at || turn.updatedAt;

  if (event.event_type === "agent.turn.started") {
    const payloadMessage = recordValue(event.payload.user_message);
    turn.userMessage = {
      id: stringValue(event.payload.user_message_id) || stringValue(payloadMessage.id) || turn.userMessage.id,
      references: normalizeReferences(payloadMessage.references ?? payloadMessage.contextReferences ?? payloadMessage.context_references),
      role: "user",
      text: stringValue(payloadMessage.text ?? payloadMessage.content) || turn.userMessage.text,
      timestamp: event.created_at,
    };
    turn.userMessageId = turn.userMessage.id;
    turn.status = "running";
    return state;
  }

  if (event.event_type === "agent.turn.completed") {
    turn.status = "completed";
    turn.completedAt = event.created_at;
    turn.usage = normalizeUsage(event.payload.usage) ?? turn.usage;
    return state;
  }

  if (event.event_type === "agent.turn.updated") {
    turn.status = turnStatusValue(event.payload.status) || turn.status;
    turn.usage = normalizeUsage(event.payload.usage) ?? turn.usage;
    return state;
  }

  if (event.event_type === "agent.usage") {
    turn.usage = normalizeUsage(event.payload.usage ?? event.payload) ?? turn.usage;
    return state;
  }

  if (event.event_type === "agent.turn.failed") {
    turn.status = "failed";
    upsertStep(turn, event, {
      error: event.payload.error,
      kind: "error",
      status: "failed",
      title: "Error",
    });
    return state;
  }

  if (event.event_type === "agent.turn.interrupted") {
    turn.status = "interrupted";
    return state;
  }

  if (event.event_type === "reasoning.started" || event.event_type === "reasoning.delta" || event.event_type === "reasoning.completed") {
    const visibility = stringValue(event.payload.visibility) || "hidden";
    const text = visibility === "hidden"
      ? stringValue(event.payload.summary ?? event.payload.text)
      : stringValue(event.payload.text ?? event.payload.summary);
    const messageId = stringValue(event.payload.message_id) || stringValue(event.payload.messageId);
    const stepId = reasoningStepId(turn.id, messageId);
    const existingStep = turn.steps.find((step) => step.id === stepId && step.kind === "reasoning");
    const summary = event.event_type === "reasoning.delta" && existingStep
      ? `${existingStep.summary ?? ""}${text}`
      : text || existingStep?.summary || "";
    upsertStep(turn, event, {
      kind: "reasoning",
      messageId,
      status: event.event_type === "reasoning.completed" ? "completed" : "running",
      summary,
      title: event.event_type === "reasoning.completed" ? "Thinking complete" : "Thinking",
    }, stepId);
    return state;
  }

  if (event.event_type === "message.delta" || event.event_type === "message.completed") {
    if (turn.status === "pending") {
      turn.status = "running";
    }
    const text = stringValue(event.payload.text);
    const messageId = stringValue(event.payload.message_id) || stableId("message", turn.id, event.sequence);
    const stepId = messageStepId(turn.id, messageId);
    const existingStep = turn.steps.find((step) => step.id === stepId && step.kind === "message");
    const summary = event.event_type === "message.delta" && existingStep
      ? `${existingStep.summary ?? ""}${text}`
      : text;
    if (event.event_type === "message.completed") {
      turn.finalMessage = {
        id: messageId,
        references: normalizeReferences(event.payload.references),
        role: "assistant",
        text,
        timestamp: event.created_at,
      };
    }
    upsertStep(turn, event, {
      kind: "message",
      messageId,
      status: event.event_type === "message.completed" ? "completed" : "running",
      summary,
      title: event.event_type === "message.completed" ? "Final answer" : "Assistant message",
    }, stepId);
    return state;
  }

  if (event.event_type === "tool.call.started" || event.event_type === "tool.call.arguments.delta") {
    const toolCall = toolCallFromPayload(event.payload);
    upsertStep(turn, event, {
      kind: "tool_call",
      status: statusValue(event.payload.status) || "running",
      title: toolCall.name,
      toolCall,
    });
    return state;
  }

  if (event.event_type === "tool.call.completed" || event.event_type === "tool.call.failed") {
    const toolCall = toolCallFromPayload(event.payload);
    upsertStep(turn, event, {
      kind: "tool_call",
      status: event.event_type === "tool.call.failed" ? "failed" : statusValue(event.payload.status) || "completed",
      title: toolCall.name,
      toolCall,
    });
    return state;
  }

  if (event.event_type === "approval.requested" || event.event_type === "approval.resolved") {
    const approval = approvalFromPayload(event.payload);
    if (event.event_type === "approval.requested" && approval.toolCallId) {
      const existingToolStep = turn.steps.find((step) => step.toolCall?.id === approval.toolCallId);
      const existingToolCall = existingToolStep?.toolCall;
      if (existingToolStep) {
        const toolCall: ToolCallState = {
          ...existingToolCall,
          id: existingToolCall?.id ?? approval.toolCallId,
          name: existingToolCall?.name ?? (stringValue(event.payload.name) || "tool"),
          approvalId: approval.approvalId,
          approvalStatus: stringValue(event.payload.approval_status) || "approval_required",
          argsPreview: existingToolCall?.argsPreview || safeArtifactText(stringValue(event.payload.args_preview)),
        };
        Object.assign(existingToolStep, {
          completedAt: existingToolStep.completedAt,
          status: "blocked",
          title: existingToolStep.title || toolCall.name,
          toolCall,
          updatedAt: event.created_at,
        });
        return state;
      }
    }
    upsertStep(turn, event, {
      approval,
      kind: "approval",
      status: event.event_type === "approval.resolved" ? "completed" : "blocked",
      title: stringValue(event.payload.title) || "Approval",
    });
    return state;
  }

  if (event.event_type === "agent.form.requested" || event.event_type === "ui.form.requested") {
    upsertStep(turn, event, {
      kind: "form",
      status: "blocked",
      summary: stringValue(event.payload.title) || stringValue(recordValue(event.payload.form).title),
      title: stringValue(event.payload.title) || stringValue(recordValue(event.payload.form).title) || "Form requested",
    });
    return state;
  }

  if (isDelegatedRunEventType(event.event_type)) {
    const delegate = delegateFromPayload(event.payload);
    storeDelegatedRun(state, event.session_key, delegate);
    for (const artifact of delegate.artifacts ?? []) {
      storeArtifact(state, event.session_key, artifact);
    }
    const parentToolStep = delegate.parentToolCallId
      ? turn.steps.find((step) => step.kind === "tool_call" && step.toolCall?.id === delegate.parentToolCallId)
      : undefined;
    if (parentToolStep) {
      parentToolStep.kind = "delegate";
      parentToolStep.delegate = delegate;
      parentToolStep.toolCall = undefined;
      parentToolStep.status = delegate.status;
      parentToolStep.title = delegate.title;
      parentToolStep.completedAt = delegate.status === "completed" || delegate.status === "failed" || delegate.status === "cancelled"
        ? event.created_at
        : parentToolStep.completedAt;
      return state;
    }
    upsertStep(turn, event, {
      delegate,
      kind: "delegate",
      status: delegate.status,
      title: delegate.title,
    });
    return state;
  }

  if (event.event_type === "artifact.created" || event.event_type === "artifact.updated") {
    const artifact = artifactFromPayload(event.payload.artifact ?? event.payload);
    storeArtifact(state, event.session_key, artifact);
    const targetStep = event.step_id ? turn.steps.find((step) => step.id === event.step_id) : undefined;
    if (targetStep) {
      targetStep.artifacts = upsertArtifact(targetStep.artifacts ?? [], artifact);
    } else {
      upsertStep(turn, event, {
        artifacts: [artifact],
        kind: "artifact",
        status: "completed",
        title: artifact.title,
      });
    }
    return state;
  }

  return state;
}

function compareRuntimeStatesByStart(left: BackendAgentRunRuntimeState, right: BackendAgentRunRuntimeState): number {
  return compareRuntimeTimestamps(runtimeStateStart(left), runtimeStateStart(right))
    || left.timeline.runId.localeCompare(right.timeline.runId);
}

function runtimeStateStart(state: BackendAgentRunRuntimeState): string {
  return state.timeline.items
    .map((item) => item.createdAt)
    .filter(Boolean)
    .sort(compareRuntimeTimestamps)[0] || "";
}

function runtimeStateToTurn(
  sessionKey: string,
  runtimeState: BackendAgentRunRuntimeState,
): ChatTurn {
  const startedAt = runtimeStateStart(runtimeState) || new Date().toISOString();
  const updatedAt = runtimeState.timeline.items
    .map((item) => item.updatedAt || item.createdAt)
    .filter(Boolean)
    .sort(compareRuntimeTimestamps);
  const lastUpdatedAt = updatedAt[updatedAt.length - 1] || startedAt;
  const turn: ChatTurn = {
    canonicalItems: [...runtimeState.timeline.items],
    id: runtimeState.timeline.runId,
    sessionKey,
    userMessage: {
      id: stableId("user", runtimeState.timeline.runId),
      role: "user",
      text: "",
      timestamp: startedAt,
    },
    userMessageId: stableId("user", runtimeState.timeline.runId),
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
  turn.status = statusForTurnItems(runtimeState.timeline.items, turn.status);
  reconcileTerminalStepStatuses(turn);
  if (turn.status === "completed" || turn.status === "failed" || turn.status === "interrupted") {
    turn.completedAt = turn.completedAt ?? lastUpdatedAt;
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
    turn.steps.push(runtimeStep(item, sequence, {
      kind: "tool_call",
      status,
      title: item.title || toolCall.name,
      toolCall,
    }));
    return;
  }
  if (item.kind === "approval") {
    turn.steps.push(runtimeStep(item, sequence, {
      approval: approvalFromRuntimeItem(item),
      kind: "approval",
      status: status === "completed" ? "completed" : "blocked",
      summary: safeArtifactText(stringValue(payload.summary ?? payload.reason ?? item.summary)),
      title: item.title || "Approval",
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
        droppedItemCount: numberValue(payload.droppedItemCount) ?? 0,
        ...(numberValue(payload.estimatedTokensBefore) !== undefined
          ? { estimatedTokensBefore: numberValue(payload.estimatedTokensBefore) }
          : {}),
        ...(numberValue(payload.estimatedTokensAfter) !== undefined
          ? { estimatedTokensAfter: numberValue(payload.estimatedTokensAfter) }
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
    turn.usage = {
      promptTokens: numberValue(payload.inputTokens),
      completionTokens: numberValue(payload.outputTokens),
      totalTokens: numberValue(payload.totalTokens),
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
  turn.steps.sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));
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
    ...(patch.approval ? { approval: patch.approval } : {}),
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
    approvalId: stringValue(payload.approvalId ?? payload.approval_id),
    approvalStatus: stringValue(payload.approvalStatus ?? payload.approval_status),
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

function approvalFromRuntimeItem(item: BackendAgentTurnItem): ApprovalState {
  const payload = item.data;
  return {
    actions: Array.isArray(payload.actions) ? payload.actions.map(String) : undefined,
    approvalId: stringValue(payload.approvalId) || item.itemId,
    decision: stringValue(payload.decision),
    riskLevel: stringValue(payload.riskLevel ?? payload.risk_level),
    title: item.title || stringValue(payload.title),
    toolCallId: stringValue(payload.toolCallId),
  };
}

function delegateFromRuntimeItem(item: BackendAgentTurnItem): DelegatedAgentState {
  const payload = item.data;
  const status = itemStatusToStepStatus(item.status);
  return {
    childRunId: stringValue(payload.childRunId ?? payload.child_run_id),
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
  if (items.some((item) => item.kind === "approval" && item.status === "waiting")) {
    return "awaiting_approval";
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

function isDelegatedRunEventType(eventType: string): boolean {
  return eventType === "agent.delegate.started"
    || eventType === "agent.delegate.running"
    || eventType === "agent.delegate.message_queued"
    || eventType === "agent.delegate.awaiting_approval"
    || eventType === "agent.delegate.tool.approval_required"
    || eventType === "agent.delegate.tool.completed"
    || eventType === "agent.delegate.trace.updated"
    || eventType === "agent.delegate.updated"
    || eventType === "agent.delegate.completed"
    || eventType === "agent.delegate.failed"
    || eventType === "agent.delegate.interrupted"
    || eventType === "agent.delegate.closed";
}

export function turnsToConversationMessages(turns: ChatTurn[]): ChatMessageProjection[] {
  return turns.flatMap((turn) => {
    const finalAnswer = turn.finalAnswer ?? turn.finalMessage;
    const executionItems = turn.executionItems ?? turn.steps;
    const messages: ChatMessageProjection[] = [{
      author: "You",
      body: [turn.userMessage.text],
      messageId: turn.userMessage.id,
      references: conversationReferences(turn.userMessage.references),
      time: turn.userMessage.timestamp,
      tone: "user",
      toolActivities: [],
      turnId: turn.id,
      turnStatus: turn.status,
    }];
    for (const step of executionItems) {
      if (!turn.finalAnswer && turn.finalMessage && step.kind === "message") {
        continue;
      }
      messages.push(stepToConversationMessage(step, turn));
    }
    if (finalAnswer) {
      messages.push({
        author: "Tinybot",
        body: [finalAnswer.text],
        copyable: true,
        messageId: finalAnswer.id,
        references: conversationReferences(finalAnswer.references),
        reasoningContent: "",
        time: finalAnswer.timestamp,
        tone: "assistant",
        toolActivities: [],
        turnId: turn.id,
        turnStatus: turn.status,
        ...(turn.usage ? { usage: turn.usage } : {}),
      });
    }
    return messages;
  });
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

function stepToConversationMessage(step: ChatStep, turn: ChatTurn): ChatMessageProjection {
  return {
    author: "Tinybot",
    body: step.kind === "message" && step.summary ? [step.summary] : [],
    copyable: step.kind === "message" ? false : undefined,
    messageId: step.messageId,
    references: conversationReferences(step.references),
    reasoningContent: step.kind === "reasoning" ? step.summary : "",
    reasoningLabel: step.title,
    time: step.startedAt || step.completedAt || "",
    tone: "assistant",
    toolActivities: stepToToolActivities(step),
    turnId: turn.id,
    turnStatus: turn.status,
    ...(turn.usage ? { usage: turn.usage } : {}),
  };
}

function stepToToolActivities(step: ChatStep): ChatMessageProjection["toolActivities"] {
  if (step.toolCall) {
    return [{
      approvalId: step.toolCall.approvalId,
      approvalStatus: step.toolCall.approvalStatus ?? "",
      argsText: step.toolCall.argsPreview ?? serialize(step.toolCall.argsJson ?? ""),
      id: step.toolCall.id,
      kind: step.status === "completed" || step.status === "failed" ? "result" : "call",
      name: step.toolCall.name,
      responseText: step.toolCall.resultPreview ?? serialize(step.toolCall.resultJson ?? ""),
      status: step.status,
    }];
  }
  if (step.delegate) {
    return [{
      approvalId: step.delegate.approvalId,
      approvalStatus: step.delegate.approvalStatus ?? "",
      argsText: delegatedActivityArgsText(step.delegate),
      childRunId: step.delegate.childRunId,
      delegatedTrace: step.delegate.trace as Record<string, unknown> | undefined,
      delegateId: step.delegate.id,
      delegateTask: step.delegate.task,
      delegateTitle: step.delegate.title,
      delegateType: step.delegate.type,
      finalOutput: step.delegate.finalOutput,
      id: step.delegate.parentToolCallId || step.delegate.id,
      kind: step.status === "completed" || step.status === "failed" ? "result" : "call",
      name: step.delegate.toolName || step.delegate.type || "delegate",
      parentRunId: step.delegate.trace?.parentRunId,
      responseText: step.delegate.latestActivity ?? step.delegate.finalOutput ?? "",
      status: step.status,
      traceRef: step.delegate.traceRef,
    }];
  }
  if (step.artifacts?.length) {
    return step.artifacts.map((artifact) => ({
      argsText: "",
      id: artifact.id,
      kind: "result" as const,
      name: `Artifact: ${artifact.title}`,
      responseText: safeArtifactText(artifact.preview ?? ""),
      approvalStatus: "",
      status: artifact.status ?? "completed",
    }));
  }
  return [];
}

function stepsFromLegacyMessage(message: NativeChatMessage, turn: ChatTurn, startSequence: number): ChatStep[] {
  const steps: ChatStep[] = [];
  let sequence = startSequence;
  const baseTime = message.timestamp || turn.updatedAt;
  const isFinal = Boolean(message.content.trim());
  if (message.reasoningContent?.trim()) {
    steps.push({
      agentContext: mainContext(),
      id: stableId("step", turn.id, message.messageId || sequence, "reasoning"),
      kind: "reasoning",
      sequence: ++sequence,
      startedAt: baseTime,
      status: "completed",
      summary: isFinal ? message.reasoningContent : message.reasoningContent,
      title: isFinal ? "Thinking complete" : "Thinking",
    });
  }
  for (const activity of message.toolActivities ?? []) {
    steps.push({
      agentContext: mainContext(),
      id: stableId("step", turn.id, activity.id),
      kind: "tool_call",
      sequence: ++sequence,
      startedAt: baseTime,
      status: statusValue(activity.status) || (activity.kind === "result" ? "completed" : "running"),
      title: activity.name || "tool",
      toolCall: {
        approvalId: activity.approvalId,
        approvalStatus: activity.approvalStatus,
        argsPreview: activity.argsText,
        id: activity.id,
        name: activity.name || "tool",
        resultPreview: activity.responseText,
      },
    });
  }
  return steps;
}

function delegatedActivityArgsText(delegate: DelegatedAgentState): string {
  const payload = {
    agent_kind: delegate.type,
    approval_id: delegate.approvalId,
    approval_status: delegate.approvalStatus,
    child_run_id: delegate.childRunId,
    child_tool_call_id: delegate.childToolCallId,
    operation_preview: delegate.operationPreview,
    permission_profile: delegate.permissionProfile,
    status: delegate.status,
    task: delegate.task,
    trace_ref: delegate.traceRef,
    workflow: delegate.workflow,
  };
  try {
    return JSON.stringify(Object.fromEntries(Object.entries(payload).filter(([, value]) => Boolean(value))));
  } catch {
    return delegate.task ?? "";
  }
}

function ensureTurn(state: ChatRunState, event: AgentEventEnvelope): ChatTurn {
  const turns = state.turnsBySession.get(event.session_key) ?? [];
  state.turnsBySession.set(event.session_key, turns);
  let turn = turns.find((item) => item.id === event.turn_id);
  if (!turn) {
    turn = {
      id: event.turn_id,
      sessionKey: event.session_key,
      userMessage: {
        id: stringValue(event.payload.user_message_id) || stableId("user", event.turn_id),
        role: "user",
        text: "",
        timestamp: event.created_at,
      },
      userMessageId: stringValue(event.payload.user_message_id) || stableId("user", event.turn_id),
      status: "pending",
      steps: [],
      startedAt: event.created_at,
      updatedAt: event.created_at,
    };
    turns.push(turn);
  }
  return turn;
}

function upsertStep(
  turn: ChatTurn,
  event: AgentEventEnvelope,
  patch: Partial<ChatStep> & Pick<ChatStep, "kind" | "status" | "title">,
  stepIdOverride?: string,
): ChatStep {
  const stepId = stepIdOverride || event.step_id || stableId("step", event.turn_id, event.sequence);
  let step = turn.steps.find((item) => item.id === stepId);
  if (!step) {
    step = {
      agentContext: agentContextFromPayload(event.payload.agent_context),
      id: stepId,
      kind: patch.kind,
      parentStepId: event.parent_step_id,
      sequence: event.sequence,
      startedAt: event.created_at,
      status: patch.status,
      title: patch.title,
    };
    turn.steps.push(step);
    turn.steps.sort((a, b) => a.sequence - b.sequence);
  }
  Object.assign(step, patch, {
    agentContext: patch.agentContext ?? step.agentContext,
    completedAt: patch.status === "completed" || patch.status === "failed" || patch.status === "cancelled" ? event.created_at : step.completedAt,
    startedAt: step.startedAt || event.created_at,
  });
  return step;
}

function messageStepId(turnId: string, messageId: string): string {
  return stableId("step", turnId, "message", messageId);
}

function reasoningStepId(turnId: string, messageId: string): string {
  return stableId("step", turnId, "reasoning", messageId || "default");
}

function syntheticTurn(sessionKey: string, index: number, timestamp: string): ChatTurn {
  const userId = stableId("synthetic-user", sessionKey, index);
  return {
    id: stableId("turn", sessionKey, `synthetic-${index}`),
    sessionKey,
    userMessage: { id: userId, role: "user", text: "", timestamp },
    userMessageId: userId,
    status: "running",
    steps: [],
    startedAt: timestamp,
    updatedAt: timestamp,
  };
}

function toolCallFromPayload(payload: Record<string, unknown>): ToolCallState {
  return {
    approvalId: stringValue(payload.approval_id),
    approvalStatus: stringValue(payload.approval_status),
    argsJson: payload.args_json === undefined ? undefined : redactSensitive(payload.args_json),
    argsPreview: safeArtifactText(stringValue(payload.args_preview)),
    durationMs: numberValue(payload.duration_ms),
    id: stringValue(payload.tool_call_id) || stringValue(payload.id) || "tool-call",
    name: stringValue(payload.name) || "tool",
    resultJson: payload.result_json === undefined ? undefined : redactSensitive(payload.result_json),
    resultPreview: safeArtifactText(stringValue(payload.result_preview)),
    resultRef: stringValue(payload.result_ref),
    stderrPreview: safeArtifactText(stringValue(payload.stderr_preview)),
  };
}

function approvalFromPayload(payload: Record<string, unknown>): ApprovalState {
  return {
    actions: Array.isArray(payload.actions) ? payload.actions.map(String) : undefined,
    approvalId: stringValue(payload.approval_id) || "approval",
    decision: stringValue(payload.decision),
    riskLevel: stringValue(payload.risk_level),
    title: stringValue(payload.title),
    toolCallId: stringValue(payload.tool_call_id),
  };
}

function delegateFromPayload(payload: Record<string, unknown>): DelegatedAgentState {
  const type = agentContextType(stringValue(payload.delegate_type));
  return {
    agentCount: Array.isArray(payload.agents) ? payload.agents.length : numberValue(payload.agent_count),
    approvalId: stringValue(payload.approval_id ?? payload.approvalId),
    approvalPolicy: stringValue(payload.approval_policy ?? payload.approvalPolicy),
    approvalStatus: stringValue(payload.approval_status ?? payload.approvalStatus),
    artifacts: artifactArray(payload.artifacts),
    childRunId: stringValue(payload.child_run_id ?? payload.childRunId),
    childToolCallId: stringValue(payload.child_tool_call_id ?? payload.childToolCallId),
    finalOutput: stringValue(payload.final_output),
    id: stringValue(payload.delegate_id ?? payload.delegateId) || "delegate",
    latestActivity: stringValue(payload.summary ?? payload.latest_activity),
    operationPreview: safeArtifactText(stringValue(payload.operation_preview ?? payload.operationPreview)),
    parentToolCallId: stringValue(payload.tool_call_id ?? payload.toolCallId ?? payload.parent_tool_call_id ?? payload.parentToolCallId),
    permissionProfile: stringValue(payload.permission_profile ?? payload.permissionProfile),
    reason: stringValue(payload.reason),
    status: statusValue(payload.status) || "running",
    task: stringValue(payload.task),
    title: stringValue(payload.title) || stringValue(payload.task) || "Delegated work",
    toolName: stringValue(payload.tool_name ?? payload.toolName),
    trace: delegatedTraceFromPayload(payload.trace),
    traceRef: stringValue(payload.trace_ref ?? payload.traceRef),
    type,
    workflow: stringValue(payload.workflow),
  };
}

function artifactFromPayload(value: unknown): ArtifactRef {
  const payload = recordValue(value);
  const fetchPath = stringValue(payload.fetch_path ?? payload.fetchPath);
  return {
    ...(fetchPath ? { fetchPath } : {}),
    id: stringValue(payload.id ?? payload.artifact_id) || "artifact",
    kind: stringValue(payload.kind) || "text",
    mimeType: stringValue(payload.mime_type ?? payload.mimeType),
    preview: safeArtifactText(stringValue(payload.preview)),
    sizeBytes: numberValue(payload.size_bytes ?? payload.sizeBytes),
    status: stringValue(payload.status) || "available",
    title: stringValue(payload.title) || stringValue(payload.id ?? payload.artifact_id) || "Artifact",
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

function storeArtifact(state: ChatRunState, sessionKey: string, artifact: ArtifactRef): void {
  const bucket = state.artifactsBySession.get(sessionKey) ?? new Map<string, ArtifactRef>();
  state.artifactsBySession.set(sessionKey, bucket);
  bucket.set(artifact.id, { ...(bucket.get(artifact.id) ?? {}), ...artifact });
}

function storeDelegatedRun(state: ChatRunState, sessionKey: string, delegate: DelegatedAgentState): void {
  const bucket = state.delegatedRunsBySession.get(sessionKey) ?? new Map<string, DelegatedAgentState>();
  state.delegatedRunsBySession.set(sessionKey, bucket);
  bucket.set(delegate.id, {
    ...(bucket.get(delegate.id) ?? {}),
    ...delegate,
    artifacts: delegate.artifacts ?? bucket.get(delegate.id)?.artifacts,
    trace: mergeDelegatedTrace(bucket.get(delegate.id)?.trace, delegate.trace),
  });
}

function resolveToolCallInspectorPanel(state: ChatRunState, selection: ChatInspectorSelection): ChatInspectorPanel {
  if (selection.kind !== "tool_call") {
    return unavailablePanel(selection.kind);
  }
  const step = findStep(state, selection.sessionKey, selection.turnId, selection.stepId);
  const tool = step?.toolCall;
  if (!tool) {
    return unavailablePanel("tool_call");
  }
  return {
    body: [
      tool.argsPreview || serialize(tool.argsJson ?? ""),
      tool.resultPreview || serialize(tool.resultJson ?? ""),
      tool.stderrPreview || "",
    ].filter(Boolean).join("\n\n"),
    kind: "tool_call",
    status: step?.status,
    subtitle: tool.id,
    title: tool.name,
  };
}

function resolveDelegateInspectorPanel(state: ChatRunState, selection: ChatInspectorSelection): ChatInspectorPanel {
  if (selection.kind !== "delegate") {
    return unavailablePanel(selection.kind);
  }
  const step = findStep(state, selection.sessionKey, selection.turnId, selection.stepId);
  const delegate = state.delegatedRunsBySession.get(selection.sessionKey)?.get(selection.delegateId) ?? step?.delegate;
  if (!delegate) {
    return unavailablePanel("delegate");
  }
  return {
    body: [
      delegate.task,
      delegate.latestActivity,
      delegate.finalOutput,
      delegate.traceRef ? `Trace: ${delegate.traceRef}` : "",
      delegate.permissionProfile ? `Permission: ${delegate.permissionProfile}` : "",
      delegate.approvalPolicy ? `Approval policy: ${delegate.approvalPolicy}` : "",
      delegate.approvalId ? `Approval: ${delegate.approvalId} (${delegate.approvalStatus || delegate.status})` : "",
      delegate.toolName ? `Tool: ${delegate.toolName}` : "",
      delegate.trace?.steps.length ? delegatedTraceText(delegate.trace) : "",
      delegate.operationPreview,
      delegate.reason,
      delegate.artifacts?.map((artifact) => `${artifact.kind}: ${artifact.title}`).join("\n"),
    ].filter(Boolean).join("\n\n"),
    kind: "delegate",
    status: delegate.status,
    subtitle: [delegate.type, delegate.workflow, delegate.agentCount ? `${delegate.agentCount} agents` : ""].filter(Boolean).join(" / "),
    title: delegate.title,
  };
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
    approvals: Array.isArray(payload.approvals) ? [...payload.approvals] : undefined,
    artifacts: artifactArray(payload.artifacts),
    childRunId: stringValue(payload.child_run_id ?? payload.childRunId),
    delegateId,
    finalMessage: chatMessageFromTrace(payload.final_message ?? payload.finalMessage),
    parentRunId: stringValue(payload.parent_run_id ?? payload.parentRunId),
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
      approvalId: stringValue(payload.approvalId ?? payload.approval_id),
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
      approvalId: stringValue(payload.approval_id ?? payload.approvalId),
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

function delegatedTraceText(trace: DelegatedAgentTraceState): string {
  const lines = trace.steps.map((step, index) => {
    const detail = [step.summary, step.resultPreview, step.error].filter(Boolean).join(" ");
    return `${index + 1}. ${step.title} [${step.kind}/${step.status}]${detail ? `\n${detail}` : ""}`;
  });
  if (trace.finalMessage?.text) {
    lines.push(`Final answer\n${trace.finalMessage.text}`);
  }
  return lines.join("\n\n");
}

function resolveApprovalInspectorPanel(state: ChatRunState, selection: ChatInspectorSelection): ChatInspectorPanel {
  if (selection.kind !== "approval") {
    return unavailablePanel(selection.kind);
  }
  const step = findStep(state, selection.sessionKey, selection.turnId, selection.stepId);
  const approval = step?.approval;
  if (!approval) {
    return unavailablePanel("approval");
  }
  return {
    body: [approval.riskLevel, approval.actions?.join(", "), approval.decision].filter(Boolean).join("\n"),
    kind: "approval",
    status: step?.status,
    subtitle: approval.approvalId,
    title: approval.title || "Approval",
  };
}

function resolveArtifactInspectorPanel(state: ChatRunState, selection: ChatInspectorSelection): ChatInspectorPanel {
  if (selection.kind !== "artifact") {
    return unavailablePanel(selection.kind);
  }
  const artifact = getArtifactRef(state, selection.sessionKey, selection.artifactId);
  if (!artifact) {
    return unavailablePanel("artifact");
  }
  return {
    body: artifact.preview || "Artifact preview unavailable. Full content is fetched only when requested.",
    kind: "artifact",
    status: artifact.status,
    subtitle: [artifact.kind, artifact.mimeType, artifact.sizeBytes ? `${artifact.sizeBytes} bytes` : ""].filter(Boolean).join(" / "),
    title: artifact.title,
  };
}

function resolveReferenceInspectorPanel(): ChatInspectorPanel {
  return unavailablePanel("reference");
}

function resolveErrorInspectorPanel(state: ChatRunState, selection: ChatInspectorSelection): ChatInspectorPanel {
  if (selection.kind !== "error") {
    return unavailablePanel(selection.kind);
  }
  const step = findStep(state, selection.sessionKey, selection.turnId, selection.stepId);
  return {
    body: serialize(step?.error ?? "Error details unavailable."),
    kind: "error",
    status: step?.status,
    title: step?.title || "Error",
  };
}

function findStep(state: ChatRunState, sessionKey: string, turnId: string, stepId: string): ChatStep | null {
  return state.turnsBySession.get(sessionKey)?.find((turn) => turn.id === turnId)?.steps.find((step) => step.id === stepId) ?? null;
}

function unavailablePanel(kind: ChatInspectorSelection["kind"]): ChatInspectorPanel {
  return {
    body: "Details are unavailable for this selection.",
    kind,
    status: "unavailable",
    title: "Unavailable",
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

function normalizeReferences(value: unknown): NativeChatReference[] | undefined {
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

function conversationReferences(references?: NativeChatReference[]): ChatMessageProjection["references"] {
  return (references ?? []).map((reference) => ({
    detail: reference.detail,
    evidenceId: reference.evidenceId,
    kind: reference.kind,
    noteId: reference.noteId,
    rawLine: reference.rawLine,
    rawPath: reference.rawPath,
    scope: reference.scope,
    sourceEndLine: reference.sourceEndLine,
    sourceLine: reference.sourceLine,
    sourcePath: reference.sourcePath,
    sourceText: reference.sourceText,
    title: reference.title,
    type: reference.type,
    revision: reference.revision,
  }));
}

function agentContextFromPayload(value: unknown): AgentContext {
  const payload = recordValue(value);
  return {
    id: stringValue(payload.id) || "main",
    title: stringValue(payload.title) || "Tinybot",
    type: agentContextType(stringValue(payload.type)),
  };
}

function mainContext(): AgentContext {
  return { id: "main", title: "Tinybot", type: "main" };
}

function agentContextType(value: string): AgentContextType {
  return ["spawn", "subagent", "cowork", "team"].includes(value) ? value as AgentContextType : "main";
}

function statusValue(value: unknown): ChatStepStatus | "" {
  const normalized = stringValue(value).toLowerCase().replace(/[\s-]+/g, "_");
  if (["pending", "running", "blocked", "completed", "failed", "cancelled"].includes(normalized)) {
    return normalized as ChatStepStatus;
  }
  if (["awaiting_approval", "approval_required"].includes(normalized)) {
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

function turnStatusValue(value: unknown): ChatTurnStatus | "" {
  const normalized = stringValue(value).toLowerCase().replace(/[\s-]+/g, "_");
  if (["pending", "running", "awaiting_approval", "awaiting_user", "completed", "failed", "interrupted"].includes(normalized)) {
    return normalized as ChatTurnStatus;
  }
  if (normalized === "awaiting_form" || normalized === "blocked") {
    return "awaiting_user";
  }
  return "";
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

function stableId(...parts: Array<string | number | undefined>): string {
  return parts.filter((part) => part !== undefined && String(part).length > 0).map((part) => String(part).replace(/\s+/g, "-")).join(":");
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
