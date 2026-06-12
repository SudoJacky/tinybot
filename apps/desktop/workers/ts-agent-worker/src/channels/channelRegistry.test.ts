import { describe, expect, test } from "vitest";

import {
  builtinChannelDescriptors,
  channelDescriptorByName,
  selectChannelDefaultConfigs,
} from "./channelRegistry.ts";

describe("channelRegistry", () => {
  test("lists built-in channel descriptors without relying on Python entry points", () => {
    expect(builtinChannelDescriptors().map((descriptor) => descriptor.name)).toEqual([
      "websocket",
      "feishu",
      "dingtalk",
      "weixin",
    ]);
    expect(channelDescriptorByName("websocket")).toMatchObject({
      name: "websocket",
      displayName: "WebSocket",
      builtin: true,
      capabilities: { streaming: true, login: false, media: true, usage: true },
    });
    expect(channelDescriptorByName("feishu")).toMatchObject({
      displayName: "Feishu",
      capabilities: { streaming: true, login: false, media: true },
    });
  });

  test("exposes Python-compatible default config payloads for onboarding", () => {
    expect(selectChannelDefaultConfigs()).toMatchObject({
      websocket: {
        enabled: false,
        host: "127.0.0.1",
        port: 18790,
        streaming: true,
        allowFrom: ["*"],
      },
      feishu: {
        enabled: false,
        appId: "",
        appSecret: "",
        allowFrom: [],
        streaming: true,
        groupPolicy: "mention",
      },
      dingtalk: {
        enabled: false,
        clientId: "",
        clientSecret: "",
        allowFrom: [],
      },
      weixin: {
        enabled: false,
        allowFrom: [],
        baseUrl: "https://ilinkai.weixin.qq.com",
      },
    });
  });
});
