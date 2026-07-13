import { describe, expect, test, vi } from "vitest";
import { createDesktopNativeWebSocket } from "./desktopNativeWebSocketBridge";
import type { NativeTransportApi, NativeTransportWebSocketDispatchRequest } from "./desktopNativeTransport";
import { toDesktopNativeTauriEventName } from "./desktopNativeTauriEvents";

describe("desktop native WebSocket bridge", () => {
  test("publishes TinyOS command acceptance before native approval continuation completes", async () => {
    const handlers = new Map<string, (payload: unknown) => void>();
    const dispatch = deferred<unknown>();
    const nativeTransport: NativeTransportApi = {
      gatewayFrame: vi.fn(),
      websocketMessage: vi.fn(),
      dispatchWebsocketMessage: vi.fn(async () => dispatch.promise),
      dispatchChannelInbound: vi.fn(),
      startChannels: vi.fn(),
      channelStatus: vi.fn(),
      stopChannels: vi.fn(),
    };
    const socket = createDesktopNativeWebSocket({
      url: "/ws",
      nativeTransport,
      listenToAgentEvent: (eventName, handler) => {
        handlers.set(eventName, handler);
      },
    });
    const events: Array<Record<string, unknown>> = [];
    socket.addEventListener("message", (event) => {
      events.push(JSON.parse(String((event as MessageEvent).data)) as Record<string, unknown>);
    });

    await flushMicrotasks();
    socket.send(JSON.stringify({
      type: "command",
      chat_id: "chat-native",
      command_id: "command-approval-1",
      command_kind: "approval.resolve",
      run_id: "run-1",
      approval_id: "approval-1",
      approved: true,
      scope: "once",
    }));
    await flushMicrotasks();
    handlers.get(toDesktopNativeTauriEventName("agent.command.acknowledged"))?.({
      chatId: "chat-native",
      commandId: "command-approval-1",
      runId: "run-1",
    });

    expect(events).toContainEqual({
      event: "command_accepted",
      chat_id: "chat-native",
      command_id: "command-approval-1",
      run_id: "run-1",
    });
    expect(events).toContainEqual({
      event: "command_canonical_updated",
      chat_id: "chat-native",
      command_id: "command-approval-1",
      run_id: "run-1",
    });
    expect(nativeTransport.dispatchWebsocketMessage).toHaveBeenCalledTimes(1);
    socket.close();
  });

  test("projects TS worker stream events into structured agent WebSocket frames", async () => {
    const handlers = new Map<string, (payload: unknown) => void>();
    const unlisteners: Array<() => void> = [];
    const dispatch = deferred<unknown>();
    const nativeTransport: NativeTransportApi = {
      gatewayFrame: vi.fn(),
      websocketMessage: vi.fn(),
      dispatchWebsocketMessage: vi.fn(async () => dispatch.promise),
      dispatchChannelInbound: vi.fn(),
      startChannels: vi.fn(),
      channelStatus: vi.fn(),
      stopChannels: vi.fn(),
    };
    const socket = createDesktopNativeWebSocket({
      url: "/ws",
      nativeTransport,
      listenToAgentEvent: async (eventName, handler) => {
        handlers.set(eventName, handler);
        const unlisten = vi.fn(() => {
          handlers.delete(eventName);
        });
        unlisteners.push(unlisten);
        return unlisten;
      },
    });
    const events: Array<Record<string, unknown>> = [];
    socket.addEventListener("message", (event) => {
      events.push(JSON.parse(String((event as MessageEvent).data)) as Record<string, unknown>);
    });

    await flushMicrotasks();
    socket.send(JSON.stringify({ type: "message", chat_id: "chat-native", content: "hello" }));
    await flushMicrotasks();
    await flushMicrotasks();

    expect(handlers.get(toDesktopNativeTauriEventName("agent.delta"))).toBeDefined();
    expect(handlers.get(toDesktopNativeTauriEventName("agent.reasoning_delta"))).toBeDefined();
    expect(handlers.get(toDesktopNativeTauriEventName("agent.done"))).toBeDefined();

    handlers.get(toDesktopNativeTauriEventName("agent.delta"))?.({ runId: "run-1", delta: "hello", messageId: "message-1" });
    handlers.get(toDesktopNativeTauriEventName("agent.reasoning_delta"))?.({ run_id: "run-1", delta: "thinking", message_id: "message-1" });
    handlers.get(toDesktopNativeTauriEventName("agent.done"))?.({
      runId: "run-1",
      stopReason: "final_response",
      _memory_references: [{ note_id: "note-1" }],
      _recent_context_references: [{ evidence_id: "ev-1" }],
    });
    dispatch.resolve({
      transport: {
        kind: "message",
        chatId: "chat-native",
        sessionId: "websocket:chat-native",
        frames: [],
      },
      agent: {
        runId: "run-1",
        finalContent: "hello",
        stopReason: "final_response",
      },
    });
    await flushMicrotasks();

    expect(events).not.toContainEqual(expect.objectContaining({
      event: "delta",
    }));
    expect(events).not.toContainEqual(expect.objectContaining({
      event: "stream_end",
      chat_id: "chat-native",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      event: "agent_event",
      event_type: "message.delta",
      turn_id: "run-1",
      payload: expect.objectContaining({
        message_id: "message-1",
        text: "hello",
        visibility: "visible",
      }),
    }));
    expect(events).toContainEqual(expect.objectContaining({
      event: "agent_event",
      event_type: "reasoning.delta",
      turn_id: "run-1",
      payload: expect.objectContaining({
        message_id: "message-1",
        summary: "thinking",
        text: "thinking",
        visibility: "hidden",
      }),
    }));
    expect(events).not.toContainEqual(expect.objectContaining({
      event: "message",
      chat_id: "chat-native",
      text: "hello",
    }));

    socket.close();
    await flushMicrotasks();
    expect(unlisteners.every((unlisten) => vi.mocked(unlisten).mock.calls.length === 1)).toBe(true);
  });

  test("registers native message runs before dispatch completes so stream deltas render live", async () => {
    const handlers = new Map<string, (payload: unknown) => void>();
    const dispatched: unknown[] = [];
    const dispatch = deferred<unknown>();
    const nativeTransport: NativeTransportApi = {
      gatewayFrame: vi.fn(),
      websocketMessage: vi.fn(),
      dispatchWebsocketMessage: vi.fn(async (request) => {
        dispatched.push(request);
        return dispatch.promise;
      }),
      dispatchChannelInbound: vi.fn(),
      startChannels: vi.fn(),
      channelStatus: vi.fn(),
      stopChannels: vi.fn(),
    };
    const socket = createDesktopNativeWebSocket({
      url: "/ws",
      nativeTransport,
      listenToAgentEvent: (eventName, handler) => {
        handlers.set(eventName, handler);
      },
    });
    const events: Array<Record<string, unknown>> = [];
    socket.addEventListener("message", (event) => {
      events.push(JSON.parse(String((event as MessageEvent).data)) as Record<string, unknown>);
    });

    await flushMicrotasks();
    socket.send(JSON.stringify({ type: "message", chat_id: "chat-native", content: "hello" }));
    await flushMicrotasks();
    await flushMicrotasks();

    const runId = (dispatched[0] as { runId?: string } | undefined)?.runId;
    expect(runId).toMatch(/^websocket-chat-native-/);
    expect((dispatched[0] as { editablePaths?: string[] }).editablePaths).toContain("SYSTEM.md");

    handlers.get(toDesktopNativeTauriEventName("agent.delta"))?.({ runId, delta: "live", messageId: "message-live" });
    await flushMicrotasks();

    expect(events).toContainEqual(expect.objectContaining({
      event: "agent_event",
      event_type: "message.delta",
      payload: expect.objectContaining({
        message_id: "message-live",
        text: "live",
        visibility: "visible",
      }),
      turn_id: runId,
    }));

    dispatch.resolve({
      transport: {
        kind: "message",
        chatId: "chat-native",
        sessionId: "websocket:chat-native",
        frames: [],
      },
      agent: {
        runId,
        finalContent: "live final",
        stopReason: "final_response",
      },
    });
    await flushMicrotasks();
  });

  test("does not emit final fallback content after a streamed run when dispatch result omits run id", async () => {
    const handlers = new Map<string, (payload: unknown) => void>();
    const dispatched: unknown[] = [];
    const dispatch = deferred<unknown>();
    const nativeTransport: NativeTransportApi = {
      gatewayFrame: vi.fn(),
      websocketMessage: vi.fn(),
      dispatchWebsocketMessage: vi.fn(async (request) => {
        dispatched.push(request);
        return dispatch.promise;
      }),
      dispatchChannelInbound: vi.fn(),
      startChannels: vi.fn(),
      channelStatus: vi.fn(),
      stopChannels: vi.fn(),
    };
    const socket = createDesktopNativeWebSocket({
      url: "/ws",
      nativeTransport,
      listenToAgentEvent: (eventName, handler) => {
        handlers.set(eventName, handler);
      },
    });
    const events: Array<Record<string, unknown>> = [];
    socket.addEventListener("message", (event) => {
      events.push(JSON.parse(String((event as MessageEvent).data)) as Record<string, unknown>);
    });

    await flushMicrotasks();
    socket.send(JSON.stringify({ type: "message", chat_id: "chat-native", content: "hello" }));
    await flushMicrotasks();

    const runId = (dispatched[0] as { runId?: string } | undefined)?.runId;
    handlers.get(toDesktopNativeTauriEventName("agent.delta"))?.({ runId, delta: "live" });
    dispatch.resolve({
      transport: {
        kind: "message",
        chatId: "chat-native",
        sessionId: "websocket:chat-native",
        frames: [],
      },
      agent: {
        finalContent: "live final",
        stopReason: "final_response",
      },
    });
    await flushMicrotasks();

    expect(events).toContainEqual(expect.objectContaining({
      event: "agent_event",
      event_type: "message.delta",
      payload: expect.objectContaining({
        text: "live",
        visibility: "visible",
      }),
      turn_id: runId,
    }));
    expect(events).not.toContainEqual(expect.objectContaining({
      event: "message",
      chat_id: "chat-native",
      text: "live final",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      event: "agent_event",
      event_type: "message.completed",
      payload: expect.objectContaining({
        text: "live final",
      }),
      turn_id: runId,
    }));
  });

  test("does not emit final fallback content after done completes a streamed run first", async () => {
    const handlers = new Map<string, (payload: unknown) => void>();
    const dispatched: unknown[] = [];
    const dispatch = deferred<unknown>();
    const nativeTransport: NativeTransportApi = {
      gatewayFrame: vi.fn(),
      websocketMessage: vi.fn(),
      dispatchWebsocketMessage: vi.fn(async (request) => {
        dispatched.push(request);
        return dispatch.promise;
      }),
      dispatchChannelInbound: vi.fn(),
      startChannels: vi.fn(),
      channelStatus: vi.fn(),
      stopChannels: vi.fn(),
    };
    const socket = createDesktopNativeWebSocket({
      url: "/ws",
      nativeTransport,
      listenToAgentEvent: (eventName, handler) => {
        handlers.set(eventName, handler);
      },
    });
    const events: Array<Record<string, unknown>> = [];
    socket.addEventListener("message", (event) => {
      events.push(JSON.parse(String((event as MessageEvent).data)) as Record<string, unknown>);
    });

    await flushMicrotasks();
    socket.send(JSON.stringify({ type: "message", chat_id: "chat-native", content: "hello" }));
    await flushMicrotasks();

    const runId = (dispatched[0] as { runId?: string } | undefined)?.runId;
    handlers.get(toDesktopNativeTauriEventName("agent.delta"))?.({ runId, delta: "live" });
    handlers.get(toDesktopNativeTauriEventName("agent.done"))?.({ runId, stopReason: "final_response" });
    handlers.get(toDesktopNativeTauriEventName("agent.usage"))?.({
      runId,
      usage: {
        context_window_tokens: 128000,
        context_window_used_tokens: 107,
        total_tokens: 107,
      },
    });
    dispatch.resolve({
      transport: {
        kind: "message",
        chatId: "chat-native",
        sessionId: "websocket:chat-native",
        frames: [],
      },
      agent: {
        finalContent: "live final",
        stopReason: "final_response",
      },
    });
    await flushMicrotasks();

    expect(events).toContainEqual(expect.objectContaining({
      event: "agent_event",
      event_type: "message.delta",
      payload: expect.objectContaining({
        text: "live",
        visibility: "visible",
      }),
      turn_id: runId,
    }));
    expect(events).not.toContainEqual(expect.objectContaining({
      event: "stream_end",
      chat_id: "chat-native",
    }));
    expect(events).not.toContainEqual(expect.objectContaining({
      event: "message",
      chat_id: "chat-native",
      text: "live final",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      event: "agent_event",
      event_type: "message.completed",
      payload: expect.objectContaining({
        text: "live final",
      }),
      turn_id: runId,
    }));
    expect(events).not.toContainEqual(expect.objectContaining({
      event: "usage",
      chat_id: "chat-native",
    }));
  });

  test("drops late usage events for unknown runs instead of accumulating pending events", async () => {
    const handlers = new Map<string, (payload: unknown) => void>();
    const nativeTransport: NativeTransportApi = {
      gatewayFrame: vi.fn(),
      websocketMessage: vi.fn(),
      dispatchWebsocketMessage: vi.fn(async () => ({
        transport: {
          kind: "message",
          chatId: "chat-native",
          sessionId: "websocket:chat-native",
          frames: [],
        },
        agent: {
          runId: "stale-run",
          stopReason: "final_response",
        },
      })),
      dispatchChannelInbound: vi.fn(),
      startChannels: vi.fn(),
      channelStatus: vi.fn(),
      stopChannels: vi.fn(),
    };
    const socket = createDesktopNativeWebSocket({
      url: "/ws",
      nativeTransport,
      listenToAgentEvent: (eventName, handler) => {
        handlers.set(eventName, handler);
      },
    });
    const events: Array<Record<string, unknown>> = [];
    socket.addEventListener("message", (event) => {
      events.push(JSON.parse(String((event as MessageEvent).data)) as Record<string, unknown>);
    });

    await flushMicrotasks();

    for (let index = 0; index < 5; index += 1) {
      handlers.get(toDesktopNativeTauriEventName("agent.usage"))?.({
        runId: "stale-run",
        usage: { total_tokens: index + 1 },
      });
    }
    handlers.get(toDesktopNativeTauriEventName("agent.done"))?.({
      runId: "stale-run",
      stopReason: "final_response",
    });
    socket.send(JSON.stringify({ type: "attach", chat_id: "chat-native" }));
    await flushMicrotasks();
    await flushMicrotasks();

    expect(events).not.toContainEqual(expect.objectContaining({
      event: "usage",
      chat_id: "chat-native",
    }));
  });

  test("waits for async native agent event listeners before opening the socket", async () => {
    const listenerReady = deferred<() => void>();
    const nativeTransport: NativeTransportApi = {
      gatewayFrame: vi.fn(),
      websocketMessage: vi.fn(),
      dispatchWebsocketMessage: vi.fn(),
      dispatchChannelInbound: vi.fn(),
      startChannels: vi.fn(),
      channelStatus: vi.fn(),
      stopChannels: vi.fn(),
    };
    const socket = createDesktopNativeWebSocket({
      url: "/ws",
      nativeTransport,
      listenToAgentEvent: () => listenerReady.promise,
    });

    await flushMicrotasks();

    expect(socket.readyState).toBe(WebSocket.CONNECTING);
    expect(() => socket.send(JSON.stringify({ type: "message", chat_id: "chat-native", content: "hello" }))).toThrow("WebSocket is not open");
    expect(nativeTransport.dispatchWebsocketMessage).not.toHaveBeenCalled();

    listenerReady.resolve(vi.fn());
    await flushMicrotasks();

    expect(socket.readyState).toBe(WebSocket.OPEN);
  });

  test("projects TS worker cowork events into legacy WebUI WebSocket frames", async () => {
    const handlers = new Map<string, (payload: unknown) => void>();
    const nativeTransport: NativeTransportApi = {
      gatewayFrame: vi.fn(),
      websocketMessage: vi.fn(),
      dispatchWebsocketMessage: vi.fn(),
      dispatchChannelInbound: vi.fn(),
      startChannels: vi.fn(),
      channelStatus: vi.fn(),
      stopChannels: vi.fn(),
    };
    const socket = createDesktopNativeWebSocket({
      url: "/ws",
      nativeTransport,
      listenToAgentEvent: async (eventName, handler) => {
        handlers.set(eventName, handler);
        return () => handlers.delete(eventName);
      },
    });
    const events: Array<Record<string, unknown>> = [];
    socket.addEventListener("message", (event) => {
      events.push(JSON.parse(String((event as MessageEvent).data)) as Record<string, unknown>);
    });

    await flushMicrotasks();

    expect(handlers.get("cowork_stream")).toBeDefined();
    expect(handlers.get("cowork_mailbox_stream")).toBeDefined();
    expect(handlers.get("cowork_state")).toBeDefined();
    expect(handlers.get("cowork_updated")).toBeDefined();

    handlers.get("cowork_stream")?.({
      event: "cowork_stream",
      chat_id: "chat-native",
      session_id: "cw_1",
      agent_id: "lead",
      step_id: "step_1",
      phase: "delta",
      status: "running",
      sequence: 1,
      text: "draft",
      completed: false,
    });
    handlers.get("cowork_mailbox_stream")?.({
      event: "cowork_mailbox_stream",
      chat_id: "chat-native",
      session_id: "cw_1",
      sender_agent_id: "lead",
      draft_id: "draft_1",
      tool_call_id: "call_1",
      phase: "terminal",
      status: "completed",
      sequence: 2,
      text: "",
      completed: true,
    });
    handlers.get("cowork_state")?.({
      event: "cowork_state",
      chat_id: "chat-native",
      session_id: "cw_1",
      change_type: "message.sent",
      status: "active",
    });
    handlers.get("cowork_updated")?.({
      event: "cowork_updated",
      session_id: "cw_1",
      event_id: "evt_1",
      event_type: "message.sent",
    });

    expect(events).toContainEqual(expect.objectContaining({
      event: "cowork_stream",
      chat_id: "chat-native",
      session_id: "cw_1",
      text: "draft",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      event: "cowork_mailbox_stream",
      chat_id: "chat-native",
      session_id: "cw_1",
      draft_id: "draft_1",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      event: "cowork_state",
      chat_id: "chat-native",
      session_id: "cw_1",
      change_type: "message.sent",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      event: "cowork_updated",
      session_id: "cw_1",
      event_id: "evt_1",
    }));

    socket.close();
  });

  test("passes attach session existence into the native transport mapper", async () => {
    const dispatched: unknown[] = [];
    const nativeTransport: NativeTransportApi = {
      gatewayFrame: vi.fn(),
      websocketMessage: vi.fn(),
      dispatchWebsocketMessage: vi.fn(async (request) => {
        dispatched.push(request);
        return {
          transport: {
            kind: "error",
            frames: [{ event: "error", message: "session not found", chat_id: "missing" }],
          },
        };
      }),
      dispatchChannelInbound: vi.fn(),
      startChannels: vi.fn(),
      channelStatus: vi.fn(),
      stopChannels: vi.fn(),
    };
    const socket = createDesktopNativeWebSocket({
      url: "/ws",
      nativeTransport,
      resolveSessionExists: async (sessionId) => sessionId !== "websocket:missing",
    });
    const events: Array<Record<string, unknown>> = [];
    socket.addEventListener("message", (event) => {
      events.push(JSON.parse(String((event as MessageEvent).data)) as Record<string, unknown>);
    });

    await flushMicrotasks();
    socket.send(JSON.stringify({ type: "attach", chat_id: "missing" }));
    await flushMicrotasks();
    await flushMicrotasks();

    expect(dispatched).toContainEqual(expect.objectContaining({
      frame: { type: "attach", chat_id: "missing" },
      sessionExists: false,
    }));
    expect(events).toContainEqual({ event: "error", message: "session not found", chat_id: "missing" });
  });

  test("passes message frame model overrides into native transport dispatch options", async () => {
    const dispatched: unknown[] = [];
    const nativeTransport: NativeTransportApi = {
      gatewayFrame: vi.fn(),
      websocketMessage: vi.fn(),
      dispatchWebsocketMessage: vi.fn(async (request) => {
        dispatched.push(request);
        return { transport: { kind: "error", frames: [] } };
      }),
      dispatchChannelInbound: vi.fn(),
      startChannels: vi.fn(),
      channelStatus: vi.fn(),
      stopChannels: vi.fn(),
    };
    const socket = createDesktopNativeWebSocket({
      url: "/ws",
      nativeTransport,
    });

    await flushMicrotasks();
    socket.send(JSON.stringify({
      type: "message",
      chat_id: "chat-native",
      content: "hello",
      model: "deepseek-v4-flash",
    }));
    await flushMicrotasks();
    await flushMicrotasks();

    expect(dispatched).toContainEqual(expect.objectContaining({
      frame: expect.objectContaining({ model: "deepseek-v4-flash" }),
      model: "deepseek-v4-flash",
    }));
  });

  test("projects TS worker tool progress into structured agent event frames", async () => {
    const handlers = new Map<string, (payload: unknown) => void>();
    const nativeTransport: NativeTransportApi = {
      gatewayFrame: vi.fn(),
      websocketMessage: vi.fn(),
      dispatchWebsocketMessage: vi.fn(async () => ({
        transport: {
          kind: "message",
          chatId: "chat-native",
          sessionId: "websocket:chat-native",
          frames: [],
        },
        agent: {
          runId: "run-2",
          stopReason: "final_response",
        },
      })),
      dispatchChannelInbound: vi.fn(),
      startChannels: vi.fn(),
      channelStatus: vi.fn(),
      stopChannels: vi.fn(),
    };
    const socket = createDesktopNativeWebSocket({
      url: "/ws",
      nativeTransport,
      listenToAgentEvent: (eventName, handler) => {
        handlers.set(eventName, handler);
      },
    });
    const events: Array<Record<string, unknown>> = [];
    socket.addEventListener("message", (event) => {
      events.push(JSON.parse(String((event as MessageEvent).data)) as Record<string, unknown>);
    });

    await flushMicrotasks();
    socket.send(JSON.stringify({ type: "message", chat_id: "chat-native", content: "hello" }));
    await flushMicrotasks();
    await flushMicrotasks();

    handlers.get(toDesktopNativeTauriEventName("agent.tool_call.delta"))?.({
      runId: "run-2",
      index: 0,
      deltaText: "{\"path\":\"AGENTS.md\"}",
      toolCallId: "call-read",
      toolName: "read_file",
    });
    handlers.get(toDesktopNativeTauriEventName("agent.tool.start"))?.({
      runId: "run-2",
      toolCallId: "call-read",
      toolName: "read_file",
    });
    handlers.get(toDesktopNativeTauriEventName("agent.tool.result"))?.({
      runId: "run-2",
      toolCallId: "call-read",
      toolName: "read_file",
      content: "file contents",
    });

    expect(events).not.toContainEqual(expect.objectContaining({ event: "message" }));
    expect(events).toContainEqual(expect.objectContaining({
      event: "agent_event",
      event_type: "tool.call.arguments.delta",
      step_id: "run-2:call-read",
      payload: expect.objectContaining({
        args_preview: "{\"path\":\"AGENTS.md\"}",
        name: "read_file",
        status: "running",
        tool_call_id: "call-read",
      }),
    }));
    expect(events).toContainEqual(expect.objectContaining({
      event: "agent_event",
      schema_version: "tinybot.agent_event.v1",
      event_type: "tool.call.started",
      chat_id: "chat-native",
      session_key: "websocket:chat-native",
      turn_id: "run-2",
      step_id: "run-2:call-read",
      payload: expect.objectContaining({
        name: "read_file",
        status: "running",
        tool_call_id: "call-read",
      }),
    }));
    expect(events).toContainEqual(expect.objectContaining({
      event: "agent_event",
      schema_version: "tinybot.agent_event.v1",
      event_type: "tool.call.completed",
      chat_id: "chat-native",
      session_key: "websocket:chat-native",
      turn_id: "run-2",
      step_id: "run-2:call-read",
      payload: expect.objectContaining({
        name: "read_file",
        result_preview: "file contents",
        status: "completed",
        tool_call_id: "call-read",
      }),
    }));
  });

  test("projects tool results awaiting approval as pending approval tool frames", async () => {
    const handlers = new Map<string, (payload: unknown) => void>();
    const nativeTransport: NativeTransportApi = {
      gatewayFrame: vi.fn(),
      websocketMessage: vi.fn(),
      dispatchWebsocketMessage: vi.fn(async () => ({
        transport: {
          kind: "message",
          chatId: "chat-native",
          sessionId: "websocket:chat-native",
          frames: [],
        },
        agent: {
          runId: "run-approval",
          stopReason: "awaiting_approval",
        },
      })),
      dispatchChannelInbound: vi.fn(),
      startChannels: vi.fn(),
      channelStatus: vi.fn(),
      stopChannels: vi.fn(),
    };
    const socket = createDesktopNativeWebSocket({
      url: "/ws",
      nativeTransport,
      listenToAgentEvent: (eventName, handler) => {
        handlers.set(eventName, handler);
      },
    });
    const events: Array<Record<string, unknown>> = [];
    socket.addEventListener("message", (event) => {
      events.push(JSON.parse(String((event as MessageEvent).data)) as Record<string, unknown>);
    });

    await flushMicrotasks();
    socket.send(JSON.stringify({ type: "message", chat_id: "chat-native", content: "hello" }));
    await flushMicrotasks();
    await flushMicrotasks();

    handlers.get(toDesktopNativeTauriEventName("agent.tool.result"))?.({
      runId: "run-approval",
      toolCallId: "call-spawn",
      toolName: "spawn",
      content: "Waiting for approval.",
      metadata: {
        awaitingUserInput: true,
        stopReason: "awaiting_approval",
        approvalId: "approval-1",
        operation: {
          toolName: "spawn",
          arguments: { task: "说一句你好" },
        },
      },
    });

    expect(events).not.toContainEqual(expect.objectContaining({ event: "message" }));
    expect(events).toContainEqual({
      event: "approval_pending",
      chat_id: "chat-native",
      approval_id: "approval-1",
    });
    expect(events).toContainEqual(expect.objectContaining({
      event: "agent_event",
      event_type: "approval.requested",
      chat_id: "chat-native",
      turn_id: "run-approval",
      step_id: "run-approval:approval:approval-1",
      payload: expect.objectContaining({
        approval_id: "approval-1",
        status: "approval_required",
        tool_call_id: "call-spawn",
      }),
    }));
    expect(events).not.toContainEqual(expect.objectContaining({
      event: "agent_event",
      event_type: "tool.call.completed",
      payload: expect.objectContaining({
        tool_call_id: "call-spawn",
      }),
    }));
  });

  test("projects delegated tool results as delegated events without legacy result frames", async () => {
    const handlers = new Map<string, (payload: unknown) => void>();
    const nativeTransport: NativeTransportApi = {
      gatewayFrame: vi.fn(),
      websocketMessage: vi.fn(),
      dispatchWebsocketMessage: vi.fn(async () => ({
        transport: {
          kind: "message",
          chatId: "chat-native",
          sessionId: "websocket:chat-native",
          frames: [],
        },
        agent: {
          runId: "run-delegate",
          stopReason: "completed",
        },
      })),
      dispatchChannelInbound: vi.fn(),
      startChannels: vi.fn(),
      channelStatus: vi.fn(),
      stopChannels: vi.fn(),
    };
    const socket = createDesktopNativeWebSocket({
      url: "/ws",
      nativeTransport,
      listenToAgentEvent: (eventName, handler) => {
        handlers.set(eventName, handler);
      },
    });
    const events: Array<Record<string, unknown>> = [];
    socket.addEventListener("message", (event) => {
      events.push(JSON.parse(String((event as MessageEvent).data)) as Record<string, unknown>);
    });

    await flushMicrotasks();
    socket.send(JSON.stringify({ type: "message", chat_id: "chat-native", content: "hello" }));
    await flushMicrotasks();
    await flushMicrotasks();

    handlers.get(toDesktopNativeTauriEventName("agent.tool.start"))?.({
      runId: "run-delegate",
      toolCallId: "call-spawn",
      toolName: "spawn",
    });
    handlers.get(toDesktopNativeTauriEventName("agent.tool.result"))?.({
      runId: "run-delegate",
      toolCallId: "call-spawn",
      toolName: "spawn",
      content: "child final result",
      metadata: {
        _delegate_event: true,
        _delegate_id: "delegate-1",
        _delegate_label: "打招呼",
        _delegate_result: { summary: "你好", status: "completed" },
        _delegate_status: "completed",
        _delegate_task: "请用中文说一句\"你好\"",
      },
    });

    expect(events).toContainEqual(expect.objectContaining({
      event: "agent_event",
      event_type: "agent.delegate.completed",
      turn_id: "run-delegate",
      payload: expect.objectContaining({
        delegate_id: "delegate-1",
        final_output: "你好",
        task: "请用中文说一句\"你好\"",
        tool_call_id: "call-spawn",
        tool_name: "spawn",
      }),
    }));
    expect(events).not.toContainEqual(expect.objectContaining({
      event: "message",
      message_id: "run-delegate:call-spawn:result",
    }));
  });

  test("projects later awaiting approval events back onto pending tool result frames", async () => {
    const handlers = new Map<string, (payload: unknown) => void>();
    const nativeTransport: NativeTransportApi = {
      gatewayFrame: vi.fn(),
      websocketMessage: vi.fn(),
      dispatchWebsocketMessage: vi.fn(async () => ({
        transport: {
          kind: "message",
          chatId: "chat-native",
          sessionId: "websocket:chat-native",
          frames: [],
        },
        agent: {
          runId: "run-approval",
          stopReason: "awaiting_approval",
        },
      })),
      dispatchChannelInbound: vi.fn(),
      startChannels: vi.fn(),
      channelStatus: vi.fn(),
      stopChannels: vi.fn(),
    };
    const socket = createDesktopNativeWebSocket({
      url: "/ws",
      nativeTransport,
      listenToAgentEvent: (eventName, handler) => {
        handlers.set(eventName, handler);
      },
    });
    const events: Array<Record<string, unknown>> = [];
    socket.addEventListener("message", (event) => {
      events.push(JSON.parse(String((event as MessageEvent).data)) as Record<string, unknown>);
    });

    await flushMicrotasks();
    socket.send(JSON.stringify({ type: "message", chat_id: "chat-native", content: "hello" }));
    await flushMicrotasks();
    await flushMicrotasks();

    handlers.get(toDesktopNativeTauriEventName("agent.tool.result"))?.({
      runId: "run-approval",
      toolCallId: "call-spawn",
      toolName: "spawn",
      content: "Waiting for approval.",
    });
    handlers.get(toDesktopNativeTauriEventName("agent.awaiting_approval"))?.({
      runId: "run-approval",
      approvalId: "approval-1",
      argsPreview: "spawn({\"task\":\"说一句你好\"})",
      toolCallId: "call-spawn",
      toolName: "spawn",
    });

    expect(events).not.toContainEqual(expect.objectContaining({ event: "message" }));
    expect(events).toContainEqual(expect.objectContaining({
      event: "agent_event",
      event_type: "approval.requested",
      step_id: "run-approval:approval:approval-1",
      payload: expect.objectContaining({
        approval_id: "approval-1",
        tool_call_id: "call-spawn",
      }),
      turn_id: "run-approval",
    }));
  });

  test("projects TS worker awaiting interaction events into legacy WebUI frames", async () => {
    const handlers = new Map<string, (payload: unknown) => void>();
    const nativeTransport: NativeTransportApi = {
      gatewayFrame: vi.fn(),
      websocketMessage: vi.fn(),
      dispatchWebsocketMessage: vi.fn(async () => ({
        transport: {
          kind: "message",
          chatId: "chat-native",
          sessionId: "websocket:chat-native",
          frames: [],
        },
        agent: {
          runId: "run-3",
          stopReason: "awaiting_form",
        },
      })),
      dispatchChannelInbound: vi.fn(),
      startChannels: vi.fn(),
      channelStatus: vi.fn(),
      stopChannels: vi.fn(),
    };
    const socket = createDesktopNativeWebSocket({
      url: "/ws",
      nativeTransport,
      listenToAgentEvent: (eventName, handler) => {
        handlers.set(eventName, handler);
      },
    });
    const events: Array<Record<string, unknown>> = [];
    socket.addEventListener("message", (event) => {
      events.push(JSON.parse(String((event as MessageEvent).data)) as Record<string, unknown>);
    });

    await flushMicrotasks();
    socket.send(JSON.stringify({ type: "message", chat_id: "chat-native", content: "hello" }));
    await flushMicrotasks();
    await flushMicrotasks();

    expect(handlers.get(toDesktopNativeTauriEventName("agent.awaiting_form"))).toBeDefined();
    expect(handlers.get(toDesktopNativeTauriEventName("agent.awaiting_approval"))).toBeDefined();

    handlers.get(toDesktopNativeTauriEventName("agent.awaiting_form"))?.({
      runId: "run-3",
      formId: "travel-form",
      form: {
        form_id: "travel-form",
        title: "Travel preferences",
        fields: [{ name: "destination", label: "Destination", type: "text" }],
        correlation: { reason: "trip" },
      },
      stopReason: "awaiting_form",
    });
    handlers.get(toDesktopNativeTauriEventName("agent.awaiting_approval"))?.({
      actions: ["approveOnce", "deny"],
      runId: "run-3",
      argsPreview: "shell command",
      approvalId: "approval-1",
      riskLevel: "medium",
      stopReason: "awaiting_approval",
      toolCallId: "call-shell",
    });

    expect(events).toContainEqual({
      event: "agent_ui_event",
      chat_id: "chat-native",
      agent_ui_event: {
        event_type: "ui.form.requested",
        chat_id: "chat-native",
        payload: {
          form_id: "travel-form",
          title: "Travel preferences",
          fields: [{ name: "destination", label: "Destination", type: "text" }],
          correlation: {
            reason: "trip",
            chat_id: "chat-native",
            form_id: "travel-form",
            run_id: "run-3",
            session_id: "websocket:chat-native",
          },
        },
      },
    });
    expect(events).toContainEqual({
      event: "approval_pending",
      chat_id: "chat-native",
      approval_id: "approval-1",
    });
    expect(events).toContainEqual(expect.objectContaining({
      event: "agent_event",
      event_type: "approval.requested",
      chat_id: "chat-native",
      turn_id: "run-3",
      payload: expect.objectContaining({
        actions: ["approveOnce", "deny"],
        approval_id: "approval-1",
        args_preview: "shell command",
        risk_level: "medium",
        tool_call_id: "call-shell",
      }),
    }));
  });

  test("emits approval resolved structured events while forwarding legacy approval frames", async () => {
    const nativeTransport: NativeTransportApi = {
      gatewayFrame: vi.fn(),
      websocketMessage: vi.fn(),
      dispatchWebsocketMessage: vi.fn(async () => ({
        transport: {
          kind: "message",
          chatId: "chat-native",
          sessionId: "websocket:chat-native",
          frames: [],
        },
      })),
      dispatchChannelInbound: vi.fn(),
      startChannels: vi.fn(),
      channelStatus: vi.fn(),
      stopChannels: vi.fn(),
    };
    const socket = createDesktopNativeWebSocket({
      url: "/ws",
      nativeTransport,
    });
    const events: Array<Record<string, unknown>> = [];
    socket.addEventListener("message", (event) => {
      events.push(JSON.parse(String((event as MessageEvent).data)) as Record<string, unknown>);
    });

    await flushMicrotasks();
    socket.send(JSON.stringify({ type: "message", chat_id: "chat-native", content: "needs approval" }));
    await flushMicrotasks();
    const request = vi.mocked(nativeTransport.dispatchWebsocketMessage).mock.calls[0]?.[0] as { runId?: string };
    expect(request.runId).toBeTruthy();

    socket.send(JSON.stringify({
      type: "approval",
      chat_id: "chat-native",
      run_id: request.runId,
      approval_id: "approval-1",
      action: "deny",
      tool_call_id: "call-shell",
    }));
    await flushMicrotasks();

    expect(nativeTransport.dispatchWebsocketMessage).toHaveBeenCalledTimes(2);
    expect(events).toContainEqual(expect.objectContaining({
      event: "agent_event",
      event_type: "approval.resolved",
      chat_id: "chat-native",
      turn_id: request.runId,
      step_id: `${request.runId}:approval:approval-1`,
      payload: expect.objectContaining({
        approval_id: "approval-1",
        decision: "denied",
        tool_call_id: "call-shell",
      }),
    }));
  });

  test("projects TS worker task progress into structured agent event frames", async () => {
    const handlers = new Map<string, (payload: unknown) => void>();
    const nativeTransport: NativeTransportApi = {
      gatewayFrame: vi.fn(),
      websocketMessage: vi.fn(),
      dispatchWebsocketMessage: vi.fn(async () => ({
        transport: {
          kind: "message",
          chatId: "chat-native",
          sessionId: "websocket:chat-native",
          frames: [],
        },
        agent: {
          runId: "run-4",
          stopReason: "final_response",
        },
      })),
      dispatchChannelInbound: vi.fn(),
      startChannels: vi.fn(),
      channelStatus: vi.fn(),
      stopChannels: vi.fn(),
    };
    const socket = createDesktopNativeWebSocket({
      url: "/ws",
      nativeTransport,
      listenToAgentEvent: (eventName, handler) => {
        handlers.set(eventName, handler);
      },
    });
    const events: Array<Record<string, unknown>> = [];
    socket.addEventListener("message", (event) => {
      events.push(JSON.parse(String((event as MessageEvent).data)) as Record<string, unknown>);
    });

    await flushMicrotasks();
    socket.send(JSON.stringify({ type: "message", chat_id: "chat-native", content: "hello" }));
    await flushMicrotasks();
    await flushMicrotasks();

    expect(handlers.get(toDesktopNativeTauriEventName("agent.memory_reference"))).toBeDefined();
    expect(handlers.get(toDesktopNativeTauriEventName("agent.task_progress"))).toBeDefined();

    handlers.get(toDesktopNativeTauriEventName("agent.task_progress"))?.({
      runId: "run-4",
      toolCallId: "task-call",
      toolName: "task",
      planId: "plan-1",
      progress: { plan_id: "plan-1", completed: 1, total: 2 },
    });

    expect(events).not.toContainEqual(expect.objectContaining({ event: "message" }));
    expect(events).toContainEqual(expect.objectContaining({
      event: "agent_event",
      event_type: "tool.call.completed",
      payload: expect.objectContaining({
        result_preview: "Task progress updated.",
        status: "completed",
        tool_call_id: "task-call",
      }),
      turn_id: "run-4",
    }));
  });

  test("attaches live memory references to the structured completed message", async () => {
    const handlers = new Map<string, (payload: unknown) => void>();
    const dispatch = deferred<unknown>();
    const nativeTransport: NativeTransportApi = {
      gatewayFrame: vi.fn(),
      websocketMessage: vi.fn(),
      dispatchWebsocketMessage: vi.fn(async () => dispatch.promise),
      dispatchChannelInbound: vi.fn(),
      startChannels: vi.fn(),
      channelStatus: vi.fn(),
      stopChannels: vi.fn(),
    };
    const socket = createDesktopNativeWebSocket({
      url: "/ws",
      nativeTransport,
      listenToAgentEvent: (eventName, handler) => {
        handlers.set(eventName, handler);
      },
    });
    const events: Array<Record<string, unknown>> = [];
    socket.addEventListener("message", (event) => {
      events.push(JSON.parse(String((event as MessageEvent).data)) as Record<string, unknown>);
    });

    await flushMicrotasks();
    socket.send(JSON.stringify({ type: "message", chat_id: "chat-native", content: "hello" }));
    await flushMicrotasks();
    await flushMicrotasks();

    const request = vi.mocked(nativeTransport.dispatchWebsocketMessage).mock.calls[0]?.[0] as { runId?: string };
    handlers.get(toDesktopNativeTauriEventName("agent.delta"))?.({
      runId: request.runId,
      delta: "live answer",
      messageId: "message-live",
    });
    handlers.get(toDesktopNativeTauriEventName("agent.memory_reference"))?.({
      runId: request.runId,
      references: [{ title: "note_live", content: "Live memory" }],
    });
    dispatch.resolve({
      transport: {
        kind: "message",
        chatId: "chat-native",
        sessionId: "websocket:chat-native",
        frames: [],
      },
      agent: {
        runId: request.runId,
        finalContent: "live answer",
        stopReason: "final_response",
      },
    });
    await flushMicrotasks();

    expect(events).toContainEqual(expect.objectContaining({
      event: "agent_event",
      event_type: "message.completed",
      payload: expect.objectContaining({
        message_id: "message-live",
        references: [{ title: "note_live", content: "Live memory" }],
        text: "live answer",
      }),
      turn_id: request.runId,
    }));
  });

  test("projects TS worker browser frames into legacy WebUI browser frame events", async () => {
    const handlers = new Map<string, (payload: unknown) => void>();
    const nativeTransport: NativeTransportApi = {
      gatewayFrame: vi.fn(),
      websocketMessage: vi.fn(),
      dispatchWebsocketMessage: vi.fn(async () => ({
        transport: {
          kind: "message",
          chatId: "chat-native",
          sessionId: "websocket:chat-native",
          frames: [],
        },
        agent: {
          runId: "run-5",
          stopReason: "final_response",
        },
      })),
      dispatchChannelInbound: vi.fn(),
      startChannels: vi.fn(),
      channelStatus: vi.fn(),
      stopChannels: vi.fn(),
    };
    const socket = createDesktopNativeWebSocket({
      url: "/ws",
      nativeTransport,
      listenToAgentEvent: (eventName, handler) => {
        handlers.set(eventName, handler);
      },
    });
    const events: Array<Record<string, unknown>> = [];
    socket.addEventListener("message", (event) => {
      events.push(JSON.parse(String((event as MessageEvent).data)) as Record<string, unknown>);
    });

    await flushMicrotasks();
    socket.send(JSON.stringify({ type: "message", chat_id: "chat-native", content: "hello" }));
    await flushMicrotasks();
    await flushMicrotasks();

    expect(handlers.get(toDesktopNativeTauriEventName("agent.browser_frame"))).toBeDefined();

    handlers.get(toDesktopNativeTauriEventName("agent.browser_frame"))?.({
      runId: "run-5",
      imageUrl: "data:image/png;base64,abc",
      sourceCommand: "opencli browser state",
      capturedAt: "2026-06-13T04:15:00.000Z",
    });

    expect(events).toContainEqual({
      event: "browser_frame",
      chat_id: "chat-native",
      image_url: "data:image/png;base64,abc",
      source_command: "opencli browser state",
      captured_at: "2026-06-13T04:15:00.000Z",
    });
  });

  test("projects TS worker cancellation events into legacy WebUI interrupted frames", async () => {
    const handlers = new Map<string, (payload: unknown) => void>();
    const dispatch = deferred<unknown>();
    const nativeTransport: NativeTransportApi = {
      gatewayFrame: vi.fn(),
      websocketMessage: vi.fn(),
      dispatchWebsocketMessage: vi.fn(async () => dispatch.promise),
      dispatchChannelInbound: vi.fn(),
      startChannels: vi.fn(),
      channelStatus: vi.fn(),
      stopChannels: vi.fn(),
    };
    const socket = createDesktopNativeWebSocket({
      url: "/ws",
      nativeTransport,
      listenToAgentEvent: (eventName, handler) => {
        handlers.set(eventName, handler);
      },
    });
    const events: Array<Record<string, unknown>> = [];
    socket.addEventListener("message", (event) => {
      events.push(JSON.parse(String((event as MessageEvent).data)) as Record<string, unknown>);
    });

    await flushMicrotasks();
    socket.send(JSON.stringify({ type: "message", chat_id: "chat-native", content: "hello" }));
    await flushMicrotasks();
    await flushMicrotasks();

    expect(handlers.get(toDesktopNativeTauriEventName("agent.cancelled"))).toBeDefined();

    handlers.get(toDesktopNativeTauriEventName("agent.cancelled"))?.({ runId: "run-6", cancelled: true });
    dispatch.resolve({
      transport: {
        kind: "message",
        chatId: "chat-native",
        sessionId: "websocket:chat-native",
        frames: [],
      },
      agent: {
        runId: "run-6",
        finalContent: "hello after cancel",
        stopReason: "cancelled",
      },
    });
    await flushMicrotasks();

    expect(events).toContainEqual({
      event: "interrupted",
      chat_id: "chat-native",
      cancelled: true,
    });
    expect(events).not.toContainEqual(expect.objectContaining({
      event: "message",
      chat_id: "chat-native",
      text: "hello after cancel",
    }));
    expect(events).not.toContainEqual(expect.objectContaining({
      event: "stream_end",
      chat_id: "chat-native",
      reason: "cancelled",
    }));
  });

  test("dispatches a correlated interrupt against the active native run", async () => {
    const messageDispatch = deferred<unknown>();
    const dispatchWebsocketMessage = vi.fn(async (request: NativeTransportWebSocketDispatchRequest) => {
      if (request.frame.type === "interrupt") {
        return {
          transport: {
            kind: "interrupt",
            chatId: "chat-native",
            sessionId: "websocket:chat-native",
            frames: [
              { event: "command_accepted", chat_id: "chat-native", command_id: "command-1" },
              { event: "command_canonical_updated", chat_id: "chat-native", command_id: "command-1" },
            ],
          },
        };
      }
      return messageDispatch.promise;
    });
    const nativeTransport: NativeTransportApi = {
      gatewayFrame: vi.fn(),
      websocketMessage: vi.fn(),
      dispatchWebsocketMessage,
      dispatchChannelInbound: vi.fn(),
      startChannels: vi.fn(),
      channelStatus: vi.fn(),
      stopChannels: vi.fn(),
    };
    const socket = createDesktopNativeWebSocket({ url: "/ws", nativeTransport });
    const events: Array<Record<string, unknown>> = [];
    socket.addEventListener("message", (event) => {
      events.push(JSON.parse(String((event as MessageEvent).data)) as Record<string, unknown>);
    });

    await flushMicrotasks();
    socket.send(JSON.stringify({ type: "message", chat_id: "chat-native", content: "hello" }));
    await flushMicrotasks();
    const runId = String(dispatchWebsocketMessage.mock.calls[0][0].runId);

    socket.send(JSON.stringify({
      type: "interrupt",
      chat_id: "chat-native",
      command_id: "command-1",
      run_id: runId,
    }));
    await flushMicrotasks();

    expect(dispatchWebsocketMessage.mock.calls[1][0]).toMatchObject({
      frame: {
        type: "interrupt",
        chat_id: "chat-native",
        command_id: "command-1",
        run_id: runId,
      },
      runId,
    });
    expect(events).toContainEqual({
      event: "command_accepted",
      chat_id: "chat-native",
      command_id: "command-1",
    });
    expect(events).toContainEqual({
      event: "command_canonical_updated",
      chat_id: "chat-native",
      command_id: "command-1",
    });
  });
});

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
