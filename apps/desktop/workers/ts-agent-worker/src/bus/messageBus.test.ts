import { describe, expect, test } from "vitest";

import { MessageBus } from "./messageBus.ts";
import { sessionKeyOf, type InboundMessage, type OutboundMessage } from "./messageTypes.ts";

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

function outbound(overrides: Partial<OutboundMessage> = {}): OutboundMessage {
  return {
    channel: "websocket",
    chatId: "chat-1",
    content: "hello",
    media: [],
    metadata: {},
    ...overrides,
  };
}

describe("MessageBus", () => {
  test("derives Python-compatible session keys", () => {
    expect(sessionKeyOf(inbound())).toBe("websocket:chat-1");
    expect(sessionKeyOf(inbound({ sessionKeyOverride: "thread:42" }))).toBe("thread:42");
    expect(sessionKeyOf(inbound({ sessionKeyOverride: "" }))).toBe("websocket:chat-1");
  });

  test("publishes and consumes inbound and outbound messages in order", async () => {
    const bus = new MessageBus();

    await bus.publishInbound(inbound({ content: "one" }));
    await bus.publishInbound(inbound({ content: "two" }));
    await bus.publishOutbound(outbound({ content: "reply-one" }));
    await bus.publishOutbound(outbound({ content: "reply-two" }));

    expect(bus.stats()).toMatchObject({ inboundSize: 2, outboundSize: 2 });
    await expect(bus.consumeInbound()).resolves.toMatchObject({ content: "one" });
    await expect(bus.consumeInbound()).resolves.toMatchObject({ content: "two" });
    await expect(bus.consumeOutbound()).resolves.toMatchObject({ content: "reply-one" });
    await expect(bus.consumeOutbound()).resolves.toMatchObject({ content: "reply-two" });
    expect(bus.stats()).toMatchObject({ inboundSize: 0, outboundSize: 0 });
  });

  test("non-blocking inbound consumption returns immediately in FIFO order", async () => {
    const bus = new MessageBus();

    expect(bus.tryConsumeInbound()).toBeNull();
    await bus.publishInbound(inbound({ content: "one" }));
    await bus.publishInbound(inbound({ content: "two" }));

    expect(bus.tryConsumeInbound()).toMatchObject({ content: "one" });
    expect(bus.tryConsumeInbound()).toMatchObject({ content: "two" });
    expect(bus.tryConsumeInbound()).toBeNull();
  });

  test("non-blocking outbound consumption returns immediately in FIFO order", async () => {
    const bus = new MessageBus();

    expect(bus.tryConsumeOutbound()).toBeNull();
    await bus.publishOutbound(outbound({ content: "reply-one" }));
    await bus.publishOutbound(outbound({ content: "reply-two" }));

    expect(bus.tryConsumeOutbound()).toMatchObject({ content: "reply-one" });
    expect(bus.tryConsumeOutbound()).toMatchObject({ content: "reply-two" });
    expect(bus.tryConsumeOutbound()).toBeNull();
  });

  test("waits for the first batch item then drains immediately available messages", async () => {
    const bus = new MessageBus();

    const inboundBatch = bus.consumeInboundBatch({ maxBatch: 3, timeoutMs: 50 });
    await bus.publishInbound(inbound({ content: "one" }));
    await bus.publishInbound(inbound({ content: "two" }));
    await bus.publishInbound(inbound({ content: "three" }));
    await bus.publishInbound(inbound({ content: "four" }));

    await expect(inboundBatch).resolves.toEqual([
      expect.objectContaining({ content: "one" }),
      expect.objectContaining({ content: "two" }),
      expect.objectContaining({ content: "three" }),
    ]);
    await expect(bus.consumeInboundWithTimeout(1)).resolves.toMatchObject({ content: "four" });

    const outboundBatch = bus.consumeOutboundBatch({ maxBatch: 2, timeoutMs: 50 });
    await bus.publishOutbound(outbound({ content: "reply-one" }));
    await bus.publishOutbound(outbound({ content: "reply-two" }));
    await bus.publishOutbound(outbound({ content: "reply-three" }));

    await expect(outboundBatch).resolves.toEqual([
      expect.objectContaining({ content: "reply-one" }),
      expect.objectContaining({ content: "reply-two" }),
    ]);
    await expect(bus.consumeOutbound()).resolves.toMatchObject({ content: "reply-three" });
  });

  test("returns empty or null on timeout without consuming later messages", async () => {
    const bus = new MessageBus();

    await expect(bus.consumeInboundBatch({ timeoutMs: 1 })).resolves.toEqual([]);
    await expect(bus.consumeInboundWithTimeout(1)).resolves.toBeNull();

    await bus.publishInbound(inbound({ content: "after-timeout" }));
    await expect(bus.consumeInbound()).resolves.toMatchObject({ content: "after-timeout" });
  });

  test("records backlog warnings in diagnostics", async () => {
    const bus = new MessageBus({ warningThreshold: 1 });

    await bus.publishInbound(inbound({ content: "one" }));
    await bus.publishInbound(inbound({ content: "two" }));
    await bus.publishOutbound(outbound({ content: "reply-one" }));
    await bus.publishOutbound(outbound({ content: "reply-two" }));

    expect(bus.stats()).toMatchObject({
      inboundSize: 2,
      outboundSize: 2,
      warningThreshold: 1,
      warnings: [
        expect.objectContaining({ queue: "inbound", size: 2, threshold: 1 }),
        expect.objectContaining({ queue: "outbound", size: 2, threshold: 1 }),
      ],
    });
  });

  test("unblocks consumers after close", async () => {
    const bus = new MessageBus();

    const inboundWait = bus.consumeInbound();
    const outboundWait = bus.consumeOutbound();
    bus.close();

    await expect(inboundWait).resolves.toBeNull();
    await expect(outboundWait).resolves.toBeNull();
    expect(bus.stats()).toMatchObject({ closed: true });
    await expect(bus.consumeInboundWithTimeout(1)).resolves.toBeNull();
  });
});
