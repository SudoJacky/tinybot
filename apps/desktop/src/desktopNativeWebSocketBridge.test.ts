import { describe, expect, test, vi } from "vitest";
import { createDesktopNativeWebSocket, type DesktopNativeWebSocketAgentEventName } from "./desktopNativeWebSocketBridge";
import type { NativeTransportApi } from "./desktopNativeTransport";

describe("desktop native WebSocket bridge", () => {
  test("projects TS worker stream events into legacy WebUI WebSocket frames", async () => {
    const handlers = new Map<DesktopNativeWebSocketAgentEventName, (payload: unknown) => void>();
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

    expect(handlers.get("agent.delta")).toBeDefined();
    expect(handlers.get("agent.reasoning_delta")).toBeDefined();
    expect(handlers.get("agent.done")).toBeDefined();

    handlers.get("agent.delta")?.({ runId: "run-1", delta: "hello", messageId: "message-1" });
    handlers.get("agent.reasoning_delta")?.({ run_id: "run-1", delta: "thinking", message_id: "message-1" });
    handlers.get("agent.done")?.({
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

    expect(events).toContainEqual({
      event: "delta",
      chat_id: "chat-native",
      message_id: "message-1",
      text: "hello",
      is_reasoning: false,
    });
    expect(events).toContainEqual({
      event: "delta",
      chat_id: "chat-native",
      message_id: "message-1",
      text: "thinking",
      is_reasoning: true,
    });
    expect(events).toContainEqual({
      event: "stream_end",
      chat_id: "chat-native",
      message_id: "message-1",
      reason: "final_response",
      _memory_references: [{ note_id: "note-1" }],
      _recent_context_references: [{ evidence_id: "ev-1" }],
    });
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
    const handlers = new Map<DesktopNativeWebSocketAgentEventName, (payload: unknown) => void>();
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

    handlers.get("agent.delta")?.({ runId, delta: "live", messageId: "message-live" });
    await flushMicrotasks();

    expect(events).toContainEqual({
      event: "delta",
      chat_id: "chat-native",
      message_id: "message-live",
      text: "live",
      is_reasoning: false,
    });

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

  test("projects TS worker tool progress into legacy WebUI message frames", async () => {
    const handlers = new Map<DesktopNativeWebSocketAgentEventName, (payload: unknown) => void>();
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

    handlers.get("agent.tool_call.delta")?.({
      runId: "run-2",
      index: 0,
      deltaText: "{\"path\":\"AGENTS.md\"}",
      toolCallId: "call-read",
      toolName: "read_file",
    });
    handlers.get("agent.tool.start")?.({
      runId: "run-2",
      toolCallId: "call-read",
      toolName: "read_file",
    });
    handlers.get("agent.tool.result")?.({
      runId: "run-2",
      toolCallId: "call-read",
      toolName: "read_file",
      content: "file contents",
    });

    expect(events).toContainEqual({
      event: "message",
      chat_id: "chat-native",
      message_id: "run-2:call-read:args",
      text: "read_file({\"path\":\"AGENTS.md\"})",
      _progress: true,
      _tool_call_id: "call-read",
      _tool_detail: true,
      _tool_hint: true,
      _tool_name: "read_file",
    });
    expect(events).toContainEqual({
      event: "message",
      chat_id: "chat-native",
      message_id: "run-2:call-read:start",
      text: "read_file({\"path\":\"AGENTS.md\"})",
      _progress: true,
      _tool_call_id: "call-read",
      _tool_detail: true,
      _tool_hint: true,
      _tool_name: "read_file",
    });
    expect(events).toContainEqual({
      event: "message",
      chat_id: "chat-native",
      message_id: "run-2:call-read:result",
      text: "file contents",
      _progress: true,
      _tool_call_id: "call-read",
      _tool_name: "read_file",
      _tool_result: true,
    });
  });

  test("projects TS worker awaiting interaction events into legacy WebUI frames", async () => {
    const handlers = new Map<DesktopNativeWebSocketAgentEventName, (payload: unknown) => void>();
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

    expect(handlers.get("agent.awaiting_form")).toBeDefined();
    expect(handlers.get("agent.awaiting_approval")).toBeDefined();

    handlers.get("agent.awaiting_form")?.({
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
    handlers.get("agent.awaiting_approval")?.({
      runId: "run-3",
      approvalId: "approval-1",
      stopReason: "awaiting_approval",
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
  });

  test("projects TS worker memory references and task progress into legacy WebUI message frames", async () => {
    const handlers = new Map<DesktopNativeWebSocketAgentEventName, (payload: unknown) => void>();
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

    expect(handlers.get("agent.memory_reference")).toBeDefined();
    expect(handlers.get("agent.task_progress")).toBeDefined();

    handlers.get("agent.memory_reference")?.({
      runId: "run-4",
      references: [{ note_id: "note-1", content: "Remembered preference" }],
    });
    handlers.get("agent.task_progress")?.({
      runId: "run-4",
      toolCallId: "task-call",
      toolName: "task",
      planId: "plan-1",
      progress: { plan_id: "plan-1", completed: 1, total: 2 },
    });

    expect(events).toContainEqual({
      event: "message",
      chat_id: "chat-native",
      message_id: "run-4",
      text: "",
      _memory_references: [{ note_id: "note-1", content: "Remembered preference" }],
    });
    expect(events).toContainEqual({
      event: "message",
      chat_id: "chat-native",
      message_id: "run-4:task-call:task-progress",
      text: "Task progress updated.",
      _progress: true,
      _tool_call_id: "task-call",
      _tool_name: "task",
      _tool_result: true,
      _task_event: true,
      _task_plan_id: "plan-1",
      _task_progress: { plan_id: "plan-1", completed: 1, total: 2 },
    });
  });

  test("projects TS worker browser frames into legacy WebUI browser frame events", async () => {
    const handlers = new Map<DesktopNativeWebSocketAgentEventName, (payload: unknown) => void>();
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

    expect(handlers.get("agent.browser_frame")).toBeDefined();

    handlers.get("agent.browser_frame")?.({
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
    const handlers = new Map<DesktopNativeWebSocketAgentEventName, (payload: unknown) => void>();
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

    expect(handlers.get("agent.cancelled")).toBeDefined();

    handlers.get("agent.cancelled")?.({ runId: "run-6", cancelled: true });
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
});

async function flushMicrotasks(): Promise<void> {
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
