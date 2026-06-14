import { describe, expect, test } from "vitest";

import { selectHeartbeatTarget } from "./heartbeatTarget";

describe("heartbeat target selector", () => {
  test("picks the newest enabled external session and skips internal or disabled channels", () => {
    expect(selectHeartbeatTarget({
      enabledChannels: ["feishu", "websocket"],
      sessions: [
        { key: "cli:direct", updatedAtMs: 500 },
        { key: "system:events", updatedAtMs: 400 },
        { key: "dingtalk:chat-disabled", updatedAtMs: 900 },
        { key: "websocket:chat-older", updatedAtMs: 100 },
        { key: "feishu:chat-newer", updatedAtMs: 300 },
        { key: "broken", updatedAtMs: 1000 },
      ],
    })).toEqual({
      channel: "feishu",
      chatId: "chat-newer",
      external: true,
    });
  });

  test("falls back to cli direct when no routable external session exists", () => {
    expect(selectHeartbeatTarget({
      enabledChannels: ["feishu"],
      sessions: [
        { key: "cli:direct", updatedAtMs: 20 },
        { key: "system:events", updatedAtMs: 10 },
        { key: "websocket:chat-disabled", updatedAtMs: 30 },
        { key: "feishu:", updatedAtMs: 40 },
      ],
    })).toEqual({
      channel: "cli",
      chatId: "direct",
      external: false,
    });
  });
});
