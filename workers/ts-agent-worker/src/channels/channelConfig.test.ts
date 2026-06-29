import { describe, expect, test } from "vitest";

import { parseTinybotConfig } from "../config/configSchema.ts";
import {
  selectChannelConfig,
  selectChannelDeliveryOptions,
  selectEnabledChannelConfigs,
} from "./channelConfig.ts";

describe("channelConfig", () => {
  test("selects delivery options from canonical channel config", () => {
    const config = parseTinybotConfig({
      channels: {
        send_progress: false,
        send_tool_hints: true,
        send_max_retries: 5,
      },
    });

    expect(selectChannelDeliveryOptions(config)).toEqual({
      sendProgress: false,
      sendToolHints: true,
      sendMaxRetries: 5,
    });
  });

  test("selects enabled built-in channel configs with defaults merged", () => {
    const config = parseTinybotConfig({
      channels: {
        websocket: { enabled: true, port: 19000 },
        feishu: { enabled: false, app_id: "ignored" },
        dingtalk: { enabled: true, client_id: "cid", allow_from: ["user-1"] },
        slack: { enabled: true },
      },
    });

    expect(selectEnabledChannelConfigs(config).map((entry) => entry.name)).toEqual(["websocket", "dingtalk"]);
    expect(selectChannelConfig(config, "websocket")).toMatchObject({
      enabled: true,
      host: "127.0.0.1",
      port: 19000,
      streaming: true,
      allowFrom: ["*"],
    });
    expect(selectChannelConfig(config, "dingtalk")).toMatchObject({
      enabled: true,
      clientId: "cid",
      clientSecret: "",
      allowFrom: ["user-1"],
    });
    expect(selectChannelConfig(config, "slack")).toBeUndefined();
  });
});
