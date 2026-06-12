import { describe, expect, test } from "vitest";

import {
  createPythonChannelBridgeAdapter,
  parsePythonBridgeInboundMessage,
  toPythonBridgeOutboundMessage,
} from "./index.ts";
import { MessageBus } from "../bus/messageBus.ts";
import { ChannelManager } from "./channelManager.ts";

describe("pythonChannelBridge", () => {
  test("normalizes Python channel inbound JSON without dropping bridge fields", () => {
    const message = parsePythonBridgeInboundMessage({
      channel: "feishu",
      sender_id: "ou_1",
      chat_id: "oc_1",
      content: "hello",
      timestamp: "2026-06-13T02:00:00.000Z",
      media: ["file://clip.png", 42],
      metadata: {
        message_id: "mid-1",
        nested: { keep: true },
      },
      session_key_override: "thread:42",
    });

    expect(message).toEqual({
      channel: "feishu",
      senderId: "ou_1",
      chatId: "oc_1",
      content: "hello",
      timestamp: "2026-06-13T02:00:00.000Z",
      media: ["file://clip.png"],
      metadata: {
        message_id: "mid-1",
        nested: { keep: true },
      },
      sessionKeyOverride: "thread:42",
    });
  });

  test("accepts camelCase bridge aliases and defaults missing optional fields", () => {
    const message = parsePythonBridgeInboundMessage({
      channel: "dingtalk",
      senderId: "user-1",
      chatId: "group:1",
      content: "hi",
      sessionKey: "override:1",
    }, { now: () => "2026-06-13T03:00:00.000Z" });

    expect(message).toEqual({
      channel: "dingtalk",
      senderId: "user-1",
      chatId: "group:1",
      content: "hi",
      timestamp: "2026-06-13T03:00:00.000Z",
      media: [],
      metadata: {},
      sessionKeyOverride: "override:1",
    });
  });

  test("projects outbound messages back to Python bridge JSON", () => {
    expect(toPythonBridgeOutboundMessage({
      channel: "weixin",
      chatId: "wx-chat",
      content: "done",
      replyTo: "msg-1",
      media: ["file://out.png"],
      metadata: {
        _streamed: true,
        unknown: { keep: true },
      },
    })).toEqual({
      channel: "weixin",
      chat_id: "wx-chat",
      content: "done",
      reply_to: "msg-1",
      media: ["file://out.png"],
      metadata: {
        _streamed: true,
        unknown: { keep: true },
      },
    });
  });

  test("adapts ChannelManager outbound delivery to Python bridge JSON", async () => {
    const delivered: Array<Record<string, unknown>> = [];
    const bridge = createPythonChannelBridgeAdapter({
      name: "feishu",
      displayName: "Feishu Python Bridge",
      deliver: async (message) => {
        delivered.push(message);
      },
    });
    const bus = new MessageBus();
    const manager = new ChannelManager({ bus, channels: [bridge] });

    await bus.publishOutbound({
      channel: "feishu",
      chatId: "oc_1",
      content: "done",
      media: ["file://out.png"],
      metadata: { message_id: "mid-1" },
    });
    await bus.publishOutbound({
      channel: "feishu",
      chatId: "oc_1",
      content: "",
      media: [],
      metadata: { _usage: true, usage_data: { prompt_tokens: 4 } },
    });
    await bus.publishOutbound({
      channel: "feishu",
      chatId: "oc_1",
      content: "delta",
      media: [],
      metadata: { _stream_delta: true },
    });

    await expect(manager.dispatchAvailable()).resolves.toBe(3);
    expect(bridge.supportsStreaming).toBe(true);
    expect(delivered).toEqual([
      {
        channel: "feishu",
        chat_id: "oc_1",
        content: "done",
        reply_to: null,
        media: ["file://out.png"],
        metadata: { message_id: "mid-1" },
      },
      {
        channel: "feishu",
        chat_id: "oc_1",
        content: "",
        reply_to: null,
        media: [],
        metadata: { _usage: true, usage_data: { prompt_tokens: 4 } },
      },
      {
        channel: "feishu",
        chat_id: "oc_1",
        content: "delta",
        reply_to: null,
        media: [],
        metadata: { _stream_delta: true },
      },
    ]);
  });

  test("rejects malformed inbound bridge JSON with field-specific messages", () => {
    expect(() => parsePythonBridgeInboundMessage({
      channel: "feishu",
      sender_id: "ou_1",
      content: "hello",
    })).toThrow("python channel bridge message.chatId must be a string");
  });
});
