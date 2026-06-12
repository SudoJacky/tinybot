import { describe, expect, test, vi } from "vitest";

import { MessageBus } from "../bus/messageBus.ts";
import type { OutboundMessage } from "../bus/messageTypes.ts";
import { BaseChannel, type BaseChannelConfig } from "./baseChannel.ts";

class TestChannel extends BaseChannel {
  readonly name = "test";
  readonly displayName = "Test";
  readonly sent: OutboundMessage[] = [];

  async start(): Promise<void> {
    this.setRunning(true);
  }

  async stop(): Promise<void> {
    this.setRunning(false);
  }

  async send(message: OutboundMessage): Promise<void> {
    this.sent.push(message);
  }
}

class StreamingTestChannel extends TestChannel {
  sendDelta = vi.fn(async () => undefined);
}

function createChannel(config: BaseChannelConfig = {}): { bus: MessageBus; channel: TestChannel } {
  const bus = new MessageBus();
  const channel = new TestChannel({ config, bus });
  return { bus, channel };
}

describe("BaseChannel", () => {
  test("denies inbound messages when allowFrom is empty", async () => {
    const { bus, channel } = createChannel({ allowFrom: [] });

    await expect(channel.handleMessage({
      senderId: "user-1",
      chatId: "chat-1",
      content: "hello",
    })).resolves.toBe(false);

    expect(channel.isAllowed("user-1")).toBe(false);
    expect(bus.stats()).toMatchObject({ inboundSize: 0 });
  });

  test("allows wildcard and publishes normalized inbound messages", async () => {
    const { bus, channel } = createChannel({ allowFrom: ["*"] });

    await expect(channel.handleMessage({
      senderId: "user-1",
      chatId: "chat-1",
      content: "hello",
      media: ["file://image.png"],
      metadata: { platform: "test" },
      sessionKey: "thread:42",
    })).resolves.toBe(true);

    await expect(bus.consumeInboundWithTimeout(1)).resolves.toMatchObject({
      channel: "test",
      senderId: "user-1",
      chatId: "chat-1",
      content: "hello",
      media: ["file://image.png"],
      metadata: { platform: "test" },
      sessionKeyOverride: "thread:42",
    });
  });

  test("allows specific senders and marks streaming-capable inbound messages", async () => {
    const bus = new MessageBus();
    const channel = new StreamingTestChannel({ config: { allowFrom: ["user-1"], streaming: true }, bus });

    expect(channel.supportsStreaming).toBe(true);
    await expect(channel.handleMessage({
      senderId: "user-1",
      chatId: "chat-1",
      content: "stream please",
      metadata: { existing: true },
    })).resolves.toBe(true);

    await expect(bus.consumeInboundWithTimeout(1)).resolves.toMatchObject({
      metadata: { existing: true, _wants_stream: true },
    });
  });
});
