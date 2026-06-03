import { describe, expect, test, vi } from "vitest";
import { createDesktopChatSessionController } from "./desktopChatSessionController";
import { sessionKeyForChat } from "./nativeChat";

describe("desktop chat session controller", () => {
  test("loads sessions and attaches the first active chat through gateway-compatible contracts", async () => {
    const sent: unknown[] = [];
    const controller = createDesktopChatSessionController({
      api: {
        listSessions: vi.fn(async () => ({
          items: [{ key: "WebSocket:chat-1", chat_id: "chat-1", title: "Plan", updated_at: "2026-05-31T08:00:00Z" }],
        })),
        loadMessages: vi.fn(async (key: string) => ({
          messages: [{ role: "user", content: `loaded ${key}`, message_id: "m-user" }],
        })),
      },
      sendSocketMessage: (message) => sent.push(message),
    });

    await expect(controller.loadSessions()).resolves.toBe(1);

    expect(controller.state.activeSessionKey).toBe("WebSocket:chat-1");
    expect(controller.state.messages.get("WebSocket:chat-1")).toMatchObject([{ content: "loaded WebSocket:chat-1" }]);
    expect(sent).toEqual([{ type: "attach", chat_id: "chat-1" }]);
  });

  test("preserves gateway session keys when selecting recent chats with non-WebSocket keys", async () => {
    const sent: unknown[] = [];
    const controller = createDesktopChatSessionController({
      api: {
        listSessions: vi.fn(async () => ({
          items: [
            { key: "7e9e439b4487", chat_id: "chat-7e9e", title: "你好", updated_at: "2026-06-03T08:11:21Z" },
            { key: "WebSocket:chat-1", chat_id: "chat-1", title: "New session" },
          ],
        })),
        loadMessages: vi.fn(async (key: string) => ({
          messages: [{ role: "assistant", content: `loaded ${key}`, message_id: `m-${key}` }],
        })),
      },
      sendSocketMessage: (message) => sent.push(message),
    });

    await controller.loadSessions();
    await controller.selectSession("7e9e439b4487", "chat-7e9e");

    expect(controller.state.activeSessionKey).toBe("7e9e439b4487");
    expect(controller.state.activeChatId).toBe("chat-7e9e");
    expect(controller.state.sessions.map((session) => session.title)).toEqual(["你好", "New session"]);
    expect(controller.state.sessions.filter((session) => session.title === "New session")).toHaveLength(1);
    expect(controller.state.messages.get("7e9e439b4487")).toMatchObject([{ content: "loaded 7e9e439b4487" }]);
    expect(sent).toContainEqual({ type: "attach", chat_id: "chat-7e9e" });
  });

  test("queues a new chat before sending pending content without changing WebSocket payload semantics", async () => {
    const sent: unknown[] = [];
    const controller = createDesktopChatSessionController({
      api: {
        listSessions: vi.fn(async () => ({
          items: [{ key: "WebSocket:chat-2", chat_id: "chat-2", title: "", updated_at: "2026-05-31T08:00:00Z" }],
        })),
        loadMessages: vi.fn(async () => ({ messages: [] })),
      },
      sendSocketMessage: (message) => sent.push(message),
      now: () => "2026-05-31T08:00:00.000Z",
    });

    expect(controller.submitMessage("  hello desktop  ")).toEqual({
      status: "creating",
      pendingContent: "hello desktop",
    });
    expect(sent).toEqual([{ type: "new_chat" }]);

    await expect(controller.handleGatewayEvent({ kind: "chat.created", chatId: "chat-2", raw: {} })).resolves.toEqual({
      pendingMessageSent: true,
      loadedMessagesForChatId: "",
      reloadedSessions: true,
    });

    expect(controller.state.activeChatId).toBe("chat-2");
    expect(controller.state.messages.get(sessionKeyForChat("chat-2"))).toMatchObject([
      {
        role: "user",
        content: "hello desktop",
        timestamp: "2026-05-31T08:00:00.000Z",
      },
    ]);
    expect(sent).toEqual([
      { type: "new_chat" },
      { type: "message", chat_id: "chat-2", content: "hello desktop", use_persistent_rag: true },
    ]);
  });

  test("sends active chat messages, interrupt requests, and attached message loads through existing gateway shapes", async () => {
    const sent: unknown[] = [];
    const controller = createDesktopChatSessionController({
      api: {
        listSessions: vi.fn(async () => ({ items: [] })),
        loadMessages: vi.fn(async () => ({
          messages: [{ role: "assistant", content: "persisted", message_id: "m2" }],
        })),
      },
      sendSocketMessage: (message) => sent.push(message),
      now: () => "2026-05-31T08:00:00.000Z",
    });

    await controller.handleGatewayEvent({ kind: "attached", chatId: "chat-3", raw: {} });

    expect(controller.submitMessage("question", false)).toEqual({
      status: "sent",
      chatId: "chat-3",
      content: "question",
    });
    expect(controller.interruptActiveChat()).toBe(true);
    expect(controller.state.messages.get(sessionKeyForChat("chat-3"))).toMatchObject([
      { role: "assistant", content: "persisted" },
      { role: "user", content: "question" },
    ]);
    expect(sent).toEqual([
      { type: "message", chat_id: "chat-3", content: "question", use_persistent_rag: false },
      { type: "interrupt", chat_id: "chat-3" },
    ]);
  });
});
