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
    expect(String(rewriteGatewayRequest("/webui/bootstrap", DEFAULT_GATEWAY_CONFIG, pageOrigin))).toBe(
      "http://127.0.0.1:18790/webui/bootstrap",
    );
    expect(String(rewriteGatewayRequest("/api/sessions", DEFAULT_GATEWAY_CONFIG, pageOrigin))).toBe(
      "http://127.0.0.1:18790/api/sessions",
    );
    expect(String(rewriteGatewayRequest("/api/cowork/sessions?include_completed=1", DEFAULT_GATEWAY_CONFIG, pageOrigin))).toBe(
      "http://127.0.0.1:18790/api/cowork/sessions?include_completed=1",
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
    const iconRequest = "/assets/logo-mark.svg";
    const docsRequest = "/docs/index.html";
    const unrelatedRequest = "/favicon.ico";
    const thirdParty = "https://example.com/api/sessions";

    expect(rewriteGatewayRequest(staticRequest, DEFAULT_GATEWAY_CONFIG, pageOrigin)).toBe(staticRequest);
    expect(rewriteGatewayRequest(iconRequest, DEFAULT_GATEWAY_CONFIG, pageOrigin)).toBe(iconRequest);
    expect(rewriteGatewayRequest(docsRequest, DEFAULT_GATEWAY_CONFIG, pageOrigin)).toBe(docsRequest);
    expect(rewriteGatewayRequest(unrelatedRequest, DEFAULT_GATEWAY_CONFIG, pageOrigin)).toBe(unrelatedRequest);
    expect(rewriteGatewayRequest(thirdParty, DEFAULT_GATEWAY_CONFIG, pageOrigin)).toBe(thirdParty);
  });

  test("rewrites tools and skills module requests with original methods and bodies", async () => {
    const toolList = rewriteGatewayRequest("/api/tools", DEFAULT_GATEWAY_CONFIG, pageOrigin);
    expect(String(toolList)).toBe("http://127.0.0.1:18790/api/tools");

    const skillCreate = new Request(`${pageOrigin}/api/skills`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "desktop-skill", content: "# Skill" }),
    });
    const rewrittenCreate = rewriteGatewayRequest(skillCreate, DEFAULT_GATEWAY_CONFIG, pageOrigin);
    expect(rewrittenCreate).toBeInstanceOf(Request);
    const createRequest = rewrittenCreate as Request;
    expect(createRequest.url).toBe("http://127.0.0.1:18790/api/skills");
    expect(createRequest.method).toBe("POST");
    expect(createRequest.headers.get("Content-Type")).toBe("application/json");
    expect(await createRequest.text()).toBe(JSON.stringify({ name: "desktop-skill", content: "# Skill" }));

    const encodedSkillName = encodeURIComponent("folder/skill.md");
    const skillValidate = new Request(`${pageOrigin}/api/skills/${encodedSkillName}/validate`, {
      method: "POST",
      headers: { Authorization: "Bearer skill-token" },
      body: JSON.stringify({ content: "# Updated" }),
    });
    const rewrittenValidate = rewriteGatewayRequest(skillValidate, DEFAULT_GATEWAY_CONFIG, pageOrigin);
    expect(rewrittenValidate).toBeInstanceOf(Request);
    const validateRequest = rewrittenValidate as Request;
    expect(validateRequest.url).toBe(`http://127.0.0.1:18790/api/skills/${encodedSkillName}/validate`);
    expect(validateRequest.method).toBe("POST");
    expect(validateRequest.headers.get("Authorization")).toBe("Bearer skill-token");
    expect(await validateRequest.text()).toBe(JSON.stringify({ content: "# Updated" }));
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

  test("can route WebUI WebSocket traffic through the native TS transport shim", async () => {
    const dispatched: unknown[] = [];
    const target = {
      location: { origin: pageOrigin },
      fetch: vi.fn(),
      WebSocket: class TestWebSocket {
        static OPEN = 1;
        readyState = 0;
        constructor(readonly url: string | URL) {}
      } as unknown as typeof WebSocket,
    } as unknown as typeof globalThis;
    const bridge = installDesktopGatewayBridge({
      config: DEFAULT_GATEWAY_CONFIG,
      pageOrigin,
      fetchTarget: target,
      webSocketTarget: target,
      nativeTransport: {
        gatewayFrame: vi.fn(),
        websocketMessage: vi.fn(),
        dispatchWebsocketMessage: vi.fn(async (request) => {
          dispatched.push(request);
          const frame = request.frame;
          if (frame.type === "new_chat") {
            return {
              transport: {
                kind: "new_chat",
                chatId: "chat-native",
                sessionId: "websocket:chat-native",
                attachedChatId: "chat-native",
                frames: [{ event: "chat_created", chat_id: "chat-native" }],
              },
            };
          }
          return {
            transport: {
              kind: "message",
              chatId: "chat-native",
              sessionId: "websocket:chat-native",
              frames: [],
            },
            agent: {
              finalContent: "native done",
              stopReason: "final_response",
            },
          };
        }),
      },
    });

    const socket = new target.WebSocket("/ws?token=abc");
    const events: Array<Record<string, unknown>> = [];
    socket.addEventListener("message", (event) => {
      events.push(JSON.parse(String((event as MessageEvent).data)) as Record<string, unknown>);
    });
    await flushMicrotasks();

    expect(socket.readyState).toBe(WebSocket.OPEN);
    expect(events).toContainEqual(expect.objectContaining({ event: "ready", client_id: expect.any(String) }));

    socket.send(JSON.stringify({ type: "new_chat" }));
    await flushMicrotasks();
    socket.send(JSON.stringify({ type: "message", chat_id: "chat-native", content: "hello" }));
    await flushMicrotasks();

    expect(events).toContainEqual({ event: "chat_created", chat_id: "chat-native" });
    expect(events).toContainEqual(expect.objectContaining({
      event: "message",
      chat_id: "chat-native",
      text: "native done",
    }));
    expect(dispatched).toEqual([
      expect.objectContaining({
        clientId: expect.any(String),
        frame: { type: "new_chat" },
      }),
      expect.objectContaining({
        attachedChatId: "chat-native",
        clientId: expect.any(String),
        frame: { type: "message", chat_id: "chat-native", content: "hello" },
      }),
    ]);

    bridge.restore();
  });
});

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
