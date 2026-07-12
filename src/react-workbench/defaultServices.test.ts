// @vitest-environment happy-dom

import { beforeEach, describe, expect, test, vi } from "vitest";
import { createDesktopAppServices } from "./defaultServices";

const mocks = vi.hoisted(() => {
  const gatewayApi = {
    config: {
      get: vi.fn(async () => ({})),
      providers: vi.fn(async (): Promise<unknown> => []),
    },
    knowledge: {
      documents: vi.fn(async () => []),
      stats: vi.fn(async () => []),
    },
    sessions: {
      list: vi.fn(),
      messages: vi.fn(),
      agentRuns: vi.fn(),
      agentRunRuntimeState: vi.fn(),
      delete: vi.fn(async () => ({ deleted: true })),
      patch: vi.fn(async () => ({})),
    },
    skills: {
      list: vi.fn(async () => []),
    },
    tools: {
      approveApproval: vi.fn(async () => undefined),
      denyApproval: vi.fn(async () => undefined),
    },
    agentUi: {
      submitForm: vi.fn(async () => undefined),
      cancelForm: vi.fn(async () => undefined),
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

function agentEvent({
  eventId,
  eventType,
  payload,
  sequence,
}: {
  eventId: string;
  eventType: string;
  payload: Record<string, unknown>;
  sequence: number;
}): Record<string, unknown> {
  return {
    event: "agent_event",
    schema_version: "tinybot.agent_event.v1",
    event_id: eventId,
    event_type: eventType,
    chat_id: "chat-1",
    session_key: "websocket:chat-1",
    turn_id: "turn-live",
    sequence,
    created_at: "2026-07-04T12:00:00.000Z",
    payload,
  };
}

function canonicalRuntimeState(
  runId: string,
  items: Array<Record<string, unknown>>,
  sessionId = "websocket:chat-1",
): unknown {
  return {
    runtimeEvents: [],
    timeline: {
      schemaVersion: "tinybot.timeline.v2",
      sessionId,
      runId,
      snapshotRevision: items.length,
      items: items.map((item, index) => ({
        schemaVersion: "tinybot.turn_item.v2",
        itemId: `${runId}:item:${index + 1}`,
        sessionId,
        runId,
        turnId: runId,
        sequence: index + 1,
        revision: 1,
        status: "completed",
        createdAt: `2026-07-04T12:00:0${index}.000Z`,
        ...item,
      })),
    },
  };
}

describe("default desktop app services", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.gatewayApi.sessions.list.mockResolvedValue({
      items: [{ key: "websocket:chat-1", chat_id: "chat-1", title: "Live chat" }],
    });
    mocks.gatewayApi.sessions.messages.mockResolvedValue({ messages: [] });
    mocks.gatewayApi.sessions.agentRuns.mockResolvedValue({ runs: [] });
    mocks.gatewayApi.sessions.agentRunRuntimeState.mockResolvedValue(null);
  });

  test("does not infer canonical timeline rows from raw structured events", async () => {
    const services = createDesktopAppServices();
    await services.sessionStore.list();

    const socket = mocks.openGatewaySocket.mock.results[0]?.value;
    socket.handlers.onEvent({
      kind: "agent.event",
      chatId: "chat-1",
      raw: agentEvent({
        eventId: "event-message-delta",
        eventType: "message.delta",
        payload: {
          message_id: "assistant-live",
          text: "live",
        },
        sequence: 1,
      }),
    });
    await Promise.resolve();
    await Promise.resolve();

    await expect(services.chatStore.load("websocket:chat-1")).resolves.toMatchObject({
      source: "canonical",
      turns: [],
    });
    expect(mocks.gatewayApi.sessions.messages).not.toHaveBeenCalled();
  });

  test("keeps standalone usage frames out of canonical timeline state", async () => {
    const services = createDesktopAppServices();
    await services.sessionStore.list();
    const events: Array<{ type: string; message?: unknown }> = [];
    const otherSessionEvents: Array<{ type: string; message?: unknown }> = [];
    services.chatStore.subscribe("websocket:chat-1", (event) => events.push(event));
    services.chatStore.subscribe("websocket:chat-2", (event) => otherSessionEvents.push(event));

    const socket = mocks.openGatewaySocket.mock.results[0]?.value;
    socket.handlers.onEvent({
      kind: "agent.event",
      chatId: "chat-1",
      raw: agentEvent({
        eventId: "event-message-delta",
        eventType: "message.delta",
        payload: {
          message_id: "assistant-live",
          text: "live",
        },
        sequence: 1,
      }),
    });
    await Promise.resolve();
    await Promise.resolve();

    socket.handlers.onEvent({
      kind: "usage",
      chatId: "chat-1",
      tokenUsage: "107 / 128000 tokens",
      raw: {
        event: "usage",
        chat_id: "chat-1",
        usage: {
          prompt_tokens: 10,
          completion_tokens: 97,
          total_tokens: 172,
          context_window: 128000,
          context_window_used_tokens: 5,
          context_window_remaining_tokens: 127995,
          estimated_context_tokens: 5,
          percent: 0.08359375,
        },
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(events).toContainEqual(expect.objectContaining({
      type: "usage",
    }));
    expect(events.find((event) => event.type === "usage")?.message).toBeUndefined();
    expect(otherSessionEvents).not.toContainEqual(expect.objectContaining({ type: "usage" }));
    expect(mocks.gatewayApi.sessions.messages).not.toHaveBeenCalled();
  });

  test("loads reasoning from the canonical runtime snapshot", async () => {
    mocks.gatewayApi.sessions.agentRuns.mockResolvedValue({ runs: [{ runId: "run-live" }] });
    mocks.gatewayApi.sessions.agentRunRuntimeState.mockResolvedValue(canonicalRuntimeState("run-live", [
      {
        itemId: "user-live",
        kind: "user_message",
        data: { type: "user_message", messageId: "user-live", content: "Inspect context" },
      },
      {
        itemId: "reasoning-live",
        kind: "reasoning",
        status: "running",
        summary: "I am checking context.",
        data: { type: "reasoning", modelCallId: "call-live", summary: "I am checking context." },
      },
    ]));
    const services = createDesktopAppServices();
    await services.sessionStore.list();

    await expect(services.chatStore.load("websocket:chat-1")).resolves.toMatchObject({
      turns: [expect.objectContaining({
        id: "run-live",
        steps: [expect.objectContaining({
          id: "reasoning-live",
          kind: "reasoning",
          summary: "I am checking context.",
          status: "running",
        })],
      })],
    });
  });

  test("preserves canonical tool activity detail", async () => {
    mocks.gatewayApi.sessions.agentRuns.mockResolvedValue({ runs: [{ runId: "run-tool" }] });
    mocks.gatewayApi.sessions.agentRunRuntimeState.mockResolvedValue(canonicalRuntimeState("run-tool", [
      {
        itemId: "user-tool",
        kind: "user_message",
        data: { type: "user_message", messageId: "user-tool", content: "Read a file" },
      },
      {
        itemId: "tool-1",
        kind: "tool_call",
        title: "workspace.read_file",
        summary: "file contents",
        data: {
          type: "tool_call",
          toolCallId: "tool-1",
          name: "workspace.read_file",
          status: "completed",
          args: { path: "src/main.ts" },
          result: { summary: "file contents" },
          detailId: "tool:tool-1",
          timing: {},
        },
      },
    ]));
    const services = createDesktopAppServices();

    await expect(services.chatStore.load("websocket:chat-1")).resolves.toMatchObject({
      turns: [expect.objectContaining({
        steps: [expect.objectContaining({
          id: "tool-1",
          kind: "tool_call",
          toolCall: expect.objectContaining({
            argsPreview: "{\"path\":\"src/main.ts\"}",
            id: "tool-1",
            name: "workspace.read_file",
            resultPreview: "file contents",
          }),
        })],
      })],
    });
  });

  test("resolves approval actions through the gateway approval routes", async () => {
    const services = createDesktopAppServices();

    await (services.chatStore as any).resolveApproval("WebSocket:chat-1", {
      action: "approveSession",
      approvalId: "approval-1",
    });
    await (services.chatStore as any).resolveApproval("WebSocket:chat-1", {
      action: "deny",
      approvalId: "approval-2",
      guidance: "Use a read-only command.",
    });

    expect(mocks.gatewayApi.tools.approveApproval).toHaveBeenCalledWith("approval-1", {
      auto_retry: true,
      scope: "session",
      session_key: "websocket:chat-1",
    });
    expect(mocks.gatewayApi.tools.denyApproval).toHaveBeenCalledWith("approval-2", {
      auto_retry: true,
      guidance: "Use a read-only command.",
      session_key: "websocket:chat-1",
    });
  });

  test("tracks agent-ui forms and submits or cancels them through the gateway", async () => {
    const services = createDesktopAppServices();
    await services.sessionStore.list();
    const socket = mocks.openGatewaySocket.mock.results[0]?.value;

    socket.handlers.onEvent({
      kind: "agent-ui.event",
      eventType: "ui.form.requested",
      raw: {
        event: "agent_ui_event",
        chat_id: "chat-1",
        agent_ui_event: {
          event_type: "ui.form.requested",
          chat_id: "chat-1",
          message_id: "msg-form-1",
          run_id: "run-1",
          payload: {
            form_id: "travel-preferences-1",
            title: "Travel preferences",
            submit_label: "Save preferences",
            cancel_label: "Skip",
            correlation: {
              chat_id: "chat-1",
              message_id: "msg-form-1",
              run_id: "run-1",
            },
            fields: [
              { name: "destination", type: "text", label: "Destination", required: true },
              { name: "nights", type: "number", label: "Nights", min: 1, max: 30 },
            ],
            initial_values: { destination: "Shanghai", nights: 3 },
          },
        },
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    await expect((services.chatStore as any).listAgentUiForms("websocket:chat-1")).resolves.toEqual([
      expect.objectContaining({
        form_id: "travel-preferences-1",
        title: "Travel preferences",
      }),
    ]);

    await (services.chatStore as any).cancelAgentUiForm("travel-preferences-1");
    socket.handlers.onEvent({
      kind: "agent-ui.event",
      eventType: "ui.form.requested",
      raw: {
        event: "agent_ui_event",
        chat_id: "chat-1",
        agent_ui_event: {
          event_type: "ui.form.requested",
          chat_id: "chat-1",
          message_id: "msg-form-1",
          run_id: "run-1",
          payload: {
            form_id: "travel-preferences-1",
            title: "Travel preferences",
            correlation: {
              chat_id: "chat-1",
              message_id: "msg-form-1",
              run_id: "run-1",
            },
            fields: [
              { name: "destination", type: "text", label: "Destination", required: true },
              { name: "nights", type: "number", label: "Nights", min: 1, max: 30 },
            ],
          },
        },
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    await (services.chatStore as any).submitAgentUiForm("travel-preferences-1", {
      destination: "Singapore",
      nights: 4,
    });

    expect(mocks.gatewayApi.agentUi.submitForm).toHaveBeenCalledWith("travel-preferences-1", {
      values: { destination: "Singapore", nights: 4 },
      correlation: {
        form_id: "travel-preferences-1",
        chat_id: "chat-1",
        message_id: "msg-form-1",
        run_id: "run-1",
      },
    });
    expect(mocks.gatewayApi.agentUi.cancelForm).toHaveBeenCalledWith("travel-preferences-1", {
      correlation: {
        form_id: "travel-preferences-1",
        chat_id: "chat-1",
        message_id: "msg-form-1",
        run_id: "run-1",
      },
    });
  });

  test("emits the user message immediately after send", async () => {
    const services = createDesktopAppServices();
    await services.sessionStore.list();
    const events: unknown[] = [];
    services.chatStore.subscribe("websocket:chat-1", (event) => events.push(event));

    await services.chatStore.send("websocket:chat-1", {
      references: [{
        detail: "TinyOS file selection",
        evidenceId: "item-1",
        kind: "reference",
        sourceLine: 3,
        sourcePath: "src/main.ts",
        title: "src/main.ts · L3",
        type: "tinyos.file",
      }],
      text: "你好",
      usePersistentRag: true,
    });

    expect(events).toContainEqual(expect.objectContaining({
      message: expect.objectContaining({
        role: "user",
        text: "你好",
        contextReferences: [expect.objectContaining({ id: "item-1", sourcePath: "src/main.ts" })],
      }),
      type: "message-sent",
    }));
  });

  test("creates one real session and sends the first message from an empty session list", async () => {
    mocks.gatewayApi.sessions.list.mockResolvedValue({ items: [] });
    const services = createDesktopAppServices();
    await expect(services.sessionStore.list()).resolves.toEqual([]);

    const pending = await services.sessionStore.create();
    await services.chatStore.send(pending.id, {
      text: "inspect remote pull requests",
      usePersistentRag: true,
    });

    expect(mocks.sendGatewaySocketJson.mock.calls.map((call) => (call as unknown[])[1])).toEqual([
      { type: "new_chat" },
    ]);

    const socket = mocks.openGatewaySocket.mock.results[0]?.value;
    socket.handlers.onEvent({
      kind: "chat.created",
      chatId: "chat-created-from-empty",
      raw: {},
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mocks.sendGatewaySocketJson.mock.calls.map((call) => (call as unknown[])[1])).toEqual([
      { type: "new_chat" },
      {
        type: "message",
        chat_id: "chat-created-from-empty",
        client_event_id: expect.any(String),
        content: "inspect remote pull requests",
        use_persistent_rag: true,
      },
    ]);
    await expect(services.sessionStore.list()).resolves.toEqual([
      expect.objectContaining({ id: "websocket:chat-created-from-empty" }),
    ]);
    await expect(services.chatStore.load("websocket:chat-created-from-empty")).resolves.toMatchObject({
      source: "canonical",
      turns: [],
    });
  });

  test("leaves automatic title persistence to the backend for existing sessions", async () => {
    mocks.gatewayApi.sessions.list.mockResolvedValue({
      items: [{ key: "websocket:chat-1", chat_id: "chat-1", title: "Desktop Session websocket:chat-1" }],
    });
    const services = createDesktopAppServices();
    await services.sessionStore.list();

    await services.chatStore.send("websocket:chat-1", { text: "你好\n第二行", usePersistentRag: true });

    expect(mocks.gatewayApi.sessions.patch).not.toHaveBeenCalled();
  });

  test("leaves automatic title persistence to the backend for pending sessions", async () => {
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

    expect(mocks.gatewayApi.sessions.patch).not.toHaveBeenCalled();
  });

  test("cleans up the pending session after the backend creates the chat", async () => {
    const services = createDesktopAppServices();
    const pending = await services.sessionStore.create();

    await expect(services.chatStore.send(pending.id, { text: "summarize docs", usePersistentRag: true })).resolves.toBeUndefined();
    const socket = mocks.openGatewaySocket.mock.results[0]?.value;
    socket.handlers.onEvent({
      kind: "chat.created",
      chatId: "chat-new",
      raw: {},
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    await expect(services.sessionStore.list()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "websocket:chat-new" }),
    ]));
    await expect(services.sessionStore.list()).resolves.not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: pending.id }),
    ]));
  });

  test("does not overwrite existing custom session titles", async () => {
    const services = createDesktopAppServices();
    await services.sessionStore.list();

    await services.chatStore.send("websocket:chat-1", { text: "new title candidate", usePersistentRag: true });

    expect(mocks.gatewayApi.sessions.patch).not.toHaveBeenCalled();
  });

  test("loads chat models only for the current default provider", async () => {
    mocks.gatewayApi.config.get.mockResolvedValueOnce({
      agents: {
        defaults: {
          provider: "deepseek",
          activeProfile: "deepseek-default",
          model: "deepseek-v4-pro",
        },
      },
      providers: {
        profiles: {
          "deepseek-default": {
            provider: "deepseek",
            api_key_configured: true,
            models: ["deepseek-v4-pro", "deepseek-v4-flash"],
          },
          "dashscope-default": {
            provider: "dashscope",
            api_key_configured: true,
            models: ["qwen3-plus"],
          },
        },
      },
    });
    mocks.gatewayApi.config.providers.mockResolvedValueOnce({
      providers: [
        { id: "deepseek", displayName: "DeepSeek", status: "ready" },
        { id: "dashscope", displayName: "DashScope", status: "ready" },
      ],
    });
    const services = createDesktopAppServices();
    const models = await services.settingsStore.loadChatModels?.();

    expect(models).toEqual([
      expect.objectContaining({
        id: "deepseek-v4-pro",
        providerId: "deepseek",
        default: true,
      }),
      expect.objectContaining({
        id: "deepseek-v4-flash",
        providerId: "deepseek",
      }),
    ]);
    expect(models).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "qwen3-plus" }),
    ]));
  });
});
