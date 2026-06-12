import type { AgentRunResult } from "../agent/agentRunSpec.ts";
import type { AgentRunInput } from "../agent/contextTypes.ts";
import type { MessageBus } from "../bus/messageBus.ts";
import { sessionKeyOf, type InboundMessage, type MessageMetadata } from "../bus/messageTypes.ts";

export type ChannelRuntimeRunAgent = (
  input: AgentRunInput,
  context: { message: InboundMessage },
) => Promise<AgentRunResult> | AgentRunResult;

export type ChannelRuntimeOptions = {
  bus: MessageBus;
  runAgent: ChannelRuntimeRunAgent;
  createRunId?: (message: InboundMessage, index: number) => string;
};

export type ChannelRuntimeDiagnostic = {
  kind: "agent_failed";
  channel: string;
  chatId: string;
  runId: string;
  error: string;
};

export class ChannelRuntime {
  private readonly bus: MessageBus;
  private readonly runAgent: ChannelRuntimeRunAgent;
  private readonly createRunId: (message: InboundMessage, index: number) => string;
  private readonly runtimeDiagnostics: ChannelRuntimeDiagnostic[] = [];
  private runCounter = 0;

  constructor(options: ChannelRuntimeOptions) {
    this.bus = options.bus;
    this.runAgent = options.runAgent;
    this.createRunId = options.createRunId ?? defaultRunId;
  }

  diagnostics(): ChannelRuntimeDiagnostic[] {
    return this.runtimeDiagnostics.map((diagnostic) => ({ ...diagnostic }));
  }

  async dispatchInboundAvailable(maxMessages = 100): Promise<number> {
    let completed = 0;
    while (completed < maxMessages) {
      const message = this.bus.tryConsumeInbound();
      if (message === null) {
        break;
      }
      const runId = this.createRunId(message, this.runCounter++);
      try {
        const result = await this.runAgent(this.inputFromMessage(message, runId), { message });
        await this.publishResult(message, result);
        completed += 1;
      } catch (error) {
        this.runtimeDiagnostics.push({
          kind: "agent_failed",
          channel: message.channel,
          chatId: message.chatId,
          runId,
          error: errorMessage(error),
        });
        await this.bus.publishOutbound({
          channel: message.channel,
          chatId: message.chatId,
          content: "Sorry, I encountered an error.",
          media: [],
          metadata: {},
        });
      }
    }
    return completed;
  }

  private inputFromMessage(message: InboundMessage, runId: string): AgentRunInput {
    return {
      runId,
      sessionId: sessionKeyOf(message),
      input: {
        role: "user",
        content: message.content,
        media: message.media,
      },
      channel: message.channel,
      chatId: message.chatId,
      stream: message.metadata._wants_stream === true,
      metadata: {
        ...message.metadata,
        senderId: message.senderId,
      },
    };
  }

  private async publishResult(message: InboundMessage, result: AgentRunResult): Promise<void> {
    if (result.usage && message.channel === "websocket") {
      await this.bus.publishOutbound({
        channel: message.channel,
        chatId: message.chatId,
        content: "",
        media: [],
        metadata: {
          _usage: true,
          usage_data: usageData(result.usage),
        },
      });
    }
    const metadata: MessageMetadata = {
      ...metadataRecord(result.metadata),
    };
    const streamed = message.metadata._wants_stream === true;
    if (streamed) {
      metadata._streamed = true;
    }
    await this.bus.publishOutbound({
      channel: message.channel,
      chatId: message.chatId,
      content: streamed ? "" : result.finalContent,
      media: [],
      metadata,
    });
  }
}

function defaultRunId(message: InboundMessage, index: number): string {
  return `channel-${message.channel}-${message.chatId}-${index + 1}`.replace(/[^A-Za-z0-9_.:-]/g, "-");
}

function usageData(usage: NonNullable<AgentRunResult["usage"]>): Record<string, unknown> {
  return {
    prompt_tokens: usage.inputTokens ?? 0,
    completion_tokens: usage.outputTokens ?? 0,
    total_tokens: usage.totalTokens ?? 0,
    cached_tokens: usage.cachedTokens ?? 0,
  };
}

function metadataRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
