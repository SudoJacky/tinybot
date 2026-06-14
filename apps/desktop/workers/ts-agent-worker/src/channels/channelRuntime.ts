import type { AgentRunResult } from "../agent/agentRunSpec.ts";
import type { AgentRunInput } from "../agent/contextTypes.ts";
import type { MessageBus } from "../bus/messageBus.ts";
import { sessionKeyOf, type InboundMessage, type MessageMetadata } from "../bus/messageTypes.ts";

export type ChannelRuntimeRunAgent = (
  input: AgentRunInput,
  context: { message: InboundMessage },
) => Promise<AgentRunResult> | AgentRunResult;

export type ChannelRuntimeHandleCommand = (
  message: InboundMessage,
  context: { runId: string; sessionId: string },
) => Promise<AgentRunResult | undefined> | AgentRunResult | undefined;

export type ChannelRuntimeOptions = {
  bus: MessageBus;
  runAgent: ChannelRuntimeRunAgent;
  handleCommand?: ChannelRuntimeHandleCommand;
  createRunId?: (message: InboundMessage, index: number) => string;
};

export type ChannelRuntimeDiagnostic = {
  kind: "agent_failed";
  channel: string;
  chatId: string;
  runId: string;
  error: string;
};

type ChannelDispatchTarget = {
  channel: string;
  chatId: string;
  sessionId: string;
  stream: boolean;
};

export class ChannelRuntime {
  private readonly bus: MessageBus;
  private readonly runAgent: ChannelRuntimeRunAgent;
  private readonly handleCommand?: ChannelRuntimeHandleCommand;
  private readonly createRunId: (message: InboundMessage, index: number) => string;
  private readonly runtimeDiagnostics: ChannelRuntimeDiagnostic[] = [];
  private runCounter = 0;

  constructor(options: ChannelRuntimeOptions) {
    this.bus = options.bus;
    this.runAgent = options.runAgent;
    this.handleCommand = options.handleCommand;
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
      const target = targetForMessage(message);
      try {
        const commandResult = await this.handleCommand?.(message, {
          runId,
          sessionId: target.sessionId,
        });
        if (commandResult) {
          await this.publishResult(target, commandResult, { forceNonStream: true });
          completed += 1;
          continue;
        }
        const result = await this.runAgent(this.inputFromMessage(message, runId, target), { message });
        await this.publishResult(target, result);
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

  private inputFromMessage(message: InboundMessage, runId: string, target: ChannelDispatchTarget): AgentRunInput {
    return {
      runId,
      sessionId: target.sessionId,
      input: {
        role: "user",
        content: message.content,
        media: message.media,
      },
      channel: target.channel,
      chatId: target.chatId,
      stream: target.stream,
      metadata: {
        ...message.metadata,
        senderId: message.senderId,
      },
    };
  }

  private async publishResult(
    target: ChannelDispatchTarget,
    result: AgentRunResult,
    options: { forceNonStream?: boolean } = {},
  ): Promise<void> {
    if (result.usage && target.channel === "websocket") {
      await this.bus.publishOutbound({
        channel: target.channel,
        chatId: target.chatId,
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
    const streamed = !options.forceNonStream && target.stream;
    if (streamed) {
      metadata._streamed = true;
    }
    await this.bus.publishOutbound({
      channel: target.channel,
      chatId: target.chatId,
      content: streamed ? "" : result.finalContent,
      media: [],
      metadata,
    });
  }
}

function targetForMessage(message: InboundMessage): ChannelDispatchTarget {
  if (message.channel === "system") {
    const separator = message.chatId.indexOf(":");
    const channel = separator >= 0 ? message.chatId.slice(0, separator) : "cli";
    const chatId = separator >= 0 ? message.chatId.slice(separator + 1) : message.chatId;
    return {
      channel,
      chatId,
      sessionId: `${channel}:${chatId}`,
      stream: true,
    };
  }
  return {
    channel: message.channel,
    chatId: message.chatId,
    sessionId: sessionKeyOf(message),
    stream: message.metadata._wants_stream === true,
  };
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
