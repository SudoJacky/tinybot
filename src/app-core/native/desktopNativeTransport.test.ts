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

  test("dispatches generic channel inbound envelopes through the native TS worker command", async () => {
    const invoke = vi.fn(async () => ({
      dispatched: 1,
      outbound_messages: [
        {
          channel: "feishu",
          chat_id: "oc_1",
          content: "done",
          media: [],
          metadata: {},
        },
      ],
    }));
    const transport = createDesktopNativeTransportApi({ invoke });

    await expect(transport.dispatchChannelInbound({
      message: {
        channel: "feishu",
        sender_id: "ou_1",
        chat_id: "oc_1",
        content: "hello",
        timestamp: "2026-06-13T02:00:00.000Z",
        media: ["file://clip.png"],
        metadata: { message_id: "mid-1" },
        session_key_override: "thread:42",
      },
    })).resolves.toMatchObject({
      dispatched: 1,
      outbound_messages: [expect.objectContaining({ channel: "feishu", chat_id: "oc_1" })],
    });

    expect(invoke).toHaveBeenCalledWith("worker_channel_dispatch_inbound", {
      input: {
        message: {
          channel: "feishu",
          sender_id: "ou_1",
          chat_id: "oc_1",
          content: "hello",
          timestamp: "2026-06-13T02:00:00.000Z",
          media: ["file://clip.png"],
          metadata: { message_id: "mid-1" },
          session_key_override: "thread:42",
        },
      },
    });
  });

  test("maps channel lifecycle commands through native TS worker commands", async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === "worker_channel_status") {
        return {
          running: true,
          channels: [{ id: "feishu", running: true }],
        };
      }
      return { ok: true };
    });
    const transport = createDesktopNativeTransportApi({ invoke });

    await expect(transport.startChannels()).resolves.toEqual({ ok: true });
    await expect(transport.channelStatus()).resolves.toMatchObject({
      running: true,
      channels: [expect.objectContaining({ id: "feishu", running: true })],
    });
    await expect(transport.stopChannels()).resolves.toEqual({ ok: true });

    expect(invoke).toHaveBeenNthCalledWith(1, "worker_channel_start");
    expect(invoke).toHaveBeenNthCalledWith(2, "worker_channel_status");
    expect(invoke).toHaveBeenNthCalledWith(3, "worker_channel_stop");
  });
});
