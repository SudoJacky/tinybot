import { describe, expect, test, vi } from "vitest";

import { MessageBus } from "../bus/messageBus.ts";
import type { OutboundMessage } from "../bus/messageTypes.ts";
import { ChannelManager, type ChannelAdapter } from "./channelManager.ts";

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

function adapter(overrides: Partial<ChannelAdapter> = {}): ChannelAdapter {
  return {
    name: "websocket",
    displayName: "WebSocket",
    supportsStreaming: true,
    send: vi.fn(async () => undefined),
    sendDelta: vi.fn(async () => undefined),
    sendUsage: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("ChannelManager", () => {
  test("starts, stops, and reports registered channel status", async () => {
    const bus = new MessageBus();
    const websocket = adapter({
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    });
    const cli = adapter({
      name: "cli",
      displayName: "CLI",
      supportsStreaming: false,
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    });
    const manager = new ChannelManager({ bus, channels: [websocket, cli] });

    await manager.startAll();
    await manager.stopAll();

    expect(websocket.start).toHaveBeenCalledOnce();
    expect(cli.start).toHaveBeenCalledOnce();
    expect(websocket.stop).toHaveBeenCalledOnce();
    expect(cli.stop).toHaveBeenCalledOnce();
    expect(manager.enabledChannels()).toEqual(["websocket", "cli"]);
    expect(manager.status()).toMatchObject({
      running: false,
      channels: [
        { name: "websocket", displayName: "WebSocket", supportsStreaming: true, running: false },
        { name: "cli", displayName: "CLI", supportsStreaming: false, running: false },
      ],
    });
  });

  test("sends restart completion notice to the marked channel on start", async () => {
    const bus = new MessageBus();
    const websocket = adapter({
      start: vi.fn(async () => undefined),
    });
    const manager = new ChannelManager({
      bus,
      channels: [websocket],
      restartNotice: {
        channel: "websocket",
        chatId: "chat-1",
        startedAtUnixSeconds: 100,
      },
      nowUnixSeconds: () => 102.25,
    });

    await manager.startAll();

    expect(websocket.send).toHaveBeenCalledWith({
      channel: "websocket",
      chatId: "chat-1",
      content: "Restart completed in 2.3s.",
      media: [],
      metadata: { _restart_completed: true },
    });
  });

  test("dispatches ordinary outbound messages to their channel adapter", async () => {
    const bus = new MessageBus();
    const websocket = adapter();
    const manager = new ChannelManager({ bus, channels: [websocket] });

    await bus.publishOutbound(outbound({ content: "reply" }));

    await expect(manager.dispatchAvailable()).resolves.toBe(1);
    expect(websocket.send).toHaveBeenCalledWith(expect.objectContaining({ content: "reply" }));
  });

  test("routes usage and streaming metadata through channel-specific methods", async () => {
    const bus = new MessageBus();
    const websocket = adapter();
    const manager = new ChannelManager({ bus, channels: [websocket] });

    await bus.publishOutbound(outbound({ content: "", metadata: { _usage: true, usage_data: { input_tokens: 2 } } }));
    await bus.publishOutbound(outbound({ content: "delta", metadata: { _stream_delta: true } }));

    await expect(manager.dispatchAvailable()).resolves.toBe(2);
    expect(websocket.sendUsage).toHaveBeenCalledWith("chat-1", { input_tokens: 2 });
    expect(websocket.sendDelta).toHaveBeenCalledWith("chat-1", "delta", { _stream_delta: true });
    expect(websocket.send).not.toHaveBeenCalled();
  });

  test("does not send stream frames as ordinary messages when the channel has no delta sender", async () => {
    const bus = new MessageBus();
    const plain = adapter({
      supportsStreaming: false,
      sendDelta: undefined,
    });
    const manager = new ChannelManager({ bus, channels: [plain] });

    await bus.publishOutbound(outbound({ content: "delta", metadata: { _stream_delta: true } }));
    await bus.publishOutbound(outbound({ content: "reason", metadata: { _reasoning_delta: true } }));
    await bus.publishOutbound(outbound({ content: "", metadata: { _stream_end: true } }));

    await expect(manager.dispatchAvailable()).resolves.toBe(3);
    expect(plain.send).not.toHaveBeenCalled();
  });

  test("drops disabled progress frames and records unknown channel diagnostics", async () => {
    const bus = new MessageBus();
    const websocket = adapter();
    const manager = new ChannelManager({
      bus,
      channels: [websocket],
      sendProgress: false,
      sendToolHints: false,
    });

    await bus.publishOutbound(outbound({ content: "thinking", metadata: { _progress: true } }));
    await bus.publishOutbound(outbound({ content: "tool", metadata: { _progress: true, _tool_hint: true } }));
    await bus.publishOutbound(outbound({ channel: "missing", content: "lost" }));

    await expect(manager.dispatchAvailable()).resolves.toBe(0);
    expect(websocket.send).not.toHaveBeenCalled();
    expect(manager.diagnostics()).toEqual([
      expect.objectContaining({ kind: "dropped", reason: "progress_disabled", channel: "websocket" }),
      expect.objectContaining({ kind: "dropped", reason: "tool_hints_disabled", channel: "websocket" }),
      expect.objectContaining({ kind: "unknown_channel", channel: "missing" }),
    ]);
  });

  test("coalesces consecutive stream deltas for the same channel and chat", async () => {
    const bus = new MessageBus();
    const websocket = adapter();
    const manager = new ChannelManager({ bus, channels: [websocket] });

    await bus.publishOutbound(outbound({ content: "hel", metadata: { _stream_delta: true } }));
    await bus.publishOutbound(outbound({ content: "lo", metadata: { _stream_delta: true, _stream_end: true } }));
    await bus.publishOutbound(outbound({ content: "separate", chatId: "chat-2", metadata: { _stream_delta: true } }));

    await expect(manager.dispatchAvailable()).resolves.toBe(2);
    expect(websocket.sendDelta).toHaveBeenNthCalledWith(1, "chat-1", "hello", {
      _stream_delta: true,
      _stream_end: true,
    });
    expect(websocket.sendDelta).toHaveBeenNthCalledWith(2, "chat-2", "separate", { _stream_delta: true });
  });

  test("retries failed sends and records final failures without throwing", async () => {
    const bus = new MessageBus();
    const delays: number[] = [];
    const flaky = adapter({
      send: vi
        .fn()
        .mockRejectedValueOnce(new Error("temporary"))
        .mockResolvedValueOnce(undefined),
    });
    const broken = adapter({
      name: "broken",
      send: vi.fn(async () => {
        throw new Error("permanent");
      }),
    });
    const manager = new ChannelManager({
      bus,
      channels: [flaky, broken],
      retryDelaysMs: [10, 20],
      sleep: async (delay) => {
        delays.push(delay);
      },
    });

    await bus.publishOutbound(outbound({ content: "eventual" }));
    await bus.publishOutbound(outbound({ channel: "broken", content: "lost" }));

    await expect(manager.dispatchAvailable()).resolves.toBe(1);
    expect(flaky.send).toHaveBeenCalledTimes(2);
    expect(broken.send).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([10, 10, 20]);
    expect(manager.diagnostics()).toEqual([
      expect.objectContaining({ kind: "send_failed", channel: "broken", attempts: 3 }),
    ]);
  });
});
