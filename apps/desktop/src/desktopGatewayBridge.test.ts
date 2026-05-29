import { describe, expect, test, vi } from "vitest";
import {
  installDesktopGatewayBridge,
  rewriteGatewayRequest,
  rewriteGatewayWebSocketUrl,
} from "./desktopGatewayBridge";
import { DEFAULT_GATEWAY_CONFIG } from "./gatewayConfig";

const pageOrigin = "http://desktop.local";
const localPageOrigin = "http://127.0.0.1:1420";

describe("desktop gateway bridge", () => {
  test("rewrites known gateway request paths to the local gateway", () => {
    expect(String(rewriteGatewayRequest("/api/sessions", DEFAULT_GATEWAY_CONFIG, pageOrigin))).toBe(
      "http://127.0.0.1:18790/api/sessions",
    );
    expect(String(rewriteGatewayRequest("/v1/knowledge/query?limit=5", DEFAULT_GATEWAY_CONFIG, pageOrigin))).toBe(
      "http://127.0.0.1:18790/v1/knowledge/query?limit=5",
    );
  });

  test("preserves Request method, headers, body, cache options, and abort signals", async () => {
    const controller = new AbortController();
    const input = new Request(`${pageOrigin}/api/config`, {
      method: "PATCH",
      headers: { Authorization: "Bearer token-1", "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "openai" }),
      cache: "no-store",
      signal: controller.signal,
    });

    const rewritten = rewriteGatewayRequest(input, DEFAULT_GATEWAY_CONFIG, pageOrigin);

    expect(rewritten).toBeInstanceOf(Request);
    const request = rewritten as Request;
    expect(request.url).toBe("http://127.0.0.1:18790/api/config");
    expect(request.method).toBe("PATCH");
    expect(request.headers.get("Authorization")).toBe("Bearer token-1");
    expect(request.cache).toBe("no-store");
    controller.abort();
    expect(request.signal.aborted).toBe(true);
    expect(await request.text()).toBe(JSON.stringify({ provider: "openai" }));
  });

  test("leaves static, docs, third-party, and unrelated requests unchanged", () => {
    const staticRequest = "/assets/styles/main.css";
    const docsRequest = "/docs/index.html";
    const unrelatedRequest = "/favicon.ico";
    const thirdParty = "https://example.com/api/sessions";

    expect(rewriteGatewayRequest(staticRequest, DEFAULT_GATEWAY_CONFIG, pageOrigin)).toBe(staticRequest);
    expect(rewriteGatewayRequest(docsRequest, DEFAULT_GATEWAY_CONFIG, pageOrigin)).toBe(docsRequest);
    expect(rewriteGatewayRequest(unrelatedRequest, DEFAULT_GATEWAY_CONFIG, pageOrigin)).toBe(unrelatedRequest);
    expect(rewriteGatewayRequest(thirdParty, DEFAULT_GATEWAY_CONFIG, pageOrigin)).toBe(thirdParty);
  });

  test("routes token refresh and preserves authorization through the installed fetch adapter", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    const target = {
      location: { origin: pageOrigin },
      fetch: fetchMock,
      WebSocket: class TestWebSocket {} as unknown as typeof WebSocket,
    } as unknown as typeof globalThis;
    const bridge = installDesktopGatewayBridge({
      config: DEFAULT_GATEWAY_CONFIG,
      pageOrigin,
      fetchTarget: target,
      webSocketTarget: target,
    });

    await target.fetch("/webui/refresh-token", {
      method: "POST",
      headers: { Authorization: "Bearer token-1" },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:18790/webui/refresh-token",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer token-1" }),
      }),
    );
    bridge.restore();
  });

  test("routes WebUI WebSocket URLs with original query parameters", () => {
    expect(String(rewriteGatewayWebSocketUrl("/ws?token=abc&chat=1", DEFAULT_GATEWAY_CONFIG, pageOrigin))).toBe(
      "ws://127.0.0.1:18790/ws?token=abc&chat=1",
    );
    expect(String(rewriteGatewayWebSocketUrl(`${pageOrigin}/ws?token=abc`, DEFAULT_GATEWAY_CONFIG, pageOrigin))).toBe(
      "ws://127.0.0.1:18790/ws?token=abc",
    );
    expect(
      String(rewriteGatewayWebSocketUrl("ws://127.0.0.1:1420/ws?token=abc", DEFAULT_GATEWAY_CONFIG, localPageOrigin)),
    ).toBe("ws://127.0.0.1:18790/ws?token=abc");
    expect(rewriteGatewayWebSocketUrl("wss://example.com/ws?token=abc", DEFAULT_GATEWAY_CONFIG, pageOrigin)).toBe(
      "wss://example.com/ws?token=abc",
    );
  });
});
