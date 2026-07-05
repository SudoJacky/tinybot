// @vitest-environment happy-dom

import { beforeEach, describe, expect, test, vi } from "vitest";
import { createDesktopAppServices } from "./defaultServices";

const mocks = vi.hoisted(() => {
  const gatewayApi = {
    config: {
      get: vi.fn(async () => ({})),
      providers: vi.fn(async () => []),
    },
    knowledge: {
      documents: vi.fn(async () => []),
      stats: vi.fn(async () => []),
    },
    sessions: {
      list: vi.fn(),
      messages: vi.fn(),
      delete: vi.fn(async () => ({ deleted: true })),
      patch: vi.fn(async () => ({})),
    },
    skills: {
      list: vi.fn(async () => []),
    },
    workspace: {
      files: vi.fn(async () => []),
    },
  };
  return {
    checkGatewayHealth: vi.fn(async () => ({ tokenReady: false, wsUrl: "ws://tinybot.test/ws" })),
    createGatewayApiClient: vi.fn(() => gatewayApi),
    flushGatewaySocketQueue: vi.fn(() => 0),
    gatewayApi,
    openGatewaySocket: vi.fn((_config, handlers) => {
      return {
        addEventListener: vi.fn(),
        handlers,
        readyState: WebSocket.OPEN,
        send: vi.fn(),
      };
    }),
    sendGatewaySocketJson: vi.fn(() => "sent"),
  };
});

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("../app-core/gateway/gatewayHttpClient", () => ({
  DEFAULT_TS_COWORK_RUNTIME_ROLLOUT: "off",
  checkGatewayHealth: mocks.checkGatewayHealth,
  createGatewayApiClient: mocks.createGatewayApiClient,
}));
vi.mock("../app-core/gateway/gatewayWebSocketClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../app-core/gateway/gatewayWebSocketClient")>();
  return {
    ...actual,
    flushGatewaySocketQueue: mocks.flushGatewaySocketQueue,
    openGatewaySocket: mocks.openGatewaySocket,
    sendGatewaySocketJson: mocks.sendGatewaySocketJson,
  };
});
vi.mock("../app-core/gateway/desktopGatewayBridge", () => ({ installDesktopGatewayBridge: vi.fn() }));
vi.mock("../app-core/gateway/desktopGatewayStartup", () => ({ ensureGatewayReady: vi.fn() }));
vi.mock("../app-core/native/desktopNativeChannelLifecycle", () => ({ startDesktopNativeChannelRuntime: vi.fn() }));

describe("default desktop app services", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.gatewayApi.sessions.list.mockResolvedValue({
      items: [{ key: "websocket:chat-1", chat_id: "chat-1", title: "Live chat" }],
    });
    mocks.gatewayApi.sessions.messages.mockResolvedValue({ messages: [] });
  });

  test("does not reload persisted messages over an active live stream", async () => {
    const services = createDesktopAppServices();
    await services.sessionStore.list();
    expect(mocks.gatewayApi.sessions.messages).toHaveBeenCalledTimes(1);

    const socket = mocks.openGatewaySocket.mock.results[0]?.value;
    socket.handlers.onEvent({
      kind: "message.delta",
      chatId: "chat-1",
      messageId: "assistant-live",
      text: "live",
      reasoning: false,
      raw: {},
    });
    await Promise.resolve();
    await Promise.resolve();

    await expect(services.chatStore.load("websocket:chat-1")).resolves.toMatchObject([
      {
        id: "assistant-live",
        role: "assistant",
        status: "streaming",
        text: "live",
      },
    ]);
    expect(mocks.gatewayApi.sessions.messages).toHaveBeenCalledTimes(1);
  });

  test("maps live reasoning deltas to current chat thinking text", async () => {
    const services = createDesktopAppServices();
    await services.sessionStore.list();

    const socket = mocks.openGatewaySocket.mock.results[0]?.value;
    socket.handlers.onEvent({
      kind: "message.delta",
      chatId: "chat-1",
      messageId: "assistant-live",
      text: "I am checking context.",
      reasoning: true,
      raw: {},
    });
    await Promise.resolve();
    await Promise.resolve();

    await expect(services.chatStore.load("websocket:chat-1")).resolves.toMatchObject([
      {
        id: "assistant-live",
        reasoningText: "I am checking context.",
        role: "assistant",
        status: "streaming",
      },
    ]);
  });

  test("emits the user message immediately after send", async () => {
    const services = createDesktopAppServices();
    await services.sessionStore.list();
    const events: unknown[] = [];
    services.chatStore.subscribe("websocket:chat-1", (event) => events.push(event));

    await services.chatStore.send("websocket:chat-1", { text: "你好", usePersistentRag: true });

    expect(events).toContainEqual(expect.objectContaining({
      message: expect.objectContaining({
        role: "user",
        text: "你好",
      }),
      type: "message-sent",
    }));
  });

  test("persists the first user message as the title for default sessions", async () => {
    mocks.gatewayApi.sessions.list.mockResolvedValue({
      items: [{ key: "websocket:chat-1", chat_id: "chat-1", title: "Desktop Session websocket:chat-1" }],
    });
    const services = createDesktopAppServices();
    await services.sessionStore.list();

    await services.chatStore.send("websocket:chat-1", { text: "你好\n第二行", usePersistentRag: true });

    expect(mocks.gatewayApi.sessions.patch).toHaveBeenCalledWith("websocket:chat-1", {
      title: "你好",
    });
  });

  test("persists the first user message title after a pending session is created", async () => {
    const services = createDesktopAppServices();
    const pending = await services.sessionStore.create();

    await services.chatStore.send(pending.id, { text: "帮我总结一份文档", usePersistentRag: true });
    const socket = mocks.openGatewaySocket.mock.results[0]?.value;
    socket.handlers.onEvent({
      kind: "chat.created",
      chatId: "chat-new",
      raw: {},
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mocks.gatewayApi.sessions.patch).toHaveBeenCalledWith("websocket:chat-new", {
      title: "帮我总结一份文档",
    });
  });

  test("does not overwrite existing custom session titles", async () => {
    const services = createDesktopAppServices();
    await services.sessionStore.list();

    await services.chatStore.send("websocket:chat-1", { text: "new title candidate", usePersistentRag: true });

    expect(mocks.gatewayApi.sessions.patch).not.toHaveBeenCalled();
  });
});
