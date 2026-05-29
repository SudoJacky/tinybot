import { describe, expect, test } from "vitest";
import type { GatewayHealth } from "./gatewayHttpClient";
import { resolveGatewayStatusView } from "./gatewayStatusView";

const baseHealth: GatewayHealth = {
  state: "offline",
  httpBaseUrl: "http://127.0.0.1:18790",
  wsUrl: "ws://127.0.0.1:18790/ws",
  tokenReady: false,
  http: { ok: false, error: "failed" },
  webSocket: { ok: false, error: "not checked" },
  checkedAt: "2026-05-29T00:00:00Z",
};

describe("gateway status view", () => {
  test("does not display offline when the shell can reach an external gateway", () => {
    expect(
      resolveGatewayStatusView(baseHealth, {
        state: "running",
        owner: "external",
        http_ok: true,
      }),
    ).toMatchObject({
      statusText: "Reachable (API health failed)",
      hostedReady: true,
      nativeReady: false,
      dotState: "idle",
    });
  });

  test("keeps native features enabled only when HTTP and WebSocket health pass", () => {
    expect(resolveGatewayStatusView({ ...baseHealth, state: "running" }, null)).toMatchObject({
      statusText: "Running",
      hostedReady: true,
      nativeReady: true,
      dotState: "ok",
    });
  });
});
