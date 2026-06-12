import { describe, expect, test, vi } from "vitest";

import { createDesktopNativeTransportApi } from "./desktopNativeTransport";

describe("desktop native transport", () => {
  test("maps gateway frame requests through the native TS worker command", async () => {
    const invoke = vi.fn(async () => ({
      event: "message",
      chat_id: "chat-1",
      message_id: "msg-1",
      text: "reading file",
    }));
    const transport = createDesktopNativeTransportApi({ invoke });

    await expect(transport.gatewayFrame({
      kind: "message",
      chatId: "chat-1",
      content: "reading file",
      metadata: { _stream_id: "msg-1" },
    })).resolves.toEqual({
      event: "message",
      chat_id: "chat-1",
      message_id: "msg-1",
      text: "reading file",
    });

    expect(invoke).toHaveBeenCalledWith("worker_transport_gateway_frame", {
      input: {
        kind: "message",
        chatId: "chat-1",
        content: "reading file",
        metadata: { _stream_id: "msg-1" },
      },
    });
  });

  test("maps websocket client messages through the native TS worker command", async () => {
    const invoke = vi.fn(async () => ({
      kind: "message",
      chatId: "chat-1",
      sessionId: "websocket:chat-1",
      inbound: {
        type: "message",
        chatId: "chat-1",
        content: "hello",
      },
      frames: [],
    }));
    const transport = createDesktopNativeTransportApi({ invoke });

    await expect(transport.websocketMessage({
      clientId: "client-1",
      attachedChatId: "chat-1",
      frame: {
        type: "message",
        chat_id: "chat-1",
        content: "hello",
        use_persistent_rag: true,
      },
      editablePaths: ["AGENTS.md"],
    })).resolves.toMatchObject({
      kind: "message",
      chatId: "chat-1",
      sessionId: "websocket:chat-1",
    });

    expect(invoke).toHaveBeenCalledWith("worker_transport_websocket_message", {
      input: {
        clientId: "client-1",
        attachedChatId: "chat-1",
        frame: {
          type: "message",
          chat_id: "chat-1",
          content: "hello",
          use_persistent_rag: true,
        },
        editablePaths: ["AGENTS.md"],
      },
    });
  });

  test("dispatches websocket client messages through the native TS worker agent path", async () => {
    const invoke = vi.fn(async () => ({
      transport: {
        kind: "message",
        chatId: "chat-1",
        sessionId: "websocket:chat-1",
        frames: [],
      },
      agent: {
        finalContent: "done",
        stopReason: "final_response",
      },
    }));
    const transport = createDesktopNativeTransportApi({ invoke });

    await expect(transport.dispatchWebsocketMessage({
      clientId: "client-1",
      attachedChatId: "chat-1",
      frame: {
        type: "message",
        chat_id: "chat-1",
        content: "hello",
      },
      model: "gpt-5",
      maxIterations: 6,
    })).resolves.toMatchObject({
      transport: { kind: "message", chatId: "chat-1" },
      agent: { stopReason: "final_response" },
    });

    expect(invoke).toHaveBeenCalledWith("worker_transport_dispatch_websocket_message", {
      input: {
        clientId: "client-1",
        attachedChatId: "chat-1",
        frame: {
          type: "message",
          chat_id: "chat-1",
          content: "hello",
        },
        model: "gpt-5",
        maxIterations: 6,
      },
    });
  });
});
