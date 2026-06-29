import { describe, expect, test } from "vitest";

import { handleClientWebSocketFrame } from "./clientFrames";

describe("clientFrames", () => {
  test("maps new_chat and attach frames to legacy immediate responses", () => {
    expect(handleClientWebSocketFrame({
      clientId: "client-1",
      frame: { type: "new_chat" },
      createChatId: () => "chat-new",
    })).toEqual({
      kind: "new_chat",
      chatId: "chat-new",
      sessionId: "websocket:chat-new",
      attachedChatId: "chat-new",
      frames: [{ event: "chat_created", chat_id: "chat-new" }],
    });

    expect(handleClientWebSocketFrame({
      clientId: "client-1",
      frame: { type: "attach", chat_id: "chat-1" },
      sessionExists: true,
    })).toEqual({
      kind: "attach",
      chatId: "chat-1",
      sessionId: "websocket:chat-1",
      attachedChatId: "chat-1",
      frames: [{ event: "attached", chat_id: "chat-1" }],
    });

    expect(handleClientWebSocketFrame({
      clientId: "client-1",
      frame: { type: "attach", chat_id: "missing" },
      sessionExists: false,
    })).toEqual({
      kind: "error",
      frames: [{ event: "error", message: "session not found", chat_id: "missing" }],
    });
  });

  test("maps message frames to inbound user messages with legacy-compatible metadata", () => {
    expect(handleClientWebSocketFrame({
      clientId: "client-1",
      attachedChatId: "chat-1",
      frame: {
        type: "message",
        chat_id: "chat-1",
        content: "  hello  ",
        use_persistent_rag: true,
      },
    })).toEqual({
      kind: "message",
      chatId: "chat-1",
      sessionId: "websocket:chat-1",
      inbound: {
        channel: "websocket",
        sender_id: "client-1",
        chat_id: "chat-1",
        content: "hello",
        metadata: { _use_persistent_rag: true },
        session_key: "websocket:chat-1",
      },
      frames: [],
    });

    expect(handleClientWebSocketFrame({
      clientId: "client-1",
      attachedChatId: "chat-2",
      frame: { type: "message", chat_id: "chat-1", content: "hello" },
    })).toEqual({
      kind: "error",
      frames: [{ event: "error", message: "chat is not attached", chat_id: "chat-1" }],
    });
  });

  test("maps ping, interrupt, and file subscription frames", () => {
    expect(handleClientWebSocketFrame({
      clientId: "client-1",
      frame: { type: "ping" },
    })).toEqual({
      kind: "ping",
      frames: [{ event: "pong" }],
    });

    expect(handleClientWebSocketFrame({
      clientId: "client-1",
      frame: { type: "interrupt", chat_id: "chat-1" },
    })).toEqual({
      kind: "interrupt",
      chatId: "chat-1",
      sessionId: "websocket:chat-1",
      frames: [],
    });

    expect(handleClientWebSocketFrame({
      clientId: "client-1",
      frame: { type: "subscribe_file", path: "AGENTS.md" },
      editablePaths: ["AGENTS.md"],
    })).toEqual({
      kind: "subscribe_file",
      path: "AGENTS.md",
      frames: [{ event: "file_subscribed", path: "AGENTS.md" }],
    });

    expect(handleClientWebSocketFrame({
      clientId: "client-1",
      frame: { type: "subscribe_file", path: "secret.txt" },
      editablePaths: ["AGENTS.md"],
    })).toEqual({
      kind: "error",
      frames: [{ event: "error", message: "file is not editable", path: "secret.txt" }],
    });
  });
});
