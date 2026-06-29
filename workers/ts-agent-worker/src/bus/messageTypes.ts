export type MessageMetadata = Record<string, unknown>;

export type InboundMessage = {
  channel: string;
  senderId: string;
  chatId: string;
  content: string;
  timestamp: string;
  media: string[];
  metadata: MessageMetadata;
  sessionKeyOverride?: string | null;
};

export type OutboundMessage = {
  channel: string;
  chatId: string;
  content: string;
  replyTo?: string | null;
  media: string[];
  metadata: MessageMetadata;
};

export function sessionKeyOf(message: InboundMessage): string {
  return message.sessionKeyOverride || `${message.channel}:${message.chatId}`;
}
