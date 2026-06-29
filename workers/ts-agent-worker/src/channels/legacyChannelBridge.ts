import type { InboundMessage, OutboundMessage } from "../bus/messageTypes.ts";
import type { MessageBus, MessageBusWarning } from "../bus/messageBus.ts";
import { isJsonObject } from "../protocol/messages.ts";
import type { ChannelAdapter } from "./channelManager.ts";

export type LegacyBridgeParseOptions = {
  now?: () => string;
};

export type LegacyBridgeOutboundJson = Record<string, unknown>;

export type LegacyChannelBridgeDeliver = (message: LegacyBridgeOutboundJson) => Promise<void> | void;

export type LegacyChannelBridgeAdapterOptions = {
  name: string;
  displayName?: string;
  supportsStreaming?: boolean;
  deliver: LegacyChannelBridgeDeliver;
};

export type LegacyChannelBridgeDiagnostic =
  | {
    kind: "invalid_inbound";
    error: string;
  }
  | {
    kind: "bus_closed";
    channel: string;
    chatId: string;
    error: string;
  }
  | {
    kind: "backpressure";
    queue: MessageBusWarning["queue"];
    size: number;
    threshold: number;
    timestamp: string;
  };

export type LegacyChannelBridgeOptions = LegacyBridgeParseOptions & {
  bus: MessageBus;
};

export class LegacyChannelBridge {
  private readonly bus: MessageBus;
  private readonly parseOptions: LegacyBridgeParseOptions;
  private readonly bridgeDiagnostics: LegacyChannelBridgeDiagnostic[] = [];
  private seenBusWarnings = 0;

  constructor(options: LegacyChannelBridgeOptions) {
    this.bus = options.bus;
    this.parseOptions = { now: options.now };
    this.seenBusWarnings = options.bus.stats().warnings.length;
  }

  diagnostics(): LegacyChannelBridgeDiagnostic[] {
    return this.bridgeDiagnostics.map((diagnostic) => ({ ...diagnostic }));
  }

  async ingestInbound(value: unknown): Promise<{ ok: true } | { ok: false; error: string }> {
    let message: InboundMessage;
    try {
      message = parseLegacyBridgeInboundMessage(value, this.parseOptions);
    } catch (error) {
      const message = errorMessage(error);
      this.bridgeDiagnostics.push({ kind: "invalid_inbound", error: message });
      return { ok: false, error: message };
    }

    if (this.bus.stats().closed) {
      const messageText = "message bus is closed";
      this.bridgeDiagnostics.push({
        kind: "bus_closed",
        channel: message.channel,
        chatId: message.chatId,
        error: messageText,
      });
      return { ok: false, error: messageText };
    }

    await this.bus.publishInbound(message);
    this.recordNewBusWarnings();
    return { ok: true };
  }

  private recordNewBusWarnings(): void {
    const warnings = this.bus.stats().warnings.slice(this.seenBusWarnings);
    this.seenBusWarnings += warnings.length;
    for (const warning of warnings) {
      this.bridgeDiagnostics.push({
        kind: "backpressure",
        queue: warning.queue,
        size: warning.size,
        threshold: warning.threshold,
        timestamp: warning.timestamp,
      });
    }
  }
}

export function parseLegacyBridgeInboundMessage(
  value: unknown,
  options: LegacyBridgeParseOptions = {},
): InboundMessage {
  if (!isJsonObject(value)) {
    throw new Error("legacy channel bridge message must be an object");
  }
  const channel = requiredString(value, "channel", "channel", "legacy channel bridge message.channel");
  const senderId = requiredString(value, "senderId", "sender_id", "legacy channel bridge message.senderId");
  const chatId = requiredString(value, "chatId", "chat_id", "legacy channel bridge message.chatId");
  const content = requiredString(value, "content", "content", "legacy channel bridge message.content");
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

export function toLegacyBridgeOutboundMessage(message: OutboundMessage): Record<string, unknown> {
  return {
    channel: message.channel,
    chat_id: message.chatId,
    content: message.content,
    reply_to: message.replyTo ?? null,
    media: message.media,
    metadata: message.metadata,
  };
}

export function createLegacyChannelBridgeAdapter(options: LegacyChannelBridgeAdapterOptions): ChannelAdapter {
  const deliverOutbound = async (message: OutboundMessage): Promise<void> => {
    await options.deliver(toLegacyBridgeOutboundMessage(message));
  };

  return {
    name: options.name,
    displayName: options.displayName ?? `${options.name} Legacy Bridge`,
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
