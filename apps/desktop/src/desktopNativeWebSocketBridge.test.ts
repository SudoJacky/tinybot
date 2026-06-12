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
    handlers.get("agent.done")?.({ runId: "run-1", stopReason: "final_response" });
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
