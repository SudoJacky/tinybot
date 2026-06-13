import { describe, expect, test, vi } from "vitest";

import { MessageBus } from "../bus/messageBus.ts";
import { NativeTextChannel, type NativeTextChannelConnector } from "./nativeTextChannel.ts";

describe("NativeTextChannel", () => {
  test("forwards lifecycle and outbound text frames to a native connector", async () => {
    const bus = new MessageBus();
    const connector: NativeTextChannelConnector = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      sendText: vi.fn(async () => undefined),
    };
    const channel = new NativeTextChannel({
      name: "feishu",
      displayName: "Feishu",
      config: { allowFrom: ["user-1"] },
      bus,
      connector,
    });

    await channel.start();
    await channel.send({
      channel: "feishu",
      chatId: "oc_1",
      content: "hello native channel",
      media: ["file://image.png"],
      metadata: { reply_to_message_id: "om_1" },
      replyTo: "om_1",
    });
    await channel.stop();

    expect(connector.start).toHaveBeenCalledOnce();
    expect(connector.sendText).toHaveBeenCalledWith({
      channel: "feishu",
      chatId: "oc_1",
      content: "hello native channel",
      media: ["file://image.png"],
      metadata: { reply_to_message_id: "om_1" },
      replyTo: "om_1",
    });
    expect(connector.stop).toHaveBeenCalledOnce();
    expect(channel.isRunning).toBe(false);
  });

  test("uses BaseChannel allow-list handling and marks streaming-capable inbound messages", async () => {
    const bus = new MessageBus();
    const connector: NativeTextChannelConnector = {
      sendText: vi.fn(async () => undefined),
      sendDelta: vi.fn(async () => undefined),
    };
    const channel = new NativeTextChannel({
      name: "feishu",
      displayName: "Feishu",
      config: { allow_from: ["user-1"], streaming: true },
      bus,
      connector,
    });

    await expect(channel.handleMessage({
      senderId: "blocked",
      chatId: "oc_1",
      content: "ignored",
    })).resolves.toBe(false);
    await expect(channel.handleMessage({
      senderId: "user-1",
      chatId: "oc_1",
      content: "hello",
      metadata: { message_id: "om_1" },
    })).resolves.toBe(true);

    await expect(bus.consumeInboundWithTimeout(1)).resolves.toMatchObject({
      channel: "feishu",
      senderId: "user-1",
      chatId: "oc_1",
      content: "hello",
      metadata: { message_id: "om_1", _wants_stream: true },
      sessionKeyOverride: null,
    });
  });

  test("routes stream deltas and usage frames only when the connector supports them", async () => {
    const bus = new MessageBus();
    const connector: NativeTextChannelConnector = {
      sendText: vi.fn(async () => undefined),
      sendDelta: vi.fn(async () => undefined),
      sendUsage: vi.fn(async () => undefined),
    };
    const channel = new NativeTextChannel({
      name: "websocket",
      displayName: "WebSocket",
      config: { allowFrom: ["*"], streaming: true },
      bus,
      connector,
    });

    expect(channel.supportsStreaming).toBe(true);
    await channel.sendDelta("chat-1", "partial", { _stream_delta: true });
    await channel.sendUsage("chat-1", { total_tokens: 3 });

    expect(connector.sendDelta).toHaveBeenCalledWith("chat-1", "partial", { _stream_delta: true });
    expect(connector.sendUsage).toHaveBeenCalledWith("chat-1", { total_tokens: 3 });

    const plain = new NativeTextChannel({
      name: "dingtalk",
      displayName: "DingTalk",
      config: { allowFrom: ["*"], streaming: true },
      bus,
      connector: { sendText: vi.fn(async () => undefined) },
    });
    expect(plain.supportsStreaming).toBe(false);
    await plain.sendDelta("chat-2", "ignored", { _stream_delta: true });
    await plain.sendUsage("chat-2", { total_tokens: 5 });
  });
});
