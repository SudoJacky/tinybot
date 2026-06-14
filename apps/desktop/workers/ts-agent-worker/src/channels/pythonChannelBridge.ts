import type { InboundMessage, OutboundMessage } from "../bus/messageTypes.ts";
import type { MessageBus, MessageBusWarning } from "../bus/messageBus.ts";
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

export type PythonChannelBridgeDiagnostic =
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

export type PythonChannelBridgeOptions = PythonBridgeParseOptions & {
  bus: MessageBus;
};

export class PythonChannelBridge {
  private readonly bus: MessageBus;
  private readonly parseOptions: PythonBridgeParseOptions;
  private readonly bridgeDiagnostics: PythonChannelBridgeDiagnostic[] = [];
  private seenBusWarnings = 0;

  constructor(options: PythonChannelBridgeOptions) {
    this.bus = options.bus;
    this.parseOptions = { now: options.now };
    this.seenBusWarnings = options.bus.stats().warnings.length;
  }

  diagnostics(): PythonChannelBridgeDiagnostic[] {
    return this.bridgeDiagnostics.map((diagnostic) => ({ ...diagnostic }));
  }

  async ingestInbound(value: unknown): Promise<{ ok: true } | { ok: false; error: string }> {
    let message: InboundMessage;
    try {
      message = parsePythonBridgeInboundMessage(value, this.parseOptions);
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
