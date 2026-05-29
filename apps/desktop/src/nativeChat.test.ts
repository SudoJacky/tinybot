import { describe, expect, test } from "vitest";
import {
  applyChatEvent,
  appendUserMessage,
  createNativeChatState,
  normalizeMessagesPayload,
  normalizeSessionsPayload,
  sessionKeyForChat,
} from "./nativeChat";

describe("native chat state", () => {
  test("normalizes gateway sessions and messages without changing existing shapes", () => {
    expect(
      normalizeSessionsPayload({
        items: [
          {
            key: "WebSocket:chat-1",
            chat_id: "chat-1",
            title: "Existing session",
            created_at: "2026-05-29T08:00:00Z",
            updated_at: "2026-05-29T08:01:00Z",
          },
        ],
      }),
    ).toEqual([
      {
        key: "WebSocket:chat-1",
        chatId: "chat-1",
        title: "Existing session",
        createdAt: "2026-05-29T08:00:00Z",
        updatedAt: "2026-05-29T08:01:00Z",
      },
    ]);

    expect(
      normalizeMessagesPayload({
        messages: [
          {
            role: "user",
            content: "hello",
            timestamp: "2026-05-29T08:00:00Z",
            message_id: "m-user",
          },
          {
            role: "assistant",
            content: "hi",
            reasoning_content: "thinking",
            timestamp: "2026-05-29T08:00:01Z",
            message_id: "m-assistant",
          },
        ],
      }),
    ).toEqual([
      {
        role: "user",
        content: "hello",
        reasoningContent: "",
        timestamp: "2026-05-29T08:00:00Z",
        messageId: "m-user",
      },
      {
        role: "assistant",
        content: "hi",
        reasoningContent: "thinking",
        timestamp: "2026-05-29T08:00:01Z",
        messageId: "m-assistant",
      },
    ]);
  });

  test("tracks active session and merges streaming deltas like the hosted WebUI", () => {
    const state = createNativeChatState();

    applyChatEvent(state, { kind: "chat.created", chatId: "chat-1", raw: {} });
    appendUserMessage(state, "hello", "2026-05-29T08:00:00Z");
    applyChatEvent(state, {
      kind: "message.delta",
      chatId: "chat-1",
      messageId: "m1",
      text: "think",
      reasoning: true,
      raw: {},
    });
    applyChatEvent(state, {
      kind: "message.delta",
      chatId: "chat-1",
      messageId: "m1",
      text: "answer",
      reasoning: false,
      raw: {},
    });

    expect(state.activeChatId).toBe("chat-1");
    expect(state.activeSessionKey).toBe(sessionKeyForChat("chat-1"));
    expect(state.respondingSessionKeys.has(sessionKeyForChat("chat-1"))).toBe(true);
    expect(state.messages.get(sessionKeyForChat("chat-1"))).toMatchObject([
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: "answer",
        reasoningContent: "think",
        messageId: "m1",
      },
    ]);

    applyChatEvent(state, {
      kind: "message.stream.completed",
      chatId: "chat-1",
      messageId: "m1",
      raw: {},
    });

    expect(state.respondingSessionKeys.has(sessionKeyForChat("chat-1"))).toBe(false);
  });

  test("clears responding state when a stream is interrupted or errors", () => {
    const state = createNativeChatState();
    applyChatEvent(state, { kind: "attached", chatId: "chat-1", raw: {} });
    appendUserMessage(state, "stop later", "2026-05-29T08:00:00Z");

    expect(state.respondingSessionKeys.has(sessionKeyForChat("chat-1"))).toBe(true);

    applyChatEvent(state, {
      kind: "interrupted",
      chatId: "chat-1",
      cancelled: true,
      raw: {},
    });

    expect(state.respondingSessionKeys.has(sessionKeyForChat("chat-1"))).toBe(false);

    appendUserMessage(state, "fail later", "2026-05-29T08:01:00Z");
    applyChatEvent(state, { kind: "error", message: "chat is not attached", raw: {} });

    expect(state.respondingSessionKeys.has(sessionKeyForChat("chat-1"))).toBe(false);
    expect(state.error).toBe("chat is not attached");
  });
});
