import { DEFAULT_GATEWAY_CONFIG, type GatewayConfig } from "./gatewayConfig";

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
  | { kind: "message.delta"; chatId?: string; messageId?: string; text: string; reasoning: boolean; raw: Record<string, unknown> }
  | { kind: "message.completed"; chatId?: string; messageId?: string; text: string; raw: Record<string, unknown> }
  | { kind: "message.stream.completed"; chatId?: string; messageId?: string; raw: Record<string, unknown> }
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
    case "browser_frame":
      return { kind: "browser.frame", raw };
    case "browser_snapshot":
      return { kind: "browser.snapshot", raw };
    case "agent_ui_form":
    case "form_request":
      return { kind: "agent-ui.form", raw };
    case "agent_ui_event": {
      const payload = isRecord(raw.agent_ui_event) ? raw.agent_ui_event : {};
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
      handlers.onEvent(normalizeGatewayFrame(JSON.parse(String(event.data))));
    } catch {
      handlers.onEvent({ kind: "error", message: "invalid websocket json", raw: {} });
    }
  });
  return socket;
}

export function sendGatewaySocketJson(socket: JsonSocket | null, message: unknown, queue: unknown[]): "sent" | "queued" {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    queue.push(message);
    return "queued";
  }
  socket.send(JSON.stringify(message));
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}
