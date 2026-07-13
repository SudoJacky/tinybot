import type { ChatTurn } from "./chatRunModel";

export const TINYOS_COMMAND_ACK_TIMEOUT_MS = 5_000;

export type TinyOsCommandSource = {
  control: string;
  surface: "chat" | "tinyos";
};

export type TinyOsAgentCancelCommand = {
  schemaVersion: "tinybot.command.v1";
  commandId: string;
  issuedAt: string;
  kind: "agent.cancel";
  source: TinyOsCommandSource;
  target: {
    runId: string;
    sessionId: string;
    threadId?: string;
    turnId?: string;
  };
};

export type TinyOsApprovalResolveCommand = {
  schemaVersion: "tinybot.command.v1";
  commandId: string;
  issuedAt: string;
  kind: "approval.resolve";
  source: TinyOsCommandSource;
  target: {
    runId: string;
    sessionId: string;
    threadId?: string;
    turnId?: string;
  };
  approval: {
    approvalId: string;
    approved: boolean;
    scope: "once" | "session";
    guidance?: string;
  };
};

export type TinyOsFormSubmitCommand = {
  schemaVersion: "tinybot.command.v1";
  commandId: string;
  issuedAt: string;
  kind: "form.submit";
  source: TinyOsCommandSource;
  target: {
    runId: string;
    sessionId: string;
    threadId?: string;
    turnId?: string;
  };
  form: {
    formId: string;
    values: Record<string, unknown>;
  };
};

export type TinyOsFormCancelCommand = {
  schemaVersion: "tinybot.command.v1";
  commandId: string;
  issuedAt: string;
  kind: "form.cancel";
  source: TinyOsCommandSource;
  target: {
    runId: string;
    sessionId: string;
    threadId?: string;
    turnId?: string;
  };
  form: {
    formId: string;
  };
};

export type TinyOsCommand = TinyOsAgentCancelCommand
  | TinyOsApprovalResolveCommand
  | TinyOsFormSubmitCommand
  | TinyOsFormCancelCommand;

export type TinyOsCommandAcknowledgement = {
  itemId: string;
  revision: number;
};

export type TinyOsCommandCompletion = TinyOsCommandAcknowledgement & {
  status: "completed" | "failed" | "cancelled";
};

export type TinyOsCommandLifecycle =
  | { stage: "idle" }
  | { command: TinyOsCommand; dispatchedAtMs: number; stage: "sending" }
  | { command: TinyOsCommand; dispatchedAtMs: number; transportAcceptedAtMs: number; stage: "waiting_for_canonical" }
  | { acknowledgement: TinyOsCommandAcknowledgement; command: TinyOsCommand; acknowledgedAtMs: number; dispatchedAtMs: number; stage: "acknowledged" }
  | { acknowledgement: TinyOsCommandAcknowledgement; command: TinyOsCommand; completedAtMs: number; completion: TinyOsCommandCompletion; dispatchedAtMs: number; stage: "completed" }
  | { command: TinyOsCommand; dispatchedAtMs: number; error: string; stage: "rejected" }
  | { command: TinyOsCommand; dispatchedAtMs: number; error: string; stage: "timed_out" };

export type TinyOsCommandLifecycleAction =
  | { command: TinyOsCommand; nowMs: number; type: "dispatch" }
  | { commandId: string; nowMs: number; type: "transport_accepted" }
  | { acknowledgement: TinyOsCommandAcknowledgement; commandId: string; nowMs: number; type: "canonical_acknowledged" }
  | { commandId: string; completion: TinyOsCommandCompletion; nowMs: number; type: "operation_completed" }
  | { commandId: string; error: string; type: "rejected" }
  | { commandId: string; type: "ack_timeout" }
  | { type: "reset" };

export function createTinyOsAgentCancelCommand(input: {
  commandId?: string;
  issuedAt?: string;
  runId: string;
  sessionId: string;
  source: TinyOsCommandSource;
  threadId?: string;
  turnId?: string;
}): TinyOsAgentCancelCommand {
  const issuedAt = input.issuedAt ?? new Date().toISOString();
  return {
    schemaVersion: "tinybot.command.v1",
    commandId: input.commandId ?? createTinyOsCommandId(),
    issuedAt,
    kind: "agent.cancel",
    source: input.source,
    target: {
      runId: input.runId,
      sessionId: input.sessionId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ...(input.turnId ? { turnId: input.turnId } : {}),
    },
  };
}

export function createTinyOsApprovalResolveCommand(input: {
  action: "approveOnce" | "approveSession" | "deny";
  approvalId: string;
  commandId?: string;
  guidance?: string;
  issuedAt?: string;
  runId: string;
  sessionId: string;
  source: TinyOsCommandSource;
  threadId?: string;
  turnId?: string;
}): TinyOsApprovalResolveCommand {
  const guidance = input.guidance?.trim();
  return {
    schemaVersion: "tinybot.command.v1",
    commandId: input.commandId ?? createTinyOsCommandId(),
    issuedAt: input.issuedAt ?? new Date().toISOString(),
    kind: "approval.resolve",
    source: input.source,
    target: {
      runId: input.runId,
      sessionId: input.sessionId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ...(input.turnId ? { turnId: input.turnId } : {}),
    },
    approval: {
      approvalId: input.approvalId,
      approved: input.action !== "deny",
      scope: input.action === "approveSession" ? "session" : "once",
      ...(guidance ? { guidance } : {}),
    },
  };
}

export function createTinyOsFormSubmitCommand(input: {
  commandId?: string;
  formId: string;
  issuedAt?: string;
  runId: string;
  sessionId: string;
  source: TinyOsCommandSource;
  threadId?: string;
  turnId?: string;
  values: Record<string, unknown>;
}): TinyOsFormSubmitCommand {
  return {
    schemaVersion: "tinybot.command.v1",
    commandId: input.commandId ?? createTinyOsCommandId(),
    issuedAt: input.issuedAt ?? new Date().toISOString(),
    kind: "form.submit",
    source: input.source,
    target: {
      runId: input.runId,
      sessionId: input.sessionId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ...(input.turnId ? { turnId: input.turnId } : {}),
    },
    form: {
      formId: input.formId,
      values: { ...input.values },
    },
  };
}

export function createTinyOsFormCancelCommand(input: {
  commandId?: string;
  formId: string;
  issuedAt?: string;
  runId: string;
  sessionId: string;
  source: TinyOsCommandSource;
  threadId?: string;
  turnId?: string;
}): TinyOsFormCancelCommand {
  return {
    schemaVersion: "tinybot.command.v1",
    commandId: input.commandId ?? createTinyOsCommandId(),
    issuedAt: input.issuedAt ?? new Date().toISOString(),
    kind: "form.cancel",
    source: input.source,
    target: {
      runId: input.runId,
      sessionId: input.sessionId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ...(input.turnId ? { turnId: input.turnId } : {}),
    },
    form: {
      formId: input.formId,
    },
  };
}

export function reduceTinyOsCommandLifecycle(
  state: TinyOsCommandLifecycle,
  action: TinyOsCommandLifecycleAction,
): TinyOsCommandLifecycle {
  if (action.type === "reset") return { stage: "idle" };
  if (action.type === "dispatch") {
    return { command: action.command, dispatchedAtMs: action.nowMs, stage: "sending" };
  }
  if (state.stage === "idle" || state.command.commandId !== action.commandId) return state;
  if (state.stage === "completed" || state.stage === "rejected" || state.stage === "timed_out") return state;
  if (action.type === "operation_completed") {
    if (state.stage !== "acknowledged") return state;
    return {
      acknowledgement: state.acknowledgement,
      command: state.command,
      completedAtMs: action.nowMs,
      completion: action.completion,
      dispatchedAtMs: state.dispatchedAtMs,
      stage: "completed",
    };
  }
  if (action.type === "rejected") {
    return { command: state.command, dispatchedAtMs: state.dispatchedAtMs, error: action.error, stage: "rejected" };
  }
  if (state.stage === "acknowledged") return state;
  if (action.type === "transport_accepted") {
    return {
      command: state.command,
      dispatchedAtMs: state.dispatchedAtMs,
      transportAcceptedAtMs: action.nowMs,
      stage: "waiting_for_canonical",
    };
  }
  if (action.type === "canonical_acknowledged") {
    return {
      acknowledgement: action.acknowledgement,
      acknowledgedAtMs: action.nowMs,
      command: state.command,
      dispatchedAtMs: state.dispatchedAtMs,
      stage: "acknowledged",
    };
  }
  return {
    command: state.command,
    dispatchedAtMs: state.dispatchedAtMs,
    error: "Runtime confirmation was not received within 5 seconds.",
    stage: "timed_out",
  };
}

export function canonicalTinyOsCommandAcknowledgement(
  turns: ChatTurn[],
  commandId: string,
): TinyOsCommandAcknowledgement | undefined {
  for (const turn of turns) {
    for (const item of turn.canonicalItems ?? []) {
      const directCommandId = stringValue(item.data.commandId ?? item.data.command_id);
      const detail = recordValue(item.data.detail);
      const detailCommandId = stringValue(detail.commandId ?? detail.command_id);
      const commandStatus = stringValue(detail.commandStatus ?? detail.command_status);
      if ((directCommandId === commandId || detailCommandId === commandId) && commandStatus === "acknowledged") {
        return { itemId: item.itemId, revision: item.revision };
      }
    }
  }
  return undefined;
}

export function canonicalTinyOsCommandCompletion(
  turns: ChatTurn[],
  commandId: string,
): TinyOsCommandCompletion | undefined {
  for (const turn of turns) {
    for (const item of turn.canonicalItems ?? []) {
      const detail = recordValue(item.data.detail);
      const itemCommandId = stringValue(item.data.commandId ?? item.data.command_id)
        || stringValue(detail.commandId ?? detail.command_id);
      if (itemCommandId !== commandId || stringValue(detail.commandStatus ?? detail.command_status) === "acknowledged") continue;
      const status = item.status === "cancelled" ? "cancelled" : item.status === "failed" ? "failed" : "completed";
      return { itemId: item.itemId, revision: item.revision, status };
    }
  }
  return undefined;
}

export function isTinyOsCommandPending(state: TinyOsCommandLifecycle): boolean {
  return state.stage === "sending" || state.stage === "waiting_for_canonical";
}

export function isTinyOsCommandInFlight(state: TinyOsCommandLifecycle): boolean {
  return isTinyOsCommandPending(state) || state.stage === "acknowledged";
}

function createTinyOsCommandId(): string {
  return `tinyos-command-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
