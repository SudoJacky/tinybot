import type { ChatTurn } from "./chatTurnModel";
import type { NativeChatReference } from "./nativeChat";

export const TINYOS_COMMAND_ACK_TIMEOUT_MS = 5_000;

export const TINYOS_COMMAND_KINDS = [
  "agent.cancel",
  "agent.pause",
  "agent.resume",
  "approval.resolve",
  "form.submit",
  "form.cancel",
  "operation.retry",
  "agent.request_change",
  "file.save",
  "file.move",
  "file.delete",
  "terminal.execute",
  "terminal.cancel",
  "browser.interact",
] as const;

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
    turnId: string;
    sessionId: string;
    threadId?: string;
  };
};

export type TinyOsApprovalResolveCommand = {
  schemaVersion: "tinybot.command.v1";
  commandId: string;
  issuedAt: string;
  kind: "approval.resolve";
  source: TinyOsCommandSource;
  target: {
    turnId: string;
    sessionId: string;
    threadId?: string;
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
    turnId: string;
    sessionId: string;
    threadId?: string;
  };
  form: {
    formId: string;
    values: Record<string, unknown>;
  };
};

export type TinyOsAgentTurnControlCommand = {
  schemaVersion: "tinybot.command.v1";
  commandId: string;
  issuedAt: string;
  kind: "agent.pause" | "agent.resume";
  source: TinyOsCommandSource;
  target: {
    turnId: string;
    sessionId: string;
    threadId?: string;
  };
};

export type TinyOsFormCancelCommand = {
  schemaVersion: "tinybot.command.v1";
  commandId: string;
  issuedAt: string;
  kind: "form.cancel";
  source: TinyOsCommandSource;
  target: {
    turnId: string;
    sessionId: string;
    threadId?: string;
  };
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
  target: {
    turnId: string;
    sessionId: string;
    threadId?: string;
  };
  operation: {
    itemId: string;
    turnId: string;
  };
};

export type TinyOsAgentRequestChangeCommand = {
  schemaVersion: "tinybot.command.v1";
  commandId: string;
  issuedAt: string;
  kind: "agent.request_change";
  source: TinyOsCommandSource;
  target: {
    turnId: string;
    sessionId: string;
    threadId?: string;
  };
  request: {
    instruction: string;
    observedTurnId?: string;
    references: NativeChatReference[];
  };
};

export type TinyOsFileSaveCommand = {
  schemaVersion: "tinybot.command.v1";
  commandId: string;
  issuedAt: string;
  kind: "file.save";
  source: TinyOsCommandSource;
  target: { operationId: string; sessionId: string; threadId?: string };
  file: {
    baseRevision?: string;
    confirmed: true;
    content: string;
    createOnly: boolean;
    path: string;
  };
};

export type TinyOsFileMoveCommand = {
  schemaVersion: "tinybot.command.v1";
  commandId: string;
  issuedAt: string;
  kind: "file.move";
  source: TinyOsCommandSource;
  target: { operationId: string; sessionId: string; threadId?: string };
  file: { baseRevision: string; confirmed: true; path: string; targetPath: string };
};

export type TinyOsFileDeleteCommand = {
  schemaVersion: "tinybot.command.v1";
  commandId: string;
  issuedAt: string;
  kind: "file.delete";
  source: TinyOsCommandSource;
  target: { operationId: string; sessionId: string; threadId?: string };
  file: { baseRevision: string; confirmed: true; path: string };
};

export type TinyOsTerminalExecuteCommand = {
  schemaVersion: "tinybot.command.v1";
  commandId: string;
  issuedAt: string;
  kind: "terminal.execute";
  source: TinyOsCommandSource;
  target: { operationId: string; sessionId: string; threadId?: string };
  terminal: { command: string; confirmed: true; cwd?: string };
};

export type TinyOsTerminalCancelCommand = {
  schemaVersion: "tinybot.command.v1";
  commandId: string;
  issuedAt: string;
  kind: "terminal.cancel";
  source: TinyOsCommandSource;
  target: { operationId: string; sessionId: string; threadId?: string };
};

export type TinyOsBrowserAction =
  | { type: "click"; x: number; y: number }
  | { type: "clickTarget"; targetRef: string }
  | { type: "navigate"; url: string }
  | { type: "type"; text: string }
  | { type: "fill"; targetRef: string; text: string }
  | { type: "key"; key: string }
  | { type: "scroll"; deltaX: number; deltaY: number }
  | { type: "wait"; targetRef?: string; text?: string; timeoutMs: number }
  | { type: "back" | "forward" | "reload" | "stop" | "resume" }
  | { type: "userHandoff"; reason: string };

export type TinyOsBrowserInteractCommand = {
  schemaVersion: "tinybot.command.v1";
  commandId: string;
  issuedAt: string;
  kind: "browser.interact";
  source: TinyOsCommandSource;
  target: { operationId: string; sessionId: string; threadId?: string };
  browser: {
    action: TinyOsBrowserAction;
    browserSessionId: string;
    captureId: string;
    confirmed: true;
    controlEpoch: number;
    observationRevision: number;
    tabId: string;
  };
};

export type TinyOsCommand = TinyOsAgentCancelCommand
  | TinyOsAgentTurnControlCommand
  | TinyOsApprovalResolveCommand
  | TinyOsFormSubmitCommand
  | TinyOsFormCancelCommand
  | TinyOsOperationRetryCommand
  | TinyOsAgentRequestChangeCommand
  | TinyOsFileSaveCommand
  | TinyOsFileMoveCommand
  | TinyOsFileDeleteCommand
  | TinyOsTerminalExecuteCommand
  | TinyOsTerminalCancelCommand
  | TinyOsBrowserInteractCommand;

export type TinyOsHostCommand = Exclude<
  TinyOsCommand,
  TinyOsAgentCancelCommand | TinyOsApprovalResolveCommand | TinyOsFormSubmitCommand | TinyOsFormCancelCommand
>;

export type TinyOsDirectHostCommand =
  | TinyOsFileSaveCommand
  | TinyOsFileMoveCommand
  | TinyOsFileDeleteCommand
  | TinyOsTerminalExecuteCommand
  | TinyOsTerminalCancelCommand
  | TinyOsBrowserInteractCommand;

export function toNativeTinyOsHostCommandFrame(sessionId: string, command: TinyOsHostCommand) {
  const targetIdentity = "operationId" in command.target
    ? { operation_id: command.target.operationId }
    : { turn_id: command.target.turnId };
  const envelope = {
    type: "command" as const,
    chat_id: sessionId,
    command_id: command.commandId,
    command_kind: command.kind,
    ...targetIdentity,
    session_id: command.target.sessionId,
    ...(command.target.threadId ? { thread_id: command.target.threadId } : {}),
    source: command.source,
  };
  if (command.kind === "operation.retry") return {
    ...envelope,
    source_turn_id: command.operation.turnId,
    item_id: command.operation.itemId,
  };
  if (command.kind === "agent.pause" || command.kind === "agent.resume") return envelope;
  if (command.kind === "agent.request_change") return {
    ...envelope,
    instruction: command.request.instruction,
    ...(command.request.observedTurnId ? { observed_turn_id: command.request.observedTurnId } : {}),
    references: command.request.references,
  };
  if (command.kind === "file.save") return {
    ...envelope,
    path: command.file.path,
    content: command.file.content,
    create_only: command.file.createOnly,
    confirmed: command.file.confirmed,
    ...(command.file.baseRevision ? { base_revision: command.file.baseRevision } : {}),
  };
  if (command.kind === "file.move") return {
    ...envelope,
    path: command.file.path,
    target_path: command.file.targetPath,
    base_revision: command.file.baseRevision,
    confirmed: command.file.confirmed,
  };
  if (command.kind === "file.delete") return {
    ...envelope,
    path: command.file.path,
    base_revision: command.file.baseRevision,
    confirmed: command.file.confirmed,
  };
  if (command.kind === "terminal.execute") return {
    ...envelope,
    command: command.terminal.command,
    confirmed: command.terminal.confirmed,
    ...(command.terminal.cwd ? { cwd: command.terminal.cwd } : {}),
  };
  if (command.kind === "terminal.cancel") return envelope;
  if (command.kind === "browser.interact") return {
    ...envelope,
    action: command.browser.action,
    browser_session_id: command.browser.browserSessionId,
    capture_id: command.browser.captureId,
    confirmed: command.browser.confirmed,
    control_epoch: command.browser.controlEpoch,
    observation_revision: command.browser.observationRevision,
    tab_id: command.browser.tabId,
  };
  throw new Error(`Unsupported Native host command: ${command.kind}`);
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
  | { commandId: string; error?: string; nowMs: number; operationId: string; status: "running" | "completed" | "failed" | "cancelled"; type: "host_operation_updated" }
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
  const issuedAt = input.issuedAt ?? new Date().toISOString();
  return {
    schemaVersion: "tinybot.command.v1",
    commandId: input.commandId ?? createTinyOsCommandId(),
    issuedAt,
    kind: "agent.cancel",
    source: input.source,
    target: {
      turnId: input.turnId,
      sessionId: input.sessionId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
    },
  };
}

export function createTinyOsApprovalResolveCommand(input: {
  action: "approveOnce" | "approveSession" | "deny";
  approvalId: string;
  commandId?: string;
  guidance?: string;
  issuedAt?: string;
  turnId: string;
  sessionId: string;
  source: TinyOsCommandSource;
  threadId?: string;
}): TinyOsApprovalResolveCommand {
  const guidance = input.guidance?.trim();
  return {
    schemaVersion: "tinybot.command.v1",
    commandId: input.commandId ?? createTinyOsCommandId(),
    issuedAt: input.issuedAt ?? new Date().toISOString(),
    kind: "approval.resolve",
    source: input.source,
    target: {
      turnId: input.turnId,
      sessionId: input.sessionId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
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
    target: {
      turnId: input.turnId,
      sessionId: input.sessionId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
    },
    form: {
      formId: input.formId,
      values: { ...input.values },
    },
  };
}

export function createTinyOsAgentTurnControlCommand(input: {
  commandId?: string;
  issuedAt?: string;
  kind: "agent.pause" | "agent.resume";
  turnId: string;
  sessionId: string;
  source: TinyOsCommandSource;
  threadId?: string;
}): TinyOsAgentTurnControlCommand {
  return {
    schemaVersion: "tinybot.command.v1",
    commandId: input.commandId ?? createTinyOsCommandId(),
    issuedAt: input.issuedAt ?? new Date().toISOString(),
    kind: input.kind,
    source: input.source,
    target: {
      turnId: input.turnId,
      sessionId: input.sessionId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
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
    target: {
      turnId: input.turnId,
      sessionId: input.sessionId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
    },
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
    target: {
      turnId: input.retryTurnId ?? createTinyOsRetryTurnId(),
      sessionId: input.sessionId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
    },
    operation: {
      itemId: input.itemId,
      turnId: input.turnId,
    },
  };
}

export function createTinyOsAgentRequestChangeCommand(input: {
  commandId?: string;
  instruction: string;
  issuedAt?: string;
  observedTurnId?: string;
  references: NativeChatReference[];
  requestTurnId?: string;
  sessionId: string;
  source: TinyOsCommandSource;
  threadId?: string;
}): TinyOsAgentRequestChangeCommand {
  const instruction = input.instruction.trim();
  if (!instruction) throw new Error("Agent change request instruction is required.");
  if (!input.references.length) throw new Error("Agent change request requires at least one reference.");
  return {
    schemaVersion: "tinybot.command.v1",
    commandId: input.commandId ?? createTinyOsCommandId(),
    issuedAt: input.issuedAt ?? new Date().toISOString(),
    kind: "agent.request_change",
    source: input.source,
    target: {
      turnId: input.requestTurnId ?? createTinyOsFollowupTurnId("request"),
      sessionId: input.sessionId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
    },
    request: {
      instruction,
      ...(input.observedTurnId ? { observedTurnId: input.observedTurnId } : {}),
      references: input.references.map((reference) => ({ ...reference })),
    },
  };
}

export function createTinyOsFileSaveCommand(input: {
  baseRevision?: string;
  commandId?: string;
  content: string;
  createOnly?: boolean;
  issuedAt?: string;
  path: string;
  sessionId: string;
  source: TinyOsCommandSource;
  threadId?: string;
}): TinyOsFileSaveCommand {
  const path = requiredHostText(input.path, "File path");
  if (!input.createOnly && !input.baseRevision) throw new Error("Existing file saves require a base revision.");
  return {
    schemaVersion: "tinybot.command.v1",
    commandId: input.commandId ?? createTinyOsCommandId(),
    issuedAt: input.issuedAt ?? new Date().toISOString(),
    kind: "file.save",
    source: input.source,
    target: hostCommandTarget("file", input.sessionId, input.threadId),
    file: {
      ...(input.baseRevision ? { baseRevision: input.baseRevision } : {}),
      confirmed: true,
      content: input.content,
      createOnly: Boolean(input.createOnly),
      path,
    },
  };
}

export function createTinyOsFileMoveCommand(input: {
  baseRevision: string;
  commandId?: string;
  issuedAt?: string;
  path: string;
  sessionId: string;
  source: TinyOsCommandSource;
  targetPath: string;
  threadId?: string;
}): TinyOsFileMoveCommand {
  return {
    schemaVersion: "tinybot.command.v1",
    commandId: input.commandId ?? createTinyOsCommandId(),
    issuedAt: input.issuedAt ?? new Date().toISOString(),
    kind: "file.move",
    source: input.source,
    target: hostCommandTarget("file", input.sessionId, input.threadId),
    file: {
      baseRevision: requiredHostText(input.baseRevision, "File base revision"),
      confirmed: true,
      path: requiredHostText(input.path, "Source file path"),
      targetPath: requiredHostText(input.targetPath, "Target file path"),
    },
  };
}

export function createTinyOsFileDeleteCommand(input: {
  baseRevision: string;
  commandId?: string;
  issuedAt?: string;
  path: string;
  sessionId: string;
  source: TinyOsCommandSource;
  threadId?: string;
}): TinyOsFileDeleteCommand {
  return {
    schemaVersion: "tinybot.command.v1",
    commandId: input.commandId ?? createTinyOsCommandId(),
    issuedAt: input.issuedAt ?? new Date().toISOString(),
    kind: "file.delete",
    source: input.source,
    target: hostCommandTarget("file", input.sessionId, input.threadId),
    file: {
      baseRevision: requiredHostText(input.baseRevision, "File base revision"),
      confirmed: true,
      path: requiredHostText(input.path, "File path"),
    },
  };
}

export function createTinyOsTerminalExecuteCommand(input: {
  command: string;
  commandId?: string;
  cwd?: string;
  issuedAt?: string;
  sessionId: string;
  source: TinyOsCommandSource;
  threadId?: string;
}): TinyOsTerminalExecuteCommand {
  const cwd = input.cwd?.trim();
  return {
    schemaVersion: "tinybot.command.v1",
    commandId: input.commandId ?? createTinyOsCommandId(),
    issuedAt: input.issuedAt ?? new Date().toISOString(),
    kind: "terminal.execute",
    source: input.source,
    target: hostCommandTarget("terminal", input.sessionId, input.threadId),
    terminal: {
      command: requiredHostText(input.command, "Terminal command"),
      confirmed: true,
      ...(cwd ? { cwd } : {}),
    },
  };
}

export function createTinyOsTerminalCancelCommand(input: {
  commandId?: string;
  issuedAt?: string;
  operationId: string;
  sessionId: string;
  source: TinyOsCommandSource;
  threadId?: string;
}): TinyOsTerminalCancelCommand {
  return {
    schemaVersion: "tinybot.command.v1",
    commandId: input.commandId ?? createTinyOsCommandId(),
    issuedAt: input.issuedAt ?? new Date().toISOString(),
    kind: "terminal.cancel",
    source: input.source,
    target: {
      operationId: requiredHostText(input.operationId, "Terminal operation id"),
      sessionId: input.sessionId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
    },
  };
}

export function createTinyOsBrowserInteractCommand(input: {
  action: TinyOsBrowserAction;
  browserSessionId: string;
  captureId: string;
  controlEpoch: number;
  commandId?: string;
  issuedAt?: string;
  sessionId: string;
  source: TinyOsCommandSource;
  tabId: string;
  observationRevision: number;
  threadId?: string;
}): TinyOsBrowserInteractCommand {
  return {
    schemaVersion: "tinybot.command.v1",
    commandId: input.commandId ?? createTinyOsCommandId(),
    issuedAt: input.issuedAt ?? new Date().toISOString(),
    kind: "browser.interact",
    source: input.source,
    target: hostCommandTarget("browser", input.sessionId, input.threadId),
    browser: {
      action: { ...input.action },
      browserSessionId: requiredHostText(input.browserSessionId, "Browser session id"),
      captureId: requiredHostText(input.captureId, "Browser capture id"),
      confirmed: true,
      controlEpoch: requiredNonNegativeInteger(input.controlEpoch, "Browser control epoch"),
      observationRevision: requiredNonNegativeInteger(input.observationRevision, "Browser observation revision"),
      tabId: requiredHostText(input.tabId, "Browser tab id"),
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
  if (action.type === "host_operation_updated") {
    const acknowledgement = { itemId: action.operationId, revision: 0 };
    if (action.status === "running") {
      return {
        acknowledgement,
        acknowledgedAtMs: action.nowMs,
        command: state.command,
        dispatchedAtMs: state.dispatchedAtMs,
        stage: "acknowledged",
      };
    }
    return {
      acknowledgement,
      command: state.command,
      completedAtMs: action.nowMs,
      completion: {
        ...acknowledgement,
        status: action.status,
      },
      dispatchedAtMs: state.dispatchedAtMs,
      stage: "completed",
    };
  }
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
    if (state.command.kind === "approval.resolve") {
      return {
        acknowledgement: { itemId: state.command.approval.approvalId, revision: 0 },
        acknowledgedAtMs: action.nowMs,
        command: state.command,
        dispatchedAtMs: state.dispatchedAtMs,
        stage: "acknowledged",
      };
    }
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
      const correlated = directCommandId === commandId || detailCommandId === commandId;
      const resolvedApproval = item.kind === "approval" && item.status === "completed";
      if (correlated && (commandStatus === "acknowledged" || resolvedApproval)) {
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
  if (typeof command !== "string" && (command.kind === "operation.retry" || command.kind === "agent.request_change")) {
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
      status: turn.status === "completed" ? "completed" : turn.status === "failed" ? "failed" : "cancelled",
    };
  }
  if (typeof command !== "string" && (command.kind === "agent.pause" || command.kind === "agent.resume")) {
    const turn = turns.find((candidate) => candidate.id === command.target.turnId);
    const item = [...(turn?.canonicalItems ?? [])].reverse().find((candidate) => {
      if (candidate.kind !== "system_notice" || candidate.status !== "completed") return false;
      const data = recordValue(candidate.data);
      const detail = recordValue(data.detail);
      return detail.commandId === command.commandId && detail.commandStatus !== "acknowledged";
    });
    if (!item) return undefined;
    return { itemId: item.itemId, revision: item.revision, status: item.status === "failed" ? "failed" : item.status === "cancelled" ? "cancelled" : "completed" };
  }
  const commandId = typeof command === "string" ? command : command.commandId;
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
  return isTinyOsCommandPending(state)
    || (state.stage === "acknowledged" && state.command.kind !== "approval.resolve");
}

function createTinyOsCommandId(): string {
  return `tinyos-command-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function createTinyOsRetryTurnId(): string {
  return createTinyOsFollowupTurnId("retry");
}

function createTinyOsFollowupTurnId(kind: string): string {
  return `tinyos-${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function hostCommandTarget(kind: "browser" | "file" | "terminal", sessionId: string, threadId?: string) {
  return {
    operationId: `tinyos-host-${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    sessionId,
    ...(threadId ? { threadId } : {}),
  };
}

function requiredHostText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

function requiredNonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer.`);
  return value;
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
