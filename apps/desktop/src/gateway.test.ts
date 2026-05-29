import { describe, expect, test, vi } from "vitest";
import { DEFAULT_GATEWAY_CONFIG, resolveGatewayConfig } from "./gatewayConfig";
import {
  checkGatewayHealth,
  createGatewayApiClient,
} from "./gatewayHttpClient";
import {
  createGatewaySocketMessage,
  flushGatewaySocketQueue,
  normalizeGatewayFrame,
  sendGatewaySocketJson,
} from "./gatewayWebSocketClient";

describe("gateway config", () => {
  test("builds default local HTTP and WebSocket endpoints", () => {
    expect(DEFAULT_GATEWAY_CONFIG.httpBaseUrl).toBe("http://127.0.0.1:18790");
    expect(DEFAULT_GATEWAY_CONFIG.wsUrl).toBe("ws://127.0.0.1:18790/ws");
  });

  test("normalizes provided URLs without duplicate slashes", () => {
    const config = resolveGatewayConfig({
      httpBaseUrl: "http://localhost:18790/",
      wsUrl: "ws://localhost:18790/ws",
      requestTimeoutMs: 250,
    });

    expect(config.httpBaseUrl).toBe("http://localhost:18790");
    expect(config.wsUrl).toBe("ws://localhost:18790/ws");
    expect(config.requestTimeoutMs).toBe(250);
  });
});

describe("gateway HTTP client", () => {
  test("reports a reachable gateway when HTTP and WebSocket checks pass", async () => {
    const fetchFn = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => {
      if (String(url).endsWith("/webui/bootstrap")) {
        return new Response(JSON.stringify({ token: "token-1", ws_path: "/ws" }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const webSocketProbe = vi.fn(async () => ({ ok: true as const }));

    const result = await checkGatewayHealth({
      config: DEFAULT_GATEWAY_CONFIG,
      fetchFn,
      webSocketProbe,
    });

    expect(result.state).toBe("running");
    expect(result.http.ok).toBe(true);
    expect(result.webSocket.ok).toBe(true);
    expect(fetchFn).toHaveBeenCalledWith(
      "http://127.0.0.1:18790/webui/bootstrap",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(fetchFn).toHaveBeenCalledWith(
      "http://127.0.0.1:18790/api/status",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer token-1" }),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(webSocketProbe).toHaveBeenCalledWith(
      "ws://127.0.0.1:18790/ws?token=token-1",
      DEFAULT_GATEWAY_CONFIG.requestTimeoutMs,
    );
  });

  test("keeps endpoint details when the gateway is offline", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED");
    });

    const result = await checkGatewayHealth({
      config: DEFAULT_GATEWAY_CONFIG,
      fetchFn,
      webSocketProbe: async () => ({ ok: false as const, error: "not checked" }),
    });

    expect(result.state).toBe("offline");
    expect(result.http.ok).toBe(false);
    if (!result.http.ok) {
      expect(result.http.error).toContain("ECONNREFUSED");
    }
    expect(result.httpBaseUrl).toBe(DEFAULT_GATEWAY_CONFIG.httpBaseUrl);
    expect(result.wsUrl).toBe(DEFAULT_GATEWAY_CONFIG.wsUrl);
  });

  test("constructs shared route group requests", async () => {
    const fetchFn = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => {
      if (String(url).endsWith("/webui/bootstrap")) {
        return new Response(JSON.stringify({ token: "token-1" }), { status: 200 });
      }
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    });
    const client = createGatewayApiClient({
      config: DEFAULT_GATEWAY_CONFIG,
      fetchFn,
    });

    await client.sessions.list();
    await client.sessions.messages("WebSocket:chat-1");
    await client.knowledge.documents();
    await client.workspace.file("docs/readme.md");
    await client.cowork.summary("cowork-1");

    expect(fetchFn.mock.calls.map((call) => String((call as unknown[])[0]))).toEqual([
      "http://127.0.0.1:18790/webui/bootstrap",
      "http://127.0.0.1:18790/api/sessions",
      "http://127.0.0.1:18790/api/sessions/WebSocket%3Achat-1/messages",
      "http://127.0.0.1:18790/v1/knowledge/documents",
      "http://127.0.0.1:18790/api/workspace/files/docs%2Freadme.md",
      "http://127.0.0.1:18790/api/cowork/sessions/cowork-1/summary",
    ]);
    for (const call of fetchFn.mock.calls.slice(1)) {
      expect((call[1] as RequestInit).headers).toMatchObject({
        Authorization: "Bearer token-1",
      });
    }
  });
});

describe("gateway WebSocket client", () => {
  test("creates outbound chat control messages", () => {
    expect(createGatewaySocketMessage.newChat()).toEqual({ type: "new_chat" });
    expect(createGatewaySocketMessage.attach("chat-1")).toEqual({
      type: "attach",
      chat_id: "chat-1",
    });
    expect(createGatewaySocketMessage.message("chat-1", "hello", true)).toEqual({
      type: "message",
      chat_id: "chat-1",
      content: "hello",
      use_persistent_rag: true,
    });
    expect(createGatewaySocketMessage.interrupt("chat-1")).toEqual({
      type: "interrupt",
      chat_id: "chat-1",
    });
  });

  test("queues outbound messages until the socket is open", () => {
    const sent: string[] = [];
    const queue: unknown[] = [];
    const connectingSocket = {
      readyState: 0,
      send: (value: string) => sent.push(value),
    };
    const openSocket = {
      readyState: 1,
      send: (value: string) => sent.push(value),
    };

    expect(sendGatewaySocketJson(connectingSocket, { type: "new_chat" }, queue)).toBe("queued");
    expect(sent).toEqual([]);
    expect(queue).toEqual([{ type: "new_chat" }]);

    expect(flushGatewaySocketQueue(openSocket, queue)).toBe(1);
    expect(sent).toEqual([JSON.stringify({ type: "new_chat" })]);
    expect(queue).toEqual([]);
  });

  test("normalizes stream, browser, and agent-ui frames", () => {
    expect(normalizeGatewayFrame({ event: "attached", chat_id: "chat-1" })).toMatchObject({
      kind: "attached",
      chatId: "chat-1",
    });
    expect(normalizeGatewayFrame({ event: "delta", text: "hi", message_id: "m1" })).toMatchObject({
      kind: "message.delta",
      text: "hi",
      messageId: "m1",
    });
    expect(normalizeGatewayFrame({ event: "delta", text: "plan", is_reasoning: true })).toMatchObject({
      kind: "message.delta",
      reasoning: true,
    });
    expect(normalizeGatewayFrame({ event: "message", text: "done", message_id: "m2" })).toMatchObject({
      kind: "message.completed",
      text: "done",
      messageId: "m2",
    });
    expect(normalizeGatewayFrame({ event: "stream_end", chat_id: "chat-1" })).toMatchObject({
      kind: "message.stream.completed",
      chatId: "chat-1",
    });
    expect(normalizeGatewayFrame({ event: "browser_frame", image: "data:image/png;base64,x" })).toMatchObject({
      kind: "browser.frame",
    });
    expect(normalizeGatewayFrame({ event: "agent_ui_form", form: { form_id: "form-1" } })).toMatchObject({
      kind: "agent-ui.form",
    });
    expect(
      normalizeGatewayFrame({
        event: "agent_ui_event",
        agent_ui_event: { event_type: "ui.form.requested", payload: { form_id: "form-1" } },
      }),
    ).toMatchObject({
      kind: "agent-ui.event",
      eventType: "ui.form.requested",
    });
  });
});
