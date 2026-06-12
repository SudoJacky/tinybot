import type { MessageBus } from "../bus/messageBus.ts";
import type { InboundMessage, MessageMetadata, OutboundMessage } from "../bus/messageTypes.ts";
import type { ChannelAdapter } from "./channelManager.ts";

export type BaseChannelConfig = {
  allowFrom?: string[];
  allow_from?: string[];
  streaming?: boolean;
};

export type HandleChannelMessageRequest = {
  senderId: string;
  chatId: string;
  content: string;
  media?: string[];
  metadata?: MessageMetadata;
  sessionKey?: string | null;
};

export type BaseChannelOptions = {
  config: BaseChannelConfig;
  bus: MessageBus;
};

export abstract class BaseChannel implements ChannelAdapter {
  abstract readonly name: string;
  abstract readonly displayName: string;

  protected readonly config: BaseChannelConfig;
  protected readonly bus: MessageBus;
  private running = false;

  constructor(options: BaseChannelOptions) {
    this.config = options.config;
    this.bus = options.bus;
  }

  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;
  abstract send(message: OutboundMessage): Promise<void>;

  async login(_options: { force?: boolean } = {}): Promise<boolean> {
    return true;
  }

  async sendDelta(_chatId: string, _delta: string, _metadata: MessageMetadata = {}): Promise<void> {
    return undefined;
  }

  async sendUsage(_chatId: string, _usage: Record<string, unknown>): Promise<void> {
    return undefined;
  }

  get supportsStreaming(): boolean {
    return Boolean(this.config.streaming) && this.sendDelta !== BaseChannel.prototype.sendDelta;
  }

  get isRunning(): boolean {
    return this.running;
  }

  isAllowed(senderId: string): boolean {
    const allowFrom = this.config.allowFrom ?? this.config.allow_from ?? [];
    if (allowFrom.length === 0) {
      return false;
    }
    if (allowFrom.includes("*")) {
      return true;
    }
    return allowFrom.includes(String(senderId));
  }

  async handleMessage(request: HandleChannelMessageRequest): Promise<boolean> {
    if (!this.isAllowed(request.senderId)) {
      return false;
    }
    const metadata = {
      ...(request.metadata ?? {}),
      ...(this.supportsStreaming ? { _wants_stream: true } : {}),
    };
    const message: InboundMessage = {
      channel: this.name,
      senderId: String(request.senderId),
      chatId: String(request.chatId),
      content: request.content,
      media: request.media ?? [],
      metadata,
      timestamp: new Date().toISOString(),
      sessionKeyOverride: request.sessionKey ?? null,
    };
    await this.bus.publishInbound(message);
    return true;
  }

  static defaultConfig(): BaseChannelConfig & { enabled: boolean } {
    return { enabled: false };
  }

  protected setRunning(running: boolean): void {
    this.running = running;
  }
}
