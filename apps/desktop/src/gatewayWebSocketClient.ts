import { DEFAULT_GATEWAY_CONFIG, type GatewayConfig } from "./gatewayConfig";
import { logDesktopNativeChatDebug, summarizeDebugText } from "./desktopNativeChatDebug";

export const createGatewaySocketMessage = {
  newChat: () => ({ type: "new_chat" as const }),
  attach: (chatId: string) => ({ type: "attach" as const, chat_id: chatId }),
  message: (chatId: string, content: string, usePersistentRag?: boolean) => ({
    type: "message" as const,
    chat_id: chatId,
    content,
    ...(typeof usePersistentRag === "boolean" ? { use_persistent_rag: usePersistentRag } : {}),
  }),
  interrupt: (chatId: string) => ({ type: "interrupt" as const, chat_id: chatId }),
};

export type NormalizedGatewayEvent =
  | { kind: "attached"; chatId: string; raw: Record<string, unknown> }
  | { kind: "chat.created"; chatId: string; raw: Record<string, unknown> }
  | { kind: "agent.event"; chatId?: string; raw: Record<string, unknown> }
  | { kind: "message.delta"; chatId?: string; messageId?: string; text: string; reasoning: boolean; raw: Record<string, unknown> }
  | { kind: "message.completed"; chatId?: string; messageId?: string; text: string; raw: Record<string, unknown> }
  | { kind: "message.stream.completed"; chatId?: string; messageId?: string; raw: Record<string, unknown> }
  | { kind: "usage"; chatId?: string; tokenUsage: string; raw: Record<string, unknown> }
  | { kind: "browser.frame"; raw: Record<string, unknown> }
  | { kind: "browser.snapshot"; raw: Record<string, unknown> }
  | { kind: "agent-ui.form"; raw: Record<string, unknown> }
  | { kind: "agent-ui.event"; eventType: string; raw: Record<string, unknown> }
  | { kind: "interrupted"; chatId?: string; cancelled: boolean; raw: Record<string, unknown> }
  | { kind: "error"; message: string; raw: Record<string, unknown> }
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
    case "delta":
    case "message_delta":
      return {
        kind: "message.delta",
        chatId: optionalString(raw.chat_id),
        messageId: optionalString(raw.message_id),
        text: stringValue(raw.text ?? raw.delta ?? raw.content),
        reasoning: raw.reasoning === true || raw.is_reasoning === true || raw.channel === "reasoning",
        raw,
      };
    case "message":
      return {
        kind: "message.completed",
        chatId: optionalString(raw.chat_id),
        messageId: optionalString(raw.message_id),
        text: stringValue(raw.text ?? raw.content),
        raw,
      };
    case "reasoning_delta":
      return {
        kind: "message.delta",
        chatId: optionalString(raw.chat_id),
        messageId: optionalString(raw.message_id),
        text: stringValue(raw.text ?? raw.delta ?? raw.content),
        reasoning: true,
        raw,
      };
    case "stream_end":
      return {
        kind: "message.stream.completed",
        chatId: optionalString(raw.chat_id),
        messageId: optionalString(raw.message_id),
        raw,
      };
    case "cowork_stream":
      return normalizeCoworkStreamFrame(raw);
    case "cowork_mailbox_stream":
      return normalizeCoworkMailboxStreamFrame(raw);
    case "usage":
      return {
        kind: "usage",
        chatId: optionalString(raw.chat_id),
        tokenUsage: formatTokenUsage(raw.usage),
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
      if (eventType === "message.delta" || eventType === "reasoning.delta") {
        return {
          kind: "message.delta",
          chatId: optionalString(payload.chat_id) ?? optionalString(raw.chat_id),
          messageId: optionalString(payload.message_id),
          text: stringValue(eventPayload.text ?? payload.text),
          reasoning: eventType === "reasoning.delta" || eventPayload.is_reasoning === true,
          raw,
        };
      }
      if (eventType === "message.completed") {
        return {
          kind: "message.completed",
          chatId: optionalString(payload.chat_id) ?? optionalString(raw.chat_id),
          messageId: optionalString(payload.message_id),
          text: stringValue(eventPayload.text ?? payload.text),
          raw,
        };
      }
      if (eventType === "message.stream.completed") {
        return {
          kind: "message.stream.completed",
          chatId: optionalString(payload.chat_id) ?? optionalString(raw.chat_id),
          messageId: optionalString(payload.message_id),
          raw,
        };
      }
      if (eventType === "usage.updated") {
        return {
          kind: "usage",
          chatId: optionalString(payload.chat_id) ?? optionalString(raw.chat_id),
          tokenUsage: formatTokenUsage(eventPayload.usage ?? eventPayload),
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
    case "error":
      return { kind: "error", message: stringValue(raw.message), raw };
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
      logDesktopNativeChatDebug("socket.frame", {
        chatId: "chatId" in normalized ? normalized.chatId : "",
        event: isRecord(raw) ? stringValue(raw.event) : "",
        kind: normalized.kind,
        messageId: "messageId" in normalized ? normalized.messageId : "",
        text: "text" in normalized ? summarizeDebugText(normalized.text) : undefined,
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

function normalizeCoworkStreamFrame(raw: Record<string, unknown>): NormalizedGatewayEvent {
  const messageId = stableMessageId(
    "cowork",
    optionalString(raw.session_id),
    optionalString(raw.agent_id),
    optionalString(raw.step_id),
  );
  if (isTerminalStreamFrame(raw)) {
    return {
      kind: "message.stream.completed",
      chatId: optionalString(raw.chat_id),
      messageId,
      raw,
    };
  }
  return {
    kind: "message.delta",
    chatId: optionalString(raw.chat_id),
    messageId,
    text: stringValue(raw.text),
    reasoning: false,
    raw,
  };
}

function normalizeCoworkMailboxStreamFrame(raw: Record<string, unknown>): NormalizedGatewayEvent {
  const messageId = stableMessageId(
    "cowork-mailbox",
    optionalString(raw.draft_id) ?? optionalString(raw.tool_call_id) ?? optionalString(raw.session_id),
  );
  if (isTerminalStreamFrame(raw)) {
    return {
      kind: "message.stream.completed",
      chatId: optionalString(raw.chat_id),
      messageId,
      raw,
    };
  }
  return {
    kind: "message.delta",
    chatId: optionalString(raw.chat_id),
    messageId,
    text: stringValue(raw.text),
    reasoning: false,
    raw,
  };
}

function isTerminalStreamFrame(raw: Record<string, unknown>): boolean {
  const phase = stringValue(raw.phase);
  const status = stringValue(raw.status);
  return raw.completed === true || phase === "complete" || phase === "terminal" || status === "completed";
}

function stableMessageId(prefix: string, ...parts: Array<string | undefined>): string {
  const values = parts.filter((part): part is string => Boolean(part));
  return values.length ? `${prefix}:${values.join(":")}` : prefix;
}

function formatTokenUsage(value: unknown): string {
  const usage = isRecord(value) ? value : {};
  const explicitPercent = numberValue(usage.percent ?? usage.percentage ?? usage.token_usage_percent ?? usage.tokenUsagePercent);
  if (explicitPercent !== null) {
    return `${boundedPercent(explicitPercent)}%`;
  }
  const total = numberValue(usage.total_tokens ?? usage.totalTokens ?? usage.total) ?? 0;
  const contextWindow = numberValue(
    usage.context_window_tokens ??
    usage.contextWindowTokens ??
    usage.context_window ??
    usage.contextWindow ??
    usage.max_context_tokens ??
    usage.maxContextTokens,
  );
  if (contextWindow === null) {
    return "-";
  }
  if (contextWindow <= 0) {
    return "0%";
  }
  return `${boundedPercent((total / contextWindow) * 100)}%`;
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
