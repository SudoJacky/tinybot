import type {
  NativeChatMessage,
  NativeChatState,
  NativeChatToolActivity,
} from "./nativeChat";

export type RuntimeCapabilityStatus =
  | "available"
  | "route"
  | "partial"
  | "missing"
  | "frozen";

export type RuntimeCapabilityAuditEntry = {
  status: RuntimeCapabilityStatus;
  source: string;
  notes: string;
};

export const CHAT_RUNTIME_CAPABILITY_AUDIT = {
  sessions: {
    status: "available",
    source: "worker_sessions_list / worker_session_messages",
    notes: "Rust state service exposes session metadata and persisted message history.",
  },
  messages: {
    status: "available",
    source: "session.get_history / agent.run_input",
    notes: "Rust runtime persists main-thread messages and runs new user input through agent.run_input.",
  },
  runInput: {
    status: "available",
    source: "worker_run_agent_input / worker_transport_dispatch_websocket_message",
    notes: "Native websocket dispatch builds agent.run_input requests for Rust runtime.",
  },
  approvalResume: {
    status: "route",
    source: "worker_webui_route /api/approvals",
    notes: "Standalone worker_resume_agent_approval is unsupported, but Rust-owned WebUI approval routes restore and resolve checkpoints.",
  },
  subagentTranscript: {
    status: "partial",
    source: "worker_background_trace_get_delegate_trace",
    notes: "Delegate trace can be queried, but a first-class full subagent transcript facade is not present in the current contract.",
  },
  subagentDirectInput: {
    status: "partial",
    source: "worker_background_subagent_enqueue_input",
    notes: "User direct input can be persisted as a delegate message_queued trace event for a future runtime consumer; live delivery into a running child thread is not present yet.",
  },
  branchSession: {
    status: "available",
    source: "worker_session_branch / /api/sessions/branch",
    notes: "Rust-owned branch session route creates history-only branches without copying runtime state.",
  },
  legacyConversationThread: {
    status: "frozen",
    source: "conversationThreadIsland",
    notes: "Legacy thread internals are kept only for compatibility, fallback, adapter, or entry-switch support.",
  },
} as const satisfies Record<string, RuntimeCapabilityAuditEntry>;

export const CHAT_SURFACE_OWNERSHIP = {
  newProductBehaviorTarget: "new-chat-surface",
  legacyConversationThread: {
    module: "conversationThreadIsland",
    frozenForNewProductBehavior: true,
    allowedChanges: [
      "compatibility",
      "fallback",
      "adapter",
      "entry-switch",
    ],
  },
} as const;

export type ProjectionCapability =
  | "can_send_message"
  | "partial_transcript"
  | "full_transcript"
  | "can_forward"
  | "can_approve_session_scope"
  | "can_branch_session";

export type SessionPrimaryBadge =
  | "waiting_approval"
  | "running"
  | "unread"
  | "updated_time";

export type SessionSummary = {
  key: string;
  chatId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  pinned?: boolean;
  primaryBadge: SessionPrimaryBadge;
  isActive: boolean;
};

export type ToolCallStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "waiting_approval"
  | "unknown";

export type ToolCallSummary = {
  id: string;
  name: string;
  status: ToolCallStatus;
  preview: string;
  argsPreview: string;
  resultPreview: string;
  detail: {
    argsText: string;
    responseText: string;
    rawEvent?: unknown;
    stdout: string;
    stderr: string;
  };
  kind: "call" | "result";
  approvalId?: string;
  delegateId?: string;
};

export type ChatTurn = {
  id: string;
  role: string;
  content: string;
  reasoningContent: string;
  timestamp: string;
  tools: ToolCallSummary[];
  process?: {
    state: "idle" | "running" | "completed" | "waiting_approval";
    summary: string;
    toolCount: number;
  };
};

export type ApprovalRequest = {
  id: string;
  sessionKey: string;
  toolName: string;
  status: "pending" | "approved" | "denied";
  scopeKey?: string;
  scopeLabel?: string;
  prompt: string;
  choices: Array<"allow_once" | "allow_session" | "deny">;
};

export type SubagentStatus =
  | "waiting_main_agent"
  | "waiting_user"
  | "running"
  | "has_update"
  | "user_intervened_unsynced"
  | "idle"
  | "completed";

export type SubagentTranscript = {
  id: string;
  sessionKey: string;
  capability: "partial_transcript" | "full_transcript";
  messages: Array<{
    id: string;
    role: string;
    content: string;
    timestamp?: string;
  }>;
  toolSummaries: Array<{
    id: string;
    name: string;
    status: ToolCallStatus;
    preview: string;
  }>;
};

export type LiveSubagent = {
  id: string;
  sessionKey: string;
  name: string;
  task: string;
  status: SubagentStatus;
  latestActivity: string;
  capabilities: ProjectionCapability[];
  transcript: SubagentTranscript;
};

export type QueuedInput = {
  id: string;
  mode: "queued" | "guide";
  content: string;
  createdAt: string;
  status: "queued" | "paused" | "sent" | "guided";
};

export type DetailPanelState = {
  kind: "none" | "tool" | "subagent" | "artifact" | "error" | "raw";
  open: boolean;
  presentation: "drawer" | "fullscreen";
  targetId?: string;
};

export type BranchSourceState = {
  canBranchSession: boolean;
  portableContextKeys: string[];
  runtimeStateExcluded: boolean;
};

export type ArtifactDetail = {
  id: string;
  kind: string;
  title: string;
  preview: string;
  metadataSummary: string;
  sourceTurnId?: string;
  sourceToolId?: string;
  openLabel?: string;
};

export type ErrorDetail = {
  id: string;
  message: string;
  raw: string;
  relatedTurnId?: string;
  relatedToolId?: string;
};

export type ChatUiProjection = {
  sessions: SessionSummary[];
  activeSessionKey: string;
  turns: ChatTurn[];
  approvals: ApprovalRequest[];
  liveSubagents: LiveSubagent[];
  queuedInputs: QueuedInput[];
  artifacts?: ArtifactDetail[];
  errors?: ErrorDetail[];
  detailPanel: DetailPanelState;
  branchSource: BranchSourceState;
};

export type ChatUiProjectionOptions = {
  queuedInputsBySession?: Map<string, QueuedInput[]>;
  detailPanel?: DetailPanelState;
};

export function createEmptyChatDetailPanelState(): DetailPanelState {
  return {
    kind: "none",
    open: false,
    presentation: "drawer",
  };
}

export function projectNativeChatState(
  state: NativeChatState,
  options: ChatUiProjectionOptions = {},
): ChatUiProjection {
  const activeSessionKey = state.activeSessionKey;
  const messages = state.messages.get(activeSessionKey) ?? [];
  const turns = messages.map((message) => projectMessageTurn(message, state.respondingSessionKeys.has(activeSessionKey)));
  const approvals = approvalRequestsFromMessages(activeSessionKey, messages);
  const liveSubagents = liveSubagentsFromMessages(activeSessionKey, messages);
  const queuedInputs = options.queuedInputsBySession?.get(activeSessionKey) ?? [];
  const artifacts = artifactDetailsFromMessages(messages);
  return {
    sessions: state.sessions.map((session) => ({
      key: session.key,
      chatId: session.chatId,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      ...(session.pinned ? { pinned: true } : {}),
      primaryBadge: primaryBadgeForSession(session.key, state, approvals),
      isActive: session.key === activeSessionKey,
    })),
    activeSessionKey,
    turns,
    approvals,
    liveSubagents,
    queuedInputs,
    ...(artifacts.length ? { artifacts } : {}),
    detailPanel: options.detailPanel ?? createEmptyChatDetailPanelState(),
    branchSource: {
      canBranchSession: true,
      portableContextKeys: ["chatId", "sessionKey"],
      runtimeStateExcluded: true,
    },
  };
}

function projectMessageTurn(message: NativeChatMessage, running: boolean): ChatTurn {
  const tools = (message.toolActivities ?? []).map(projectToolActivity);
  return {
    id: message.messageId,
    role: message.role,
    content: message.content,
    reasoningContent: message.reasoningContent,
    timestamp: message.timestamp,
    tools,
    ...(tools.length
      ? {
          process: {
            state: processStateForTools(tools, running),
            summary: `Execution process · ${tools.length} tools`,
            toolCount: tools.length,
          },
        }
      : {}),
  };
}

function projectToolActivity(activity: NativeChatToolActivity): ToolCallSummary {
  const status = toolStatus(activity);
  return {
    id: activity.id,
    name: activity.name,
    status,
    preview: previewText(activity),
    argsPreview: activity.argsText,
    resultPreview: activity.responseText,
    detail: {
      argsText: activity.argsText,
      responseText: activity.responseText,
      rawEvent: activity.delegatedTrace,
      stdout: "",
      stderr: "",
    },
    kind: activity.kind,
    ...(activity.approvalId ? { approvalId: activity.approvalId } : {}),
    ...(activity.delegateId ? { delegateId: activity.delegateId } : {}),
  };
}

function primaryBadgeForSession(
  sessionKey: string,
  state: NativeChatState,
  activeApprovals: ApprovalRequest[],
): SessionPrimaryBadge {
  const sessionMessages = state.messages.get(sessionKey) ?? [];
  if (sessionKey === state.activeSessionKey && activeApprovals.length > 0) {
    return "waiting_approval";
  }
  if (hasPendingApproval(sessionMessages)) {
    return "waiting_approval";
  }
  if (state.respondingSessionKeys.has(sessionKey)) {
    return "running";
  }
  return "updated_time";
}

function approvalRequestsFromMessages(sessionKey: string, messages: NativeChatMessage[]): ApprovalRequest[] {
  return messages.flatMap((message) =>
    (message.toolActivities ?? [])
      .filter((activity) => Boolean(activity.approvalId) && toolStatus(activity) === "waiting_approval")
      .map((activity) => ({
        id: activity.approvalId || activity.id,
        sessionKey,
        toolName: activity.name,
        status: "pending" as const,
        scopeKey: approvalScopeKey(activity),
        scopeLabel: approvalScopeLabel(activity),
        prompt: activity.responseText || "Approval required",
        choices: ["allow_once", "allow_session", "deny"] as const,
      })),
  );
}

function liveSubagentsFromMessages(sessionKey: string, messages: NativeChatMessage[]): LiveSubagent[] {
  const subagents = new Map<string, LiveSubagent>();
  for (const message of messages) {
    for (const activity of message.toolActivities ?? []) {
      if (!activity.delegateId) {
        continue;
      }
      const status = subagentStatus(activity);
      subagents.set(activity.delegateId, {
        id: activity.delegateId,
        sessionKey,
        name: activity.delegateTitle || activity.delegateId,
        task: activity.delegateTask || "",
        status,
        latestActivity: activity.responseText || activity.finalOutput || activity.status || "",
        capabilities: ["partial_transcript", "can_forward"],
        transcript: {
          id: activity.delegateId,
          sessionKey,
          capability: "partial_transcript",
          messages: [],
          toolSummaries: [{
            id: activity.id,
            name: activity.name,
            status: toolStatus(activity),
            preview: previewText(activity),
          }],
        },
      });
    }
  }
  return [...subagents.values()];
}

function artifactDetailsFromMessages(messages: NativeChatMessage[]): ArtifactDetail[] {
  return messages.flatMap((message) =>
    (message.toolActivities ?? [])
      .filter((activity) => activity.name.startsWith("Artifact:"))
      .map((activity) => ({
        id: activity.id,
        kind: "artifact",
        title: activity.name.replace(/^Artifact:\s*/, "") || activity.name,
        preview: activity.responseText,
        metadataSummary: [
          activity.status ? `Status: ${activity.status}` : "",
          message.messageId ? `Turn: ${message.messageId}` : "",
        ].filter(Boolean).join(" / "),
        sourceTurnId: message.messageId,
        sourceToolId: activity.id,
      })),
  );
}

function hasPendingApproval(messages: NativeChatMessage[]): boolean {
  return messages.some((message) =>
    (message.toolActivities ?? []).some((activity) => Boolean(activity.approvalId) && toolStatus(activity) === "waiting_approval"),
  );
}

function toolStatus(activity: NativeChatToolActivity): ToolCallStatus {
  const explicit = normalizeStatus(activity.approvalStatus || activity.status);
  if (activity.approvalId && (explicit === "pending" || explicit === "waiting_approval")) {
    return "waiting_approval";
  }
  return explicit;
}

function normalizeStatus(status: string | undefined): ToolCallStatus {
  switch ((status || "").toLowerCase()) {
    case "pending":
      return "pending";
    case "running":
      return "running";
    case "completed":
    case "complete":
    case "succeeded":
      return "completed";
    case "failed":
    case "error":
      return "failed";
    case "waiting_approval":
    case "awaiting_approval":
    case "approval_required":
    case "blocked":
      return "waiting_approval";
    default:
      return status ? "unknown" : "unknown";
  }
}

type ChatTurnProcessState = NonNullable<ChatTurn["process"]>["state"];

function processStateForTools(tools: ToolCallSummary[], running: boolean): ChatTurnProcessState {
  if (tools.some((tool) => tool.status === "waiting_approval")) {
    return "waiting_approval";
  }
  if (running || tools.some((tool) => tool.status === "running" || tool.status === "pending")) {
    return "running";
  }
  return "completed";
}

function subagentStatus(activity: NativeChatToolActivity): SubagentStatus {
  const status = (activity.status || "").toLowerCase();
  if (status.includes("waiting_user")) {
    return "waiting_user";
  }
  if (status.includes("waiting") || status.includes("blocked")) {
    return "waiting_main_agent";
  }
  if (status.includes("completed") || status.includes("closed")) {
    return "completed";
  }
  if (status.includes("update")) {
    return "has_update";
  }
  if (status.includes("running")) {
    return "running";
  }
  return "idle";
}

function previewText(activity: NativeChatToolActivity): string {
  return activity.responseText || activity.argsText || activity.finalOutput || activity.status || "";
}

function approvalScopeKey(activity: NativeChatToolActivity): string | undefined {
  if (activity.name.includes("write")) {
    return "filesystem.write:workspace";
  }
  if (activity.name.includes("read")) {
    return "filesystem.read:workspace";
  }
  return undefined;
}

function approvalScopeLabel(activity: NativeChatToolActivity): string | undefined {
  const scopeKey = approvalScopeKey(activity);
  if (scopeKey === "filesystem.write:workspace") {
    return "Allow workspace writes for this session";
  }
  if (scopeKey === "filesystem.read:workspace") {
    return "Allow workspace reads for this session";
  }
  return undefined;
}
