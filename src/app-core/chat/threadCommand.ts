import type { ChatTurn } from "./chatTurnContracts";

export const THREAD_COMMAND_ACK_TIMEOUT_MS = 5_000;

export const THREAD_COMMAND_KINDS = [
  "agent.cancel",
  "form.submit",
  "form.cancel",
  "operation.retry",
] as const;

export type ThreadCommandSource = {
  control: string;
  surface: "chat";
};

type ThreadCommandTarget = {
  turnId: string;
  sessionId: string;
  threadId?: string;
};

export type ThreadAgentCancelCommand = {
  schemaVersion: "tinybot.command.v1";
  commandId: string;
  issuedAt: string;
  kind: "agent.cancel";
  source: ThreadCommandSource;
  target: ThreadCommandTarget;
};

export type ThreadFormSubmitCommand = {
  schemaVersion: "tinybot.command.v1";
  commandId: string;
  issuedAt: string;
  kind: "form.submit";
  source: ThreadCommandSource;
  target: ThreadCommandTarget;
  form: {
    formId: string;
    values: Record<string, unknown>;
  };
};

export type ThreadFormCancelCommand = {
  schemaVersion: "tinybot.command.v1";
  commandId: string;
  issuedAt: string;
  kind: "form.cancel";
  source: ThreadCommandSource;
  target: ThreadCommandTarget;
  form: {
    formId: string;
  };
};

export type ThreadOperationRetryCommand = {
  schemaVersion: "tinybot.command.v1";
  commandId: string;
  issuedAt: string;
  kind: "operation.retry";
  source: ThreadCommandSource;
  target: ThreadCommandTarget;
  operation: {
    itemId: string;
    turnId: string;
  };
};

export type ThreadCommand =
  | ThreadAgentCancelCommand
  | ThreadFormSubmitCommand
  | ThreadFormCancelCommand
  | ThreadOperationRetryCommand;

export type ThreadCommandAcknowledgement = {
  itemId: string;
  revision: number;
};

export type ThreadCommandCompletion = ThreadCommandAcknowledgement & {
  status: "completed" | "failed" | "cancelled";
};

export type ThreadCommandLifecycle =
  | { stage: "idle" }
  | { command: ThreadCommand; dispatchedAtMs: number; stage: "sending" }
  | { command: ThreadCommand; dispatchedAtMs: number; transportAcceptedAtMs: number; stage: "waiting_for_canonical" }
  | { acknowledgement: ThreadCommandAcknowledgement; command: ThreadCommand; acknowledgedAtMs: number; dispatchedAtMs: number; stage: "acknowledged" }
  | { acknowledgement: ThreadCommandAcknowledgement; command: ThreadCommand; completedAtMs: number; completion: ThreadCommandCompletion; dispatchedAtMs: number; stage: "completed" }
  | { command: ThreadCommand; dispatchedAtMs: number; error: string; stage: "rejected" }
  | { command: ThreadCommand; dispatchedAtMs: number; error: string; stage: "timed_out" };

export type ThreadCommandLifecycleAction =
  | { command: ThreadCommand; nowMs: number; type: "dispatch" }
  | { commandId: string; nowMs: number; type: "transport_accepted" }
  | { acknowledgement: ThreadCommandAcknowledgement; commandId: string; nowMs: number; type: "canonical_acknowledged" }
  | { commandId: string; completion: ThreadCommandCompletion; nowMs: number; type: "operation_completed" }
  | { commandId: string; error: string; type: "rejected" }
  | { commandId: string; type: "ack_timeout" }
  | { type: "reset" };

export function createThreadAgentCancelCommand(input: {
  commandId?: string;
  issuedAt?: string;
  turnId: string;
  sessionId: string;
  source: ThreadCommandSource;
  threadId?: string;
}): ThreadAgentCancelCommand {
  return {
    schemaVersion: "tinybot.command.v1",
    commandId: input.commandId ?? createThreadCommandId(),
    issuedAt: input.issuedAt ?? new Date().toISOString(),
    kind: "agent.cancel",
    source: input.source,
    target: commandTarget(input.turnId, input.sessionId, input.threadId),
  };
}

export function createThreadFormSubmitCommand(input: {
  commandId?: string;
  formId: string;
  issuedAt?: string;
  turnId: string;
  sessionId: string;
  source: ThreadCommandSource;
  threadId?: string;
  values: Record<string, unknown>;
}): ThreadFormSubmitCommand {
  return {
    schemaVersion: "tinybot.command.v1",
    commandId: input.commandId ?? createThreadCommandId(),
    issuedAt: input.issuedAt ?? new Date().toISOString(),
    kind: "form.submit",
    source: input.source,
    target: commandTarget(input.turnId, input.sessionId, input.threadId),
    form: {
      formId: input.formId,
      values: { ...input.values },
    },
  };
}

export function createThreadFormCancelCommand(input: {
  commandId?: string;
  formId: string;
  issuedAt?: string;
  turnId: string;
  sessionId: string;
  source: ThreadCommandSource;
  threadId?: string;
}): ThreadFormCancelCommand {
  return {
    schemaVersion: "tinybot.command.v1",
    commandId: input.commandId ?? createThreadCommandId(),
    issuedAt: input.issuedAt ?? new Date().toISOString(),
    kind: "form.cancel",
    source: input.source,
    target: commandTarget(input.turnId, input.sessionId, input.threadId),
    form: {
      formId: input.formId,
    },
  };
}

export function createThreadOperationRetryCommand(input: {
  commandId?: string;
  issuedAt?: string;
  itemId: string;
  retryTurnId?: string;
  sessionId: string;
  source: ThreadCommandSource;
  threadId?: string;
  turnId: string;
}): ThreadOperationRetryCommand {
  return {
    schemaVersion: "tinybot.command.v1",
    commandId: input.commandId ?? createThreadCommandId(),
    issuedAt: input.issuedAt ?? new Date().toISOString(),
    kind: "operation.retry",
    source: input.source,
    target: commandTarget(
      input.retryTurnId ?? createOperationRetryTurnId(),
      input.sessionId,
      input.threadId,
    ),
    operation: {
      itemId: input.itemId,
      turnId: input.turnId,
    },
  };
}

export function reduceThreadCommandLifecycle(
  state: ThreadCommandLifecycle,
  action: ThreadCommandLifecycleAction,
): ThreadCommandLifecycle {
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
    return {
      command: state.command,
      dispatchedAtMs: state.dispatchedAtMs,
      error: action.error,
      stage: "rejected",
    };
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

export function canonicalThreadCommandAcknowledgement(
  turns: ChatTurn[],
  commandId: string,
): ThreadCommandAcknowledgement | undefined {
  for (const turn of turns) {
    for (const item of turn.canonicalItems ?? []) {
      const directCommandId = stringValue(item.data.commandId ?? item.data.command_id);
      const detail = recordValue(item.data.detail);
      const detailCommandId = stringValue(detail.commandId ?? detail.command_id);
      const commandStatus = stringValue(detail.commandStatus ?? detail.command_status);
      if ((directCommandId === commandId || detailCommandId === commandId)
        && commandStatus === "acknowledged") {
        return { itemId: item.itemId, revision: item.revision };
      }
    }
  }
  return undefined;
}

export function canonicalThreadCommandCompletion(
  turns: ChatTurn[],
  command: ThreadCommand | string,
): ThreadCommandCompletion | undefined {
  if (typeof command !== "string" && command.kind === "operation.retry") {
    const turn = turns.find((candidate) => candidate.id === command.target.turnId);
    if (!turn || !["completed", "failed", "interrupted"].includes(turn.status)) return undefined;
    const item = [...(turn.canonicalItems ?? [])].reverse().find((candidate) => {
      const detail = recordValue(candidate.data.detail);
      return stringValue(detail.commandStatus ?? detail.command_status) !== "acknowledged"
        && ["completed", "failed", "cancelled"].includes(candidate.status);
    });
    if (!item) return undefined;
    return {
      itemId: item.itemId,
      revision: item.revision,
      status: turn.status === "completed"
        ? "completed"
        : turn.status === "failed" ? "failed" : "cancelled",
    };
  }
  const commandId = typeof command === "string" ? command : command.commandId;
  for (const turn of turns) {
    for (const item of turn.canonicalItems ?? []) {
      const detail = recordValue(item.data.detail);
      const itemCommandId = stringValue(item.data.commandId ?? item.data.command_id)
        || stringValue(detail.commandId ?? detail.command_id);
      if (itemCommandId !== commandId
        || stringValue(detail.commandStatus ?? detail.command_status) === "acknowledged") {
        continue;
      }
      const status = item.status === "cancelled"
        ? "cancelled"
        : item.status === "failed" ? "failed" : "completed";
      return { itemId: item.itemId, revision: item.revision, status };
    }
  }
  return undefined;
}

export function isThreadCommandPending(state: ThreadCommandLifecycle): boolean {
  return state.stage === "sending" || state.stage === "waiting_for_canonical";
}

export function isThreadCommandInFlight(state: ThreadCommandLifecycle): boolean {
  return isThreadCommandPending(state) || state.stage === "acknowledged";
}

function commandTarget(
  turnId: string,
  sessionId: string,
  threadId?: string,
): ThreadCommandTarget {
  return {
    turnId,
    sessionId,
    ...(threadId ? { threadId } : {}),
  };
}

function createThreadCommandId(): string {
  return "thread-command-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

function createOperationRetryTurnId(): string {
  return "operation-retry-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
