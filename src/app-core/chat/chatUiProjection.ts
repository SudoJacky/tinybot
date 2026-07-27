export type ProjectionCapability =
  | "can_send_message"
  | "partial_transcript"
  | "full_transcript"
  | "can_forward"
  | "can_approve_session_scope"
  | "can_branch_session";

export type ToolCallStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "waiting_approval"
  | "unknown";

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
  traceRef?: string;
  childTurnId?: string;
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
