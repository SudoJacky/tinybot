import { describe, expect, test, vi } from "vitest";

import { createNativeChannelConnectorBridgeRegistry } from "./nativeChannelConnectorBridge.ts";

describe("nativeChannelConnectorBridge", () => {
  test("forwards native text connector operations to host RPC methods", async () => {
    const request = vi.fn(async () => ({ ok: true }));
    const registry = createNativeChannelConnectorBridgeRegistry({
      rpcClient: { request },
      channels: ["feishu"],
    });
    const connector = registry.feishu;

    await connector?.start?.();
    await connector?.sendText({
      channel: "feishu",
      chatId: "chat-1",
      content: "hello",
      media: ["file://image.png"],
      metadata: { reply_kind: "text" },
      replyTo: "message-1",
    });
    await connector?.sendDelta?.("chat-1", "partial", { stream_id: "stream-1" });
    await connector?.sendUsage?.("chat-1", { input_tokens: 3, output_tokens: 5 });
    await connector?.stop?.();

    expect(request).toHaveBeenNthCalledWith(1, "channel.connector.feishu.start", "channel.connector.start", {
      channel: "feishu",
    });
    expect(request).toHaveBeenNthCalledWith(2, "channel.connector.feishu.send_text", "channel.connector.send_text", {
      channel: "feishu",
      chat_id: "chat-1",
      content: "hello",
      media: ["file://image.png"],
      metadata: { reply_kind: "text" },
      reply_to: "message-1",
    });
    expect(request).toHaveBeenNthCalledWith(3, "channel.connector.feishu.send_delta", "channel.connector.send_delta", {
      channel: "feishu",
      chat_id: "chat-1",
      delta: "partial",
      metadata: { stream_id: "stream-1" },
    });
    expect(request).toHaveBeenNthCalledWith(4, "channel.connector.feishu.send_usage", "channel.connector.send_usage", {
      channel: "feishu",
      chat_id: "chat-1",
      usage: { input_tokens: 3, output_tokens: 5 },
    });
    expect(request).toHaveBeenNthCalledWith(5, "channel.connector.feishu.stop", "channel.connector.stop", {
      channel: "feishu",
    });
  });

  test("rejects host RPC responses that report an unavailable native connector", async () => {
    const request = vi.fn(async () => ({
      ok: true,
      channel: "feishu",
      operation: "send_text",
      handled: false,
      reason: "native_connector_unavailable",
    }));
    const registry = createNativeChannelConnectorBridgeRegistry({
      rpcClient: { request },
      channels: ["feishu"],
    });

    await expect(registry.feishu?.sendText({
      channel: "feishu",
      chatId: "chat-1",
      content: "hello",
      media: [],
      metadata: {},
    })).rejects.toThrow("native connector feishu send_text unavailable: native_connector_unavailable");
  });
});
