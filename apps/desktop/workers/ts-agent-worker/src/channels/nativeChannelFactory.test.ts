import { describe, expect, test, vi } from "vitest";

import { MessageBus } from "../bus/messageBus.ts";
import { parseTinybotConfig } from "../config/configSchema.ts";
import { ChannelManager } from "./channelManager.ts";
import { createNativeTextChannelAdapters } from "./nativeChannelFactory.ts";
import type { NativeTextChannelConnector } from "./nativeTextChannel.ts";

describe("nativeChannelFactory", () => {
  test("creates native text adapters for enabled channels that have connectors", async () => {
    const bus = new MessageBus();
    const feishuConnector: NativeTextChannelConnector = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      sendText: vi.fn(async () => undefined),
      sendDelta: vi.fn(async () => undefined),
      transcribeAudio: vi.fn(async () => "voice text"),
    };
    const dingtalkConnector: NativeTextChannelConnector = {
      sendText: vi.fn(async () => undefined),
    };
    const config = parseTinybotConfig({
      channels: {
        feishu: {
          enabled: true,
          allow_from: ["ou_1"],
          streaming: true,
        },
        dingtalk: {
          enabled: true,
          client_id: "cid",
          allow_from: ["ding-user"],
        },
        weixin: {
          enabled: true,
          allow_from: ["wx-user"],
        },
      },
    });

    const result = createNativeTextChannelAdapters({
      config,
      bus,
      connectors: {
        feishu: feishuConnector,
        dingtalk: dingtalkConnector,
      },
      transcriptionApiKey: "groq-key",
    });

    expect(result.skipped).toEqual([{ name: "weixin", reason: "missing_connector" }]);
    expect(result.adapters.map((adapter) => adapter.name)).toEqual(["feishu", "dingtalk"]);
    expect(result.adapters.map((adapter) => adapter.displayName)).toEqual(["Feishu", "DingTalk"]);
    expect(result.adapters.map((adapter) => adapter.supportsStreaming)).toEqual([true, false]);
    await expect(result.adapters[0]?.transcribeAudio("voice.opus")).resolves.toBe("voice text");
    expect(feishuConnector.transcribeAudio).toHaveBeenCalledWith("voice.opus", "groq-key");

    await expect(result.adapters[0]?.handleMessage({
      senderId: "ou_1",
      chatId: "oc_1",
      content: "hello native feishu",
    })).resolves.toBe(true);
    await expect(bus.consumeInboundWithTimeout(1)).resolves.toMatchObject({
      channel: "feishu",
      senderId: "ou_1",
      chatId: "oc_1",
      metadata: { _wants_stream: true },
    });

    const manager = new ChannelManager({ bus, channels: result.adapters });
    await bus.publishOutbound({
      channel: "dingtalk",
      chatId: "ding-chat",
      content: "native dingtalk reply",
      media: [],
      metadata: {},
    });

    await expect(manager.dispatchAvailable()).resolves.toBe(1);
    expect(dingtalkConnector.sendText).toHaveBeenCalledWith({
      channel: "dingtalk",
      chatId: "ding-chat",
      content: "native dingtalk reply",
      media: [],
      metadata: {},
      replyTo: null,
    });
  });

  test("rejects enabled native channels with an explicit empty allowFrom list", () => {
    const bus = new MessageBus();
    const feishuConnector: NativeTextChannelConnector = {
      sendText: vi.fn(async () => undefined),
    };
    const config = parseTinybotConfig({
      channels: {
        feishu: {
          enabled: true,
          allow_from: [],
        },
      },
    });

    expect(() => createNativeTextChannelAdapters({
      config,
      bus,
      connectors: {
        feishu: feishuConnector,
      },
    })).toThrow(
      'Error: "feishu" has empty allowFrom (denies all). Set ["*"] to allow everyone, or add specific user IDs.',
    );
  });
});
