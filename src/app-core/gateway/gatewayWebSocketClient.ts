import { DEFAULT_GATEWAY_CONFIG, type GatewayConfig } from "./gatewayConfig";
import { logDesktopNativeChatDebug, summarizeDebugText } from "../native/desktopNativeChatDebug";
import type { NativeChatReference } from "../chat/nativeChat";
import type { TinyOsAgentCancelCommand, TinyOsApprovalResolveCommand, TinyOsFormCancelCommand, TinyOsFormSubmitCommand } from "../chat/tinyOsCommandGateway";

export const createGatewaySocketMessage = {
  newChat: () => ({ type: "new_chat" as const }),
  attach: (chatId: string) => ({ type: "attach" as const, chat_id: chatId }),
  message: (chatId: string, content: string, usePersistentRag?: boolean, model?: string, clientEventId?: string, references?: NativeChatReference[]) => ({
    type: "message" as const,
    chat_id: chatId,
    ...(clientEventId ? { client_event_id: clientEventId } : {}),
    content,
    ...(references?.length ? { references } : {}),
    ...(typeof usePersistentRag === "boolean" ? { use_persistent_rag: usePersistentRag } : {}),
    ...(model ? { model } : {}),
  }),
  interrupt: (chatId: string, command: TinyOsAgentCancelCommand) => ({
    type: "interrupt" as const,
    chat_id: chatId,
    command_id: command.commandId,
    command_kind: command.kind,
    run_id: command.target.runId,
    session_id: command.target.sessionId,
    ...(command.target.threadId ? { thread_id: command.target.threadId } : {}),
    ...(command.target.turnId ? { turn_id: command.target.turnId } : {}),
    source: command.source,
  }),
  command: (chatId: string, command: TinyOsApprovalResolveCommand | TinyOsFormCancelCommand | TinyOsFormSubmitCommand) => {
    const envelope = {
      type: "command" as const,
      chat_id: chatId,
      command_id: command.commandId,
      command_kind: command.kind,
      run_id: command.target.runId,
      session_id: command.target.sessionId,
      ...(command.target.threadId ? { thread_id: command.target.threadId } : {}),
      ...(command.target.turnId ? { turn_id: command.target.turnId } : {}),
      source: command.source,
    };
    if (command.kind === "approval.resolve") return {
      ...envelope,
      approval_id: command.approval.approvalId,
      approved: command.approval.approved,
      scope: command.approval.scope,
      ...(command.approval.guidance ? { guidance: command.approval.guidance } : {}),
    };
    const formEnvelope = {
      ...envelope,
      form_id: command.form.formId,
    };
    return command.kind === "form.submit" ? {
      ...formEnvelope,
      values: command.form.values,
    } : formEnvelope;
  },
};

export type NormalizedGatewayEvent =
  | { kind: "attached"; chatId: string; raw: Record<string, unknown> }
  | { kind: "chat.created"; chatId: string; raw: Record<string, unknown> }
  | { kind: "agent.event"; chatId?: string; raw: Record<string, unknown> }
  | { kind: "usage"; chatId?: string; tokenUsage: string; usage?: Record<string, unknown>; raw: Record<string, unknown> }
  | { kind: "browser.frame"; raw: Record<string, unknown> }
  | { kind: "browser.snapshot"; raw: Record<string, unknown> }
  | { kind: "agent-ui.form"; raw: Record<string, unknown> }
  | { kind: "agent-ui.event"; eventType: string; raw: Record<string, unknown> }
  | { kind: "interrupted"; chatId?: string; cancelled: boolean; raw: Record<string, unknown> }
  | { kind: "command.accepted"; chatId?: string; commandId: string; raw: Record<string, unknown> }
  | { kind: "command.canonical-updated"; chatId?: string; commandId: string; raw: Record<string, unknown> }
  | { kind: "error"; commandId?: string; message: string; raw: Record<string, unknown> }
  | { kind: "unknown"; event?: string; raw: Record<string, unknown> };

export function normalizeGatewayFrame(frame: unknown): NormalizedGatewayEvent {
  const raw = isRecord(frame) ? frame : {};
  const event = stringValue(raw.event);
  switch (event) {
    case "attached":
      return { kind: "attached", chatId: stringValue(raw.chat_id), raw };
    case "chat_created":
      return { kind: "chat.created", chatId: stringValue(raw.chat_id), raw };
    case "agent_event":
      return { kind: "agent.event", chatId: optionalString(raw.chat_id), raw };
    case "usage":
      return {
        kind: "usage",
        chatId: optionalString(raw.chat_id),
        tokenUsage: formatTokenUsage(raw.usage),
        ...(isRecord(raw.usage) ? { usage: raw.usage } : {}),
        raw,
      };
    case "browser_frame":
      return { kind: "browser.frame", raw };
    case "browser_snapshot":
      return { kind: "browser.snapshot", raw };
    case "agent_ui_form":
    case "form_request":
      return { kind: "agent-ui.form", raw };
    case "agent_ui_event": {
      const payload = isRecord(raw.agent_ui_event) ? raw.agent_ui_event : {};
      const eventType = stringValue(payload.event_type ?? payload.type);
      const eventPayload = isRecord(payload.payload) ? payload.payload : {};
      if (eventType === "usage.updated") {
        const usage = isRecord(eventPayload.usage) ? eventPayload.usage : eventPayload;
        return {
          kind: "usage",
          chatId: optionalString(payload.chat_id) ?? optionalString(raw.chat_id),
          tokenUsage: formatTokenUsage(usage),
          usage,
          raw,
        };
      }
      return { kind: "agent-ui.event", eventType: stringValue(payload.event_type), raw };
    }
    case "interrupted":
      return {
        kind: "interrupted",
        chatId: optionalString(raw.chat_id),
        cancelled: raw.cancelled === true,
        raw,
      };
    case "command_accepted":
      return {
        kind: "command.accepted",
        chatId: optionalString(raw.chat_id),
        commandId: stringValue(raw.command_id ?? raw.commandId),
        raw,
      };
    case "command_canonical_updated":
      return {
        kind: "command.canonical-updated",
        chatId: optionalString(raw.chat_id),
        commandId: stringValue(raw.command_id ?? raw.commandId),
        raw,
      };
    case "error":
      return {
        kind: "error",
        ...(optionalString(raw.command_id ?? raw.commandId) ? { commandId: optionalString(raw.command_id ?? raw.commandId) } : {}),
        message: stringValue(raw.message),
        raw,
      };
    default:
      return { kind: "unknown", event: optionalString(raw.event), raw };
  }
}

export type GatewaySocketHandlers = {
  onEvent: (event: NormalizedGatewayEvent) => void;
  onOpen?: () => void;
  onClose?: () => void;
  onError?: (error: Event) => void;
};

export type JsonSocket = {
  readyState: number;
  send: (value: string) => void;
};

export function openGatewaySocket(config: GatewayConfig = DEFAULT_GATEWAY_CONFIG, handlers: GatewaySocketHandlers): WebSocket {
  const socket = new WebSocket(config.wsUrl);
  socket.addEventListener("open", () => handlers.onOpen?.());
  socket.addEventListener("close", () => handlers.onClose?.());
  socket.addEventListener("error", (event) => handlers.onError?.(event));
  socket.addEventListener("message", (event) => {
    try {
      const raw = JSON.parse(String(event.data));
      const normalized = normalizeGatewayFrame(raw);
      const messageId = "messageId" in normalized && typeof normalized.messageId === "string" ? normalized.messageId : "";
      const text = "text" in normalized && typeof normalized.text === "string" ? normalized.text : "";
      const tokenUsage = "tokenUsage" in normalized ? normalized.tokenUsage : "";
      logDesktopNativeChatDebug("socket.frame", {
        chatId: "chatId" in normalized ? normalized.chatId : "",
        event: isRecord(raw) ? stringValue(raw.event) : "",
        kind: normalized.kind,
        messageId,
        text: text ? summarizeDebugText(text) : undefined,
        tokenUsage: tokenUsage || undefined,
      });
      handlers.onEvent(normalized);
    } catch {
      logDesktopNativeChatDebug("socket.frame", { error: "invalid websocket json" });
      handlers.onEvent({ kind: "error", message: "invalid websocket json", raw: {} });
    }
  });
  return socket;
}

export function sendGatewaySocketJson(socket: JsonSocket | null, message: unknown, queue: unknown[]): "sent" | "queued" {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    queue.push(message);
    logDesktopNativeChatDebug("socket.send", summarizeSocketMessage(message, "queued", queue.length));
    return "queued";
  }
  socket.send(JSON.stringify(message));
  logDesktopNativeChatDebug("socket.send", summarizeSocketMessage(message, "sent", queue.length));
  return "sent";
}

export function flushGatewaySocketQueue(socket: JsonSocket | null, queue: unknown[]): number {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return 0;
  }
  let count = 0;
  while (queue.length) {
    const message = queue.shift();
    socket.send(JSON.stringify(message));
    count += 1;
  }
  return count;
}

function summarizeSocketMessage(
  message: unknown,
  status: "queued" | "sent",
  queueLength: number,
): Record<string, unknown> {
  const payload = isRecord(message) ? message : {};
  return {
    chatId: stringValue(payload.chat_id),
    content: summarizeDebugText(stringValue(payload.content)),
    queueLength,
    status,
    type: stringValue(payload.type),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function formatTokenUsage(value: unknown): string {
  const usage = isRecord(value) ? value : {};
  const explicitPercent = numberValue(usage.percent ?? usage.percentage ?? usage.token_usage_percent ?? usage.tokenUsagePercent);
  const total = numberValue(usage.total_tokens ?? usage.totalTokens ?? usage.total) ?? 0;
  const contextWindow = numberValue(
    usage.context_window_tokens ??
    usage.contextWindowTokens ??
    usage.context_window ??
    usage.contextWindow ??
    usage.max_context_tokens ??
    usage.maxContextTokens,
  );
  const percent = explicitPercent ?? (contextWindow && contextWindow > 0 ? (total / contextWindow) * 100 : null);
  if (contextWindow === null) {
    return total > 0 ? `${total} tokens` : explicitPercent !== null ? `${boundedPercent(explicitPercent)}%` : "-";
  }
  if (contextWindow <= 0) {
    return total > 0 ? `${total} tokens` : "0%";
  }
  return `${total} / ${contextWindow} tokens (${boundedPercent(percent ?? 0)}%)`;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function boundedPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}
