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
});
