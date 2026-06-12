import { describe, expect, test } from "vitest";

import {
  parsePythonBridgeInboundMessage,
  toPythonBridgeOutboundMessage,
} from "./index.ts";

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

  test("rejects malformed inbound bridge JSON with field-specific messages", () => {
    expect(() => parsePythonBridgeInboundMessage({
      channel: "feishu",
      sender_id: "ou_1",
      content: "hello",
    })).toThrow("python channel bridge message.chatId must be a string");
  });
});
