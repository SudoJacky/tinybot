import type { NativeChatMessage, NativeChatReference } from "./nativeChat";
import type { ConversationMessageIslandOptions } from "./native-vue/conversationMessageIsland";

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
  artifacts?: ArtifactRef[];
  finalOutput?: string;
  id: string;
  latestActivity?: string;
  status: ChatStepStatus;
  task?: string;
  title: string;
  type: AgentContextType;
  workflow?: string;
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

const SENSITIVE_KEYS = new Set(["api_key", "token", "secret", "password", "authorization", "cookie", "credential", "private_key"]);
const UNSAFE_KEYS = new Set(["html", "script", "style", "component", "handler", "renderer", "template", "onClick", "onSubmit"]);

export function createChatRunState(): ChatRunState {
  return {
    appliedEventIds: new Set(),
    legacyMessagesBySession: new Map(),
    selectedInspector: null,
    turnsBySession: new Map(),
  };
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
      summary: text,
      title: event.event_type === "message.completed" ? "Final answer" : "Assistant message",
    });
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
    upsertStep(turn, event, {
      approval: approvalFromPayload(event.payload),
      kind: "approval",
      status: event.event_type === "approval.resolved" ? "completed" : "blocked",
      title: stringValue(event.payload.title) || "Approval",
    });
    return state;
  }

  if (event.event_type === "agent.delegate.started" || event.event_type === "agent.delegate.updated" || event.event_type === "agent.delegate.completed") {
    const delegate = delegateFromPayload(event.payload);
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
      argsText: step.delegate.task ?? "",
      id: step.delegate.id,
      kind: "call",
      name: `${capitalize(step.delegate.type)}: ${step.delegate.title}`,
      responseText: step.delegate.latestActivity ?? step.delegate.finalOutput ?? "",
      approvalStatus: "",
      status: step.status,
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

function upsertStep(turn: ChatTurn, event: AgentEventEnvelope, patch: Partial<ChatStep> & Pick<ChatStep, "kind" | "status" | "title">): ChatStep {
  const stepId = event.step_id || stableId("step", event.turn_id, event.sequence);
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
    artifacts: artifactArray(payload.artifacts),
    finalOutput: stringValue(payload.final_output),
    id: stringValue(payload.delegate_id) || "delegate",
    latestActivity: stringValue(payload.summary ?? payload.latest_activity),
    status: statusValue(payload.status) || "running",
    task: stringValue(payload.task),
    title: stringValue(payload.title) || stringValue(payload.task) || "Delegated work",
    type,
    workflow: stringValue(payload.workflow),
  };
}

function artifactFromPayload(value: unknown): ArtifactRef {
  const payload = recordValue(value);
  return {
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

function capitalize(value: string): string {
  return value ? `${value.slice(0, 1).toUpperCase()}${value.slice(1)}` : value;
}
