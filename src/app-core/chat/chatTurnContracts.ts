import type { AgentInputReference } from "./agentInputReference";
import type { DataViewDocument } from "./dataView";

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
  metrics?: TurnMetrics;
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

export type TurnMetrics = {
  timeToFirstTokenMs?: number;
  tokensPerSecond?: number;
};

export type ModelCallTiming = {
  modelCallId: string;
  timeToFirstTokenMs: number | null;
  decodeDurationMs: number | null;
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
  | { type: "usage"; id?: string | null; inputTokens?: number | null; outputTokens?: number | null; totalTokens?: number | null; providerPayload: unknown; modelTiming?: ModelCallTiming }
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
