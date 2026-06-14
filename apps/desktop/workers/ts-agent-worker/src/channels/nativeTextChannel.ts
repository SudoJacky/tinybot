import type { MessageBus } from "../bus/messageBus.ts";
import type { MessageMetadata, OutboundMessage } from "../bus/messageTypes.ts";
import { BaseChannel, type BaseChannelConfig, type ChannelAudioTranscriber } from "./baseChannel.ts";

export type NativeTextChannelSendTextInput = {
  channel: string;
  chatId: string;
  content: string;
  media: string[];
  metadata: MessageMetadata;
  replyTo?: string | null;
};

export type NativeTextChannelConnector = {
  start?: () => Promise<void> | void;
  stop?: () => Promise<void> | void;
  sendText: (input: NativeTextChannelSendTextInput) => Promise<void> | void;
  sendDelta?: (chatId: string, delta: string, metadata: MessageMetadata) => Promise<void> | void;
  sendUsage?: (chatId: string, usage: Record<string, unknown>) => Promise<void> | void;
  transcribeAudio?: ChannelAudioTranscriber;
};

export type NativeTextChannelOptions = {
  name: string;
  displayName: string;
  config: BaseChannelConfig;
  bus: MessageBus;
  connector: NativeTextChannelConnector;
  transcriptionApiKey?: string;
};

export class NativeTextChannel extends BaseChannel {
  readonly name: string;
  readonly displayName: string;
  private readonly connector: NativeTextChannelConnector;

  constructor(options: NativeTextChannelOptions) {
    super({
      config: options.config,
      bus: options.bus,
      transcriptionApiKey: options.transcriptionApiKey,
      transcriber: options.connector.transcribeAudio,
    });
    this.name = options.name;
    this.displayName = options.displayName;
    this.connector = options.connector;
  }

  override get supportsStreaming(): boolean {
    return Boolean(this.config.streaming && this.connector.sendDelta);
  }

  async start(): Promise<void> {
    await this.connector.start?.();
    this.setRunning(true);
  }

  async stop(): Promise<void> {
    await this.connector.stop?.();
    this.setRunning(false);
  }

  async send(message: OutboundMessage): Promise<void> {
    await this.connector.sendText({
      channel: message.channel,
      chatId: message.chatId,
      content: message.content,
      media: message.media,
      metadata: message.metadata,
      replyTo: message.replyTo ?? null,
    });
  }

  override async sendDelta(chatId: string, delta: string, metadata: MessageMetadata = {}): Promise<void> {
    await this.connector.sendDelta?.(chatId, delta, metadata);
  }

  override async sendUsage(chatId: string, usage: Record<string, unknown>): Promise<void> {
    await this.connector.sendUsage?.(chatId, usage);
  }
}
