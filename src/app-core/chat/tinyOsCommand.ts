import type { ChatTurn } from "./chatTurnContracts";

export const TINYOS_COMMAND_ACK_TIMEOUT_MS = 5_000;

export const TINYOS_COMMAND_KINDS = [
  "agent.cancel",
  "form.submit",
  "form.cancel",
  "operation.retry",
] as const;

export type TinyOsCommandSource = {
  control: string;
  surface: "chat";
};

type TinyOsCommandTarget = {
  turnId: string;
  sessionId: string;
  threadId?: string;
};

export type TinyOsAgentCancelCommand = {
  schemaVersion: "tinybot.command.v1";
  commandId: string;
  issuedAt: string;
  kind: "agent.cancel";
  source: TinyOsCommandSource;
  target: TinyOsCommandTarget;
};

export type TinyOsFormSubmitCommand = {
  schemaVersion: "tinybot.command.v1";
  commandId: string;
  issuedAt: string;
  kind: "form.submit";
  source: TinyOsCommandSource;
  target: TinyOsCommandTarget;
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
  target: TinyOsCommandTarget;
  form: {
    formId: string;
  };
};

export type TinyOsOperationRetryCommand = {
  schemaVersion: "tinybot.command.v1";
  commandId: string;
  issuedAt: string;
  kind: "operation.retry";
  source: TinyOsCommandSource;
  target: TinyOsCommandTarget;
  operation: {
    itemId: string;
    turnId: string;
  };
};

export type TinyOsCommand =
  | TinyOsAgentCancelCommand
  | TinyOsFormSubmitCommand
  | TinyOsFormCancelCommand
  | TinyOsOperationRetryCommand;

export type TinyOsHostCommand = TinyOsOperationRetryCommand;

export function toNativeTinyOsHostCommandFrame(
  sessionId: string,
  command: TinyOsHostCommand,
) {
  return {
    type: "command" as const,
    chat_id: sessionId,
    command_id: command.commandId,
    command_kind: command.kind,
    turn_id: command.target.turnId,
    session_id: command.target.sessionId,
    ...(command.target.threadId ? { thread_id: command.target.threadId } : {}),
    source: command.source,
    source_turn_id: command.operation.turnId,
    item_id: command.operation.itemId,
  };
}

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
  turnId: string;
  sessionId: string;
  source: TinyOsCommandSource;
  threadId?: string;
}): TinyOsAgentCancelCommand {
  return {
    schemaVersion: "tinybot.command.v1",
    commandId: input.commandId ?? createTinyOsCommandId(),
    issuedAt: input.issuedAt ?? new Date().toISOString(),
    kind: "agent.cancel",
    source: input.source,
    target: commandTarget(input.turnId, input.sessionId, input.threadId),
  };
}

export function createTinyOsFormSubmitCommand(input: {
  commandId?: string;
  formId: string;
  issuedAt?: string;
  turnId: string;
  sessionId: string;
  source: TinyOsCommandSource;
  threadId?: string;
  values: Record<string, unknown>;
}): TinyOsFormSubmitCommand {
  return {
    schemaVersion: "tinybot.command.v1",
    commandId: input.commandId ?? createTinyOsCommandId(),
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

export function createTinyOsFormCancelCommand(input: {
  commandId?: string;
  formId: string;
  issuedAt?: string;
  turnId: string;
  sessionId: string;
  source: TinyOsCommandSource;
  threadId?: string;
}): TinyOsFormCancelCommand {
  return {
    schemaVersion: "tinybot.command.v1",
    commandId: input.commandId ?? createTinyOsCommandId(),
    issuedAt: input.issuedAt ?? new Date().toISOString(),
    kind: "form.cancel",
    source: input.source,
    target: commandTarget(input.turnId, input.sessionId, input.threadId),
    form: {
      formId: input.formId,
    },
  };
}

export function createTinyOsOperationRetryCommand(input: {
  commandId?: string;
  issuedAt?: string;
  itemId: string;
  retryTurnId?: string;
  sessionId: string;
  source: TinyOsCommandSource;
  threadId?: string;
  turnId: string;
}): TinyOsOperationRetryCommand {
  return {
    schemaVersion: "tinybot.command.v1",
    commandId: input.commandId ?? createTinyOsCommandId(),
    issuedAt: input.issuedAt ?? new Date().toISOString(),
    kind: "operation.retry",
    source: input.source,
    target: commandTarget(
      input.retryTurnId ?? createTinyOsRetryTurnId(),
      input.sessionId,
      input.threadId,
    ),
    operation: {
      itemId: input.itemId,
      turnId: input.turnId,
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
      if ((directCommandId === commandId || detailCommandId === commandId)
        && commandStatus === "acknowledged") {
        return { itemId: item.itemId, revision: item.revision };
      }
    }
  }
  return undefined;
}

export function canonicalTinyOsCommandCompletion(
  turns: ChatTurn[],
  command: TinyOsCommand | string,
): TinyOsCommandCompletion | undefined {
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

export function isTinyOsCommandPending(state: TinyOsCommandLifecycle): boolean {
  return state.stage === "sending" || state.stage === "waiting_for_canonical";
}

export function isTinyOsCommandInFlight(state: TinyOsCommandLifecycle): boolean {
  return isTinyOsCommandPending(state) || state.stage === "acknowledged";
}

function commandTarget(
  turnId: string,
  sessionId: string,
  threadId?: string,
): TinyOsCommandTarget {
  return {
    turnId,
    sessionId,
    ...(threadId ? { threadId } : {}),
  };
}

function createTinyOsCommandId(): string {
  return "tinyos-command-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

function createTinyOsRetryTurnId(): string {
  return "tinyos-retry-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
