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
    });

    expect(result.skipped).toEqual([{ name: "weixin", reason: "missing_connector" }]);
    expect(result.adapters.map((adapter) => adapter.name)).toEqual(["feishu", "dingtalk"]);
    expect(result.adapters.map((adapter) => adapter.displayName)).toEqual(["Feishu", "DingTalk"]);
    expect(result.adapters.map((adapter) => adapter.supportsStreaming)).toEqual([true, false]);

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
});
