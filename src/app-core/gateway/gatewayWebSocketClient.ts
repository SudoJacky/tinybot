import { DEFAULT_GATEWAY_CONFIG, type GatewayConfig } from "./gatewayConfig";
import { logDesktopNativeChatDebug, summarizeDebugText } from "../native/desktopNativeChatDebug";

export const createGatewaySocketMessage = {
  newChat: () => ({ type: "new_chat" as const }),
  attach: (chatId: string) => ({ type: "attach" as const, chat_id: chatId }),
  message: (chatId: string, content: string, usePersistentRag?: boolean, model?: string) => ({
    type: "message" as const,
    chat_id: chatId,
    content,
    ...(typeof usePersistentRag === "boolean" ? { use_persistent_rag: usePersistentRag } : {}),
    ...(model ? { model } : {}),
  }),
  interrupt: (chatId: string) => ({ type: "interrupt" as const, chat_id: chatId }),
};

export type NormalizedGatewayEvent =
  | { kind: "attached"; chatId: string; raw: Record<string, unknown> }
  | { kind: "chat.created"; chatId: string; raw: Record<string, unknown> }
  | { kind: "agent.event"; chatId?: string; raw: Record<string, unknown> }
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
      const messageId = "messageId" in normalized && typeof normalized.messageId === "string" ? normalized.messageId : "";
      const text = "text" in normalized && typeof normalized.text === "string" ? normalized.text : "";
      logDesktopNativeChatDebug("socket.frame", {
        chatId: "chatId" in normalized ? normalized.chatId : "",
        event: isRecord(raw) ? stringValue(raw.event) : "",
        kind: normalized.kind,
        messageId,
        text: text ? summarizeDebugText(text) : undefined,
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
