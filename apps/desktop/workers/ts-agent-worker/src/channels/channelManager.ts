import type { MessageBus } from "../bus/messageBus.ts";
import type { OutboundMessage } from "../bus/messageTypes.ts";

const RESTART_NOTIFY_CHANNEL_ENV = "tinybot_RESTART_NOTIFY_CHANNEL";
const RESTART_NOTIFY_CHAT_ID_ENV = "tinybot_RESTART_NOTIFY_CHAT_ID";
const RESTART_STARTED_AT_ENV = "tinybot_RESTART_STARTED_AT";

export type ChannelAdapter = {
  name: string;
  displayName: string;
  supportsStreaming?: boolean;
  start?: () => Promise<void>;
  stop?: () => Promise<void>;
  send: (message: OutboundMessage) => Promise<void>;
  sendDelta?: (chatId: string, delta: string, metadata: Record<string, unknown>) => Promise<void>;
  sendUsage?: (chatId: string, usage: Record<string, unknown>) => Promise<void>;
};

export type ChannelStatus = {
  name: string;
  displayName: string;
  supportsStreaming: boolean;
  running: boolean;
};

export type ChannelManagerStatus = {
  running: boolean;
  channels: ChannelStatus[];
  diagnostics: ChannelDispatchDiagnostic[];
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

export type ChannelRestartNotice = {
  channel: string;
  chatId: string;
  startedAtUnixSeconds?: number | null;
};

export type ChannelRestartNoticeSource = () => ChannelRestartNotice | null;

export type ChannelManagerOptions = {
  bus: MessageBus;
  channels: ChannelAdapter[];
  sendProgress?: boolean;
  sendToolHints?: boolean;
  retryDelaysMs?: number[];
  sleep?: (delayMs: number) => Promise<void>;
  restartNotice?: ChannelRestartNotice | null | ChannelRestartNoticeSource;
  nowUnixSeconds?: () => number;
  env?: Record<string, string | undefined>;
};

export class ChannelManager {
  private readonly bus: MessageBus;
  private readonly channels = new Map<string, ChannelAdapter>();
  private readonly sendProgress: boolean;
  private readonly sendToolHints: boolean;
  private readonly retryDelaysMs: number[];
  private readonly sleep: (delayMs: number) => Promise<void>;
  private readonly restartNoticeSource: ChannelRestartNoticeSource;
  private readonly nowUnixSeconds: () => number;
  private readonly dispatchDiagnostics: ChannelDispatchDiagnostic[] = [];
  private readonly pendingOutbound: OutboundMessage[] = [];
  private readonly runningChannels = new Set<string>();
  private running = false;

  constructor(options: ChannelManagerOptions) {
    this.bus = options.bus;
    this.sendProgress = options.sendProgress ?? true;
    this.sendToolHints = options.sendToolHints ?? true;
    this.retryDelaysMs = options.retryDelaysMs ?? [1000, 2000, 4000];
    this.sleep = options.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
    this.restartNoticeSource = restartNoticeSource(options);
    this.nowUnixSeconds = options.nowUnixSeconds ?? (() => Date.now() / 1000);
    for (const channel of options.channels) {
      this.channels.set(channel.name, channel);
    }
  }

  diagnostics(): ChannelDispatchDiagnostic[] {
    return this.dispatchDiagnostics.map((diagnostic) => ({ ...diagnostic }));
  }

  enabledChannels(): string[] {
    return [...this.channels.keys()];
  }

  status(): ChannelManagerStatus {
    return {
      running: this.running,
      channels: [...this.channels.values()].map((channel) => ({
        name: channel.name,
        displayName: channel.displayName,
        supportsStreaming: channel.supportsStreaming === true,
        running: this.runningChannels.has(channel.name),
      })),
      diagnostics: this.diagnostics(),
    };
  }

  async startAll(): Promise<void> {
    this.running = true;
    for (const channel of this.channels.values()) {
      await channel.start?.();
      this.runningChannels.add(channel.name);
    }
    await this.sendRestartNoticeIfNeeded();
  }

  async stopAll(): Promise<void> {
    for (const channel of this.channels.values()) {
      await channel.stop?.();
      this.runningChannels.delete(channel.name);
    }
    this.running = false;
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
      }
      return;
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

  private async sendRestartNoticeIfNeeded(): Promise<void> {
    const notice = this.restartNoticeSource();
    if (!notice) {
      return;
    }
    const channel = this.channels.get(notice.channel);
    if (!channel) {
      return;
    }
    const message: OutboundMessage = {
      channel: notice.channel,
      chatId: notice.chatId,
      content: formatRestartCompletedMessage(notice, this.nowUnixSeconds()),
      media: [],
      metadata: { _restart_completed: true },
    };
    const result = await this.sendWithRetry(channel, message);
    if (!result.ok) {
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

function restartNoticeSource(options: ChannelManagerOptions): ChannelRestartNoticeSource {
  if (typeof options.restartNotice === "function") {
    return options.restartNotice;
  }
  const notice = options.restartNotice;
  if (notice !== undefined) {
    return () => notice;
  }
  return () => consumeRestartNoticeFromEnv(options.env ?? process.env);
}

export function consumeRestartNoticeFromEnv(env: Record<string, string | undefined>): ChannelRestartNotice | null {
  const channel = (env[RESTART_NOTIFY_CHANNEL_ENV] ?? "").trim();
  const chatId = (env[RESTART_NOTIFY_CHAT_ID_ENV] ?? "").trim();
  const startedAtRaw = (env[RESTART_STARTED_AT_ENV] ?? "").trim();
  delete env[RESTART_NOTIFY_CHANNEL_ENV];
  delete env[RESTART_NOTIFY_CHAT_ID_ENV];
  delete env[RESTART_STARTED_AT_ENV];
  if (!channel || !chatId) {
    return null;
  }
  const startedAtUnixSeconds = Number.parseFloat(startedAtRaw);
  return {
    channel,
    chatId,
    startedAtUnixSeconds: Number.isFinite(startedAtUnixSeconds) ? startedAtUnixSeconds : null,
  };
}

export function formatRestartCompletedMessage(notice: ChannelRestartNotice, nowUnixSeconds = Date.now() / 1000): string {
  const startedAtUnixSeconds = notice.startedAtUnixSeconds;
  if (typeof startedAtUnixSeconds !== "number" || !Number.isFinite(startedAtUnixSeconds)) {
    return "Restart completed.";
  }
  const elapsedSeconds = Math.max(0, nowUnixSeconds - startedAtUnixSeconds);
  return `Restart completed in ${elapsedSeconds.toFixed(1)}s.`;
}
