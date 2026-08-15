import type { AgentInputReference } from "./agentInputReference";
import type {
  AgentContext,
  ArtifactRef,
  AssistantMessagePhase,
  BackendAgentTurnItem,
  BackendAgentTurnRuntimeState,
  BackendAgentTurnStatus,
  ChatMessage,
  ChatStep,
  ChatStepStatus,
  ChatTurn,
  ChatTurnStatus,
  DelegatedAgentState,
  DelegatedAgentTraceState,
  DelegatedAgentTraceStep,
  LoadedArtifactDetail,
  PlanState,
  ScopedErrorState,
  TokenUsage,
  ToolCallState,
} from "./chatTurnContracts";
import { safeArtifactPreview, sanitizeTextPreview } from "./chatPreview";
import { parseDataViewDocument, type DataViewDocument } from "./dataView";

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

export function projectBackendTimeline(
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
      title: item.title || (payload.cancelled ? "Cancelled" : "Error"),
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

function safeArtifactText(value: string): string {
  return sanitizeTextPreview(value);
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
