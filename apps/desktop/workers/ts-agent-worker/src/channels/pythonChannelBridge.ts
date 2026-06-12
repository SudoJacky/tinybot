import type { InboundMessage, OutboundMessage } from "../bus/messageTypes.ts";
import { isJsonObject } from "../protocol/messages.ts";
import type { ChannelAdapter } from "./channelManager.ts";

export type PythonBridgeParseOptions = {
  now?: () => string;
};

export type PythonBridgeOutboundJson = Record<string, unknown>;

export type PythonChannelBridgeDeliver = (message: PythonBridgeOutboundJson) => Promise<void> | void;

export type PythonChannelBridgeAdapterOptions = {
  name: string;
  displayName?: string;
  supportsStreaming?: boolean;
  deliver: PythonChannelBridgeDeliver;
};

export function parsePythonBridgeInboundMessage(
  value: unknown,
  options: PythonBridgeParseOptions = {},
): InboundMessage {
  if (!isJsonObject(value)) {
    throw new Error("python channel bridge message must be an object");
  }
  const channel = requiredString(value, "channel", "channel", "python channel bridge message.channel");
  const senderId = requiredString(value, "senderId", "sender_id", "python channel bridge message.senderId");
  const chatId = requiredString(value, "chatId", "chat_id", "python channel bridge message.chatId");
  const content = requiredString(value, "content", "content", "python channel bridge message.content");
  return {
    channel,
    senderId,
    chatId,
    content,
    timestamp: stringValue(value, "timestamp", "timestamp") ?? options.now?.() ?? new Date().toISOString(),
    media: stringArray(value.media),
    metadata: isJsonObject(value.metadata) ? { ...value.metadata } : {},
    sessionKeyOverride:
      stringValue(value, "sessionKeyOverride", "session_key_override")
      ?? stringValue(value, "sessionKey", "session_key")
      ?? null,
  };
}

export function toPythonBridgeOutboundMessage(message: OutboundMessage): Record<string, unknown> {
  return {
    channel: message.channel,
    chat_id: message.chatId,
    content: message.content,
    reply_to: message.replyTo ?? null,
    media: message.media,
    metadata: message.metadata,
  };
}

export function createPythonChannelBridgeAdapter(options: PythonChannelBridgeAdapterOptions): ChannelAdapter {
  const deliverOutbound = async (message: OutboundMessage): Promise<void> => {
    await options.deliver(toPythonBridgeOutboundMessage(message));
  };

  return {
    name: options.name,
    displayName: options.displayName ?? `${options.name} Python Bridge`,
    supportsStreaming: options.supportsStreaming ?? true,
    send: deliverOutbound,
    sendDelta: async (chatId, delta, metadata) => {
      await deliverOutbound({
        channel: options.name,
        chatId,
        content: delta,
        media: [],
        metadata,
      });
    },
    sendUsage: async (chatId, usage) => {
      await deliverOutbound({
        channel: options.name,
        chatId,
        content: "",
        media: [],
        metadata: { _usage: true, usage_data: usage },
      });
    },
  };
}

function requiredString(
  value: Record<string, unknown>,
  camelKey: string,
  snakeKey: string,
  label: string,
): string {
  const text = stringValue(value, camelKey, snakeKey);
  if (text === undefined) {
    throw new Error(`${label} must be a string`);
  }
  return text;
}

function stringValue(value: Record<string, unknown>, camelKey: string, snakeKey: string): string | undefined {
  const item = value[camelKey] ?? value[snakeKey];
  return typeof item === "string" ? item : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
