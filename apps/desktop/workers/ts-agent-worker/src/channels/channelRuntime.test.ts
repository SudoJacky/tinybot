import { describe, expect, test } from "vitest";

import type { AgentRunResult } from "../agent/agentRunSpec.ts";
import type { AgentRunInput } from "../agent/contextTypes.ts";
import { MessageBus } from "../bus/messageBus.ts";
import type { InboundMessage } from "../bus/messageTypes.ts";
import { ChannelRuntime } from "./channelRuntime.ts";

function inbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    channel: "websocket",
    senderId: "user-1",
    chatId: "chat-1",
    content: "hello",
    timestamp: "2026-06-13T00:00:00.000Z",
    media: [],
    metadata: {},
    ...overrides,
  };
}

function result(overrides: Partial<AgentRunResult> = {}): AgentRunResult {
  return {
    finalContent: "done",
    messages: [],
    toolsUsed: [],
    stopReason: "final_response",
    ...overrides,
  };
}

describe("ChannelRuntime", () => {
  test("turns inbound channel messages into agent run inputs and publishes final output", async () => {
    const bus = new MessageBus();
    const inputs: AgentRunInput[] = [];
    const runtime = new ChannelRuntime({
      bus,
      createRunId: (message) => `run-${message.channel}-${message.chatId}`,
      runAgent: async (input) => {
        inputs.push(input);
        return result({
          usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5, cachedTokens: 1 },
          metadata: { _memory_references: [{ note_id: "n1" }] },
        });
      },
    });

    await bus.publishInbound(inbound({
      media: ["file://a.png"],
      metadata: { _wants_stream: true, message_id: "m1" },
      sessionKeyOverride: "thread:42",
    }));

    await expect(runtime.dispatchInboundAvailable()).resolves.toBe(1);
    expect(inputs).toEqual([
      expect.objectContaining({
        runId: "run-websocket-chat-1",
        sessionId: "thread:42",
        channel: "websocket",
        chatId: "chat-1",
        stream: true,
        input: { role: "user", content: "hello", media: ["file://a.png"] },
        metadata: expect.objectContaining({
          senderId: "user-1",
          message_id: "m1",
        }),
      }),
    ]);
    expect(bus.drainOutboundForTest()).toEqual([
      expect.objectContaining({
        channel: "websocket",
        chatId: "chat-1",
        content: "",
        metadata: expect.objectContaining({
          _usage: true,
          usage_data: {
            prompt_tokens: 3,
            completion_tokens: 2,
            total_tokens: 5,
            cached_tokens: 1,
          },
        }),
      }),
      expect.objectContaining({
        channel: "websocket",
        chatId: "chat-1",
        content: "",
        metadata: expect.objectContaining({
          _streamed: true,
          _memory_references: [{ note_id: "n1" }],
        }),
      }),
    ]);
  });

  test("publishes non-stream final content and records agent failures", async () => {
    const bus = new MessageBus();
    const runtime = new ChannelRuntime({
      bus,
      createRunId: () => "run-fails",
      runAgent: async () => {
        throw new Error("provider down");
      },
    });

    await bus.publishInbound(inbound({ channel: "feishu", chatId: "oc_1", content: "hi" }));

    await expect(runtime.dispatchInboundAvailable()).resolves.toBe(0);
    expect(bus.drainOutboundForTest()).toEqual([
      expect.objectContaining({
        channel: "feishu",
        chatId: "oc_1",
        content: "Sorry, I encountered an error.",
        metadata: {},
      }),
    ]);
    expect(runtime.diagnostics()).toEqual([
      expect.objectContaining({
        kind: "agent_failed",
        channel: "feishu",
        chatId: "oc_1",
        runId: "run-fails",
        error: "provider down",
      }),
    ]);
  });

  test("dispatches channel slash commands without invoking the agent runner", async () => {
    const bus = new MessageBus();
    const agentInputs: AgentRunInput[] = [];
    const commandCalls: Array<{ raw: string; sessionId: string; runId: string }> = [];
    const runtime = new ChannelRuntime({
      bus,
      createRunId: () => "run-stop",
      handleCommand: async (message, context) => {
        commandCalls.push({
          raw: message.content,
          sessionId: context.sessionId,
          runId: context.runId,
        });
        return result({
          finalContent: "Stopped 1 task(s).",
          metadata: { command: "/stop", cancelled_count: 1 },
          stopReason: "command",
        });
      },
      runAgent: async (input) => {
        agentInputs.push(input);
        return result();
      },
    });

    await bus.publishInbound(inbound({
      content: "/stop",
      channel: "feishu",
      chatId: "oc_1",
      metadata: { _wants_stream: true },
    }));

    await expect(runtime.dispatchInboundAvailable()).resolves.toBe(1);
    expect(agentInputs).toEqual([]);
    expect(commandCalls).toEqual([
      { raw: "/stop", sessionId: "feishu:oc_1", runId: "run-stop" },
    ]);
    expect(bus.drainOutboundForTest()).toEqual([
      expect.objectContaining({
        channel: "feishu",
        chatId: "oc_1",
        content: "Stopped 1 task(s).",
        metadata: expect.objectContaining({
          command: "/stop",
          cancelled_count: 1,
        }),
      }),
    ]);
  });
});
