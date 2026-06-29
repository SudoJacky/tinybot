import { isJsonObject } from "../protocol/messages.ts";

export type GatewayFrame = Record<string, unknown>;

export type OutboundMessageFrameInput = {
  chatId: string;
  content: string;
  metadata?: Record<string, unknown>;
};

export type TransportGatewayFrameEvent =
  | {
    kind: "message";
    chatId: string;
    content: string;
    metadata?: Record<string, unknown>;
  }
  | {
    kind: "delta";
    chatId: string;
    delta: string;
    metadata?: Record<string, unknown>;
  }
  | {
    kind: "usage";
    chatId: string;
    usage: Record<string, unknown>;
  };

const BOOLEAN_MESSAGE_FLAGS = [
  "_progress",
  "_tool_hint",
  "_tool_detail",
  "_tool_result",
  "_task_event",
] as const;

const VALUE_MESSAGE_FIELDS = [
  "_tool_name",
  "_approval_status",
  "_approval_id",
  "_task_progress",
  "_task_plan_id",
  "_memory_references",
  "_recent_context_references",
] as const;

export function outboundMessageFrame(input: OutboundMessageFrameInput): GatewayFrame {
  const metadata = input.metadata ?? {};

  if (metadata._browser_snapshot) {
    return {
      event: "browser_frame",
      chat_id: input.chatId,
      image_url: stringValue(metadata.image_url) ?? "",
      source_command: stringValue(metadata.source_command) ?? "",
      captured_at: metadata.captured_at,
    };
  }

  if (metadata._approval_pending) {
    return {
      event: "approval_pending",
      chat_id: input.chatId,
    };
  }

  if (isJsonObject(metadata._agent_ui_event)) {
    const agentUiEvent = {
      ...metadata._agent_ui_event,
      chat_id: stringValue(metadata._agent_ui_event.chat_id) ?? input.chatId,
    };
    return {
      event: "agent_ui_event",
      chat_id: input.chatId,
      agent_ui_event: agentUiEvent,
    };
  }

  const frame: GatewayFrame = {
    event: "message",
    chat_id: input.chatId,
    message_id: stringValue(metadata._stream_id) ?? generatedMessageId(),
    text: input.content,
  };
  for (const key of BOOLEAN_MESSAGE_FLAGS) {
    if (metadata[key]) {
      frame[key] = true;
    }
  }
  for (const key of VALUE_MESSAGE_FIELDS) {
    if (metadata[key] !== undefined && metadata[key] !== null) {
      frame[key] = metadata[key];
    }
  }
  return frame;
}

export function streamDeltaFrame(
  chatId: string,
  delta: string,
  metadata: Record<string, unknown> = {},
): GatewayFrame {
  const messageId = stringValue(metadata._stream_id) ?? generatedMessageId();
  if (metadata._stream_end) {
    const frame: GatewayFrame = {
      event: "stream_end",
      chat_id: chatId,
      message_id: messageId,
      reason: "stop",
      resuming: metadata._resuming === true,
    };
    if (metadata._memory_references !== undefined && metadata._memory_references !== null) {
      frame._memory_references = metadata._memory_references;
    }
    if (metadata._recent_context_references !== undefined && metadata._recent_context_references !== null) {
      frame._recent_context_references = metadata._recent_context_references;
    }
    return frame;
  }
  return {
    event: "delta",
    chat_id: chatId,
    message_id: messageId,
    text: delta,
    is_reasoning: metadata._reasoning_delta === true,
  };
}

export function usageFrame(chatId: string, usage: Record<string, unknown>): GatewayFrame {
  return {
    event: "usage",
    chat_id: chatId,
    usage: {
      prompt_tokens: numberValue(usage.prompt_tokens),
      completion_tokens: numberValue(usage.completion_tokens),
      total_tokens: numberValue(usage.total_tokens),
      cached_tokens: numberValue(usage.cached_tokens),
    },
  };
}

export function gatewayFrameFromTransportEvent(event: TransportGatewayFrameEvent): GatewayFrame {
  if (event.kind === "message") {
    return outboundMessageFrame(event);
  }
  if (event.kind === "delta") {
    return streamDeltaFrame(event.chatId, event.delta, event.metadata);
  }
  return usageFrame(event.chatId, event.usage);
}

export function parseTransportGatewayFrameEvent(params: Record<string, unknown> | undefined): TransportGatewayFrameEvent {
  if (!isJsonObject(params)) {
    throw new Error("transport.gateway_frame requires object params");
  }
  const kind = params.kind;
  const chatId = stringParam(params, "chatId", "chat_id");
  if (!chatId) {
    throw new Error("transport.gateway_frame requires params.chat_id");
  }
  const metadata = isJsonObject(params.metadata) ? params.metadata : undefined;
  if (kind === "message") {
    const content = stringValue(params.content) ?? "";
    return { kind, chatId, content, metadata };
  }
  if (kind === "delta") {
    const delta = stringValue(params.delta) ?? "";
    return { kind, chatId, delta, metadata };
  }
  if (kind === "usage") {
    if (!isJsonObject(params.usage)) {
      throw new Error("transport.gateway_frame usage events require params.usage");
    }
    return { kind, chatId, usage: params.usage };
  }
  throw new Error("transport.gateway_frame params.kind must be message, delta, or usage");
}

function stringParam(params: Record<string, unknown>, camelKey: string, snakeKey: string): string | undefined {
  return stringValue(params[camelKey]) ?? stringValue(params[snakeKey]);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function generatedMessageId(): string {
  return `ts-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
