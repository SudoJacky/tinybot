import type { NativeChatMessage, NativeChatReference } from "./nativeChat";
import type { ConversationMessageIslandOptions } from "../components/chat/conversationMessageIsland";

export type ChatTurnStatus = "pending" | "running" | "awaiting_approval" | "awaiting_user" | "completed" | "failed" | "interrupted";
export type ChatStepStatus = "pending" | "running" | "blocked" | "completed" | "failed" | "cancelled";
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

export type ChatMessage = {
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
  | "memory"
  | "error";

export type ChatStep = {
  agentContext: AgentContext;
  approval?: ApprovalState;
  artifacts?: ArtifactRef[];
  completedAt?: string;
  delegate?: DelegatedAgentState;
  error?: unknown;
  id: string;
  kind: ChatStepKind;
  parentStepId?: string;
  references?: NativeChatReference[];
  sequence: number;
  startedAt?: string;
  status: ChatStepStatus;
  summary?: string;
  title: string;
  toolCall?: ToolCallState;
};

export type ChatTurn = {
  completedAt?: string;
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
    turn.usage = normalizeUsage(event.payload.usage);
    return state;
  }

  if (event.event_type === "agent.turn.updated") {
    turn.status = turnStatusValue(event.payload.status) || turn.status;
    turn.usage = normalizeUsage(event.payload.usage) ?? turn.usage;
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
    upsertStep(turn, event, {
      kind: "reasoning",
      status: event.event_type === "reasoning.completed" ? "completed" : "running",
      summary: visibility === "hidden" ? stringValue(event.payload.summary) : stringValue(event.payload.text ?? event.payload.summary),
      title: event.event_type === "reasoning.completed" ? "Thinking complete" : "Thinking",
    });
    return state;
  }

  if (event.event_type === "message.delta" || event.event_type === "message.completed") {
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
      turn.status = "completed";
      turn.completedAt = event.created_at;
    }
    upsertStep(turn, event, {
      kind: "message",
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

export function turnsToConversationMessages(turns: ChatTurn[]): ConversationMessageIslandOptions[] {
  return turns.flatMap((turn) => {
    const messages: ConversationMessageIslandOptions[] = [{
      author: "You",
      body: [turn.userMessage.text],
      references: [],
      time: turn.userMessage.timestamp,
      tone: "user",
      toolActivities: [],
    }];
    for (const step of turn.steps) {
      if (turn.finalMessage && step.kind === "message") {
        continue;
      }
      messages.push(stepToConversationMessage(step));
    }
    if (turn.finalMessage) {
      messages.push({
        author: "Tinybot",
        body: [turn.finalMessage.text],
        copyable: true,
        references: conversationReferences(turn.finalMessage.references),
        reasoningContent: "",
        time: turn.finalMessage.timestamp,
        tone: "assistant",
        toolActivities: [],
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

function stepToConversationMessage(step: ChatStep): ConversationMessageIslandOptions {
  return {
    author: "Tinybot",
    body: step.kind === "message" && step.summary ? [step.summary] : [],
    copyable: step.kind === "message" ? false : undefined,
    references: conversationReferences(step.references),
    reasoningContent: step.kind === "reasoning" ? step.summary : "",
    reasoningLabel: step.title,
    time: step.startedAt || step.completedAt || "",
    tone: "assistant",
    toolActivities: stepToToolActivities(step),
  };
}

function stepToToolActivities(step: ChatStep): ConversationMessageIslandOptions["toolActivities"] {
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
    steps: traceStepArray(payload.steps),
    updatedAt: stringValue(payload.updated_at ?? payload.updatedAt),
  };
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
  return {
    cachedTokens: numberValue(payload.cached_tokens ?? payload.cachedTokens),
    completionTokens: numberValue(payload.completion_tokens ?? payload.completionTokens),
    promptTokens: numberValue(payload.prompt_tokens ?? payload.promptTokens),
    totalTokens: numberValue(payload.total_tokens ?? payload.totalTokens),
  };
}

function normalizeReferences(value: unknown): NativeChatReference[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.map((item) => {
    const row = recordValue(item);
    return {
      detail: stringValue(row.detail ?? row.content ?? row.summary ?? row.url),
      kind: "reference",
      title: stringValue(row.title ?? row.name ?? row.id) || "Reference",
    };
  });
}

function conversationReferences(references?: NativeChatReference[]): ConversationMessageIslandOptions["references"] {
  return (references ?? []).map((reference) => ({
    detail: reference.detail,
    evidenceId: reference.evidenceId,
    kind: reference.kind,
    noteId: reference.noteId,
    rawLine: reference.rawLine,
    rawPath: reference.rawPath,
    scope: reference.scope,
    sourceLine: reference.sourceLine,
    sourcePath: reference.sourcePath,
    sourceText: reference.sourceText,
    title: reference.title,
    type: reference.type,
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
