import type { MessageBus } from "../bus/messageBus.ts";
import type { OutboundMessage } from "../bus/messageTypes.ts";

export type ChannelAdapter = {
  name: string;
  displayName: string;
  send: (message: OutboundMessage) => Promise<void>;
  sendDelta?: (chatId: string, delta: string, metadata: Record<string, unknown>) => Promise<void>;
  sendUsage?: (chatId: string, usage: Record<string, unknown>) => Promise<void>;
};

export type ChannelDispatchDiagnostic = {
  kind: "dropped" | "unknown_channel" | "send_failed";
  reason?: "progress_disabled" | "tool_hints_disabled";
  channel: string;
  chatId: string;
  content?: string;
  attempts?: number;
  error?: string;
};

export type ChannelManagerOptions = {
  bus: MessageBus;
  channels: ChannelAdapter[];
  sendProgress?: boolean;
  sendToolHints?: boolean;
  retryDelaysMs?: number[];
  sleep?: (delayMs: number) => Promise<void>;
};

export class ChannelManager {
  private readonly bus: MessageBus;
  private readonly channels = new Map<string, ChannelAdapter>();
  private readonly sendProgress: boolean;
  private readonly sendToolHints: boolean;
  private readonly retryDelaysMs: number[];
  private readonly sleep: (delayMs: number) => Promise<void>;
  private readonly dispatchDiagnostics: ChannelDispatchDiagnostic[] = [];
  private readonly pendingOutbound: OutboundMessage[] = [];

  constructor(options: ChannelManagerOptions) {
    this.bus = options.bus;
    this.sendProgress = options.sendProgress ?? true;
    this.sendToolHints = options.sendToolHints ?? true;
    this.retryDelaysMs = options.retryDelaysMs ?? [1000, 2000, 4000];
    this.sleep = options.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
    for (const channel of options.channels) {
      this.channels.set(channel.name, channel);
    }
  }

  diagnostics(): ChannelDispatchDiagnostic[] {
    return this.dispatchDiagnostics.map((diagnostic) => ({ ...diagnostic }));
  }

  async dispatchAvailable(maxMessages = 100): Promise<number> {
    let dispatched = 0;
    while (dispatched < maxMessages) {
      let message = this.nextOutbound();
      if (message === null) {
        break;
      }
      const dropReason = this.dropReason(message);
      if (dropReason) {
        this.dispatchDiagnostics.push({
          kind: "dropped",
          reason: dropReason,
          channel: message.channel,
          chatId: message.chatId,
          content: message.content,
        });
        continue;
      }
      if (message.metadata._stream_delta && !message.metadata._stream_end) {
        message = this.coalesceStreamDeltas(message);
      }
      const channel = this.channels.get(message.channel);
      if (!channel) {
        this.dispatchDiagnostics.push({
          kind: "unknown_channel",
          channel: message.channel,
          chatId: message.chatId,
          content: message.content,
        });
        continue;
      }
      const result = await this.sendWithRetry(channel, message);
      if (result.ok) {
        dispatched += 1;
      } else {
        this.dispatchDiagnostics.push({
          kind: "send_failed",
          channel: message.channel,
          chatId: message.chatId,
          content: message.content,
          attempts: result.attempts,
          error: String(result.error instanceof Error ? result.error.message : result.error),
        });
      }
    }
    return dispatched;
  }

  private nextOutbound(): OutboundMessage | null {
    return this.pendingOutbound.shift() ?? this.bus.tryConsumeOutbound();
  }

  private coalesceStreamDeltas(first: OutboundMessage): OutboundMessage {
    const targetChannel = first.channel;
    const targetChat = first.chatId;
    let content = first.content;
    const metadata = { ...first.metadata };

    while (!metadata._stream_end) {
      const next = this.bus.tryConsumeOutbound();
      if (next === null) {
        break;
      }
      const sameTarget = next.channel === targetChannel && next.chatId === targetChat;
      const isDelta = Boolean(next.metadata._stream_delta);
      if (!sameTarget || !isDelta) {
        this.pendingOutbound.push(next);
        break;
      }
      content += next.content;
      if (next.metadata._stream_end) {
        metadata._stream_end = true;
      }
    }

    return { ...first, content, metadata };
  }

  private async sendOnce(channel: ChannelAdapter, message: OutboundMessage): Promise<void> {
    if (message.metadata._usage) {
      await channel.sendUsage?.(message.chatId, metadataRecord(message.metadata.usage_data));
      return;
    }
    if (message.metadata._stream_delta || message.metadata._stream_end || message.metadata._reasoning_delta) {
      if (channel.sendDelta) {
        await channel.sendDelta(message.chatId, message.content, message.metadata);
        return;
      }
    }
    if (!message.metadata._streamed) {
      await channel.send(message);
    }
  }

  private async sendWithRetry(
    channel: ChannelAdapter,
    message: OutboundMessage,
  ): Promise<{ ok: true; attempts: number } | { ok: false; attempts: number; error: unknown }> {
    let attempts = 0;
    let lastError: unknown;
    const maxAttempts = this.retryDelaysMs.length + 1;
    while (attempts < maxAttempts) {
      attempts += 1;
      try {
        await this.sendOnce(channel, message);
        return { ok: true, attempts };
      } catch (error) {
        lastError = error;
        const delay = this.retryDelaysMs[attempts - 1];
        if (delay === undefined) {
          break;
        }
        await this.sleep(delay);
      }
    }
    return { ok: false, attempts, error: lastError };
  }

  private dropReason(message: OutboundMessage): ChannelDispatchDiagnostic["reason"] | null {
    if (!message.metadata._progress) {
      return null;
    }
    if (message.metadata._tool_hint && !this.sendToolHints) {
      return "tool_hints_disabled";
    }
    if (!message.metadata._tool_hint && !this.sendProgress) {
      return "progress_disabled";
    }
    return null;
  }
}

function metadataRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}
