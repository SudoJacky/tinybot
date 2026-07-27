import { describe, expect, test } from "vitest";
import {
  activateSession,
  createNativeChatState,
  normalizeSessionsPayload,
  setSessions,
} from "./nativeChat";

describe("native Thread session state", () => {
  test("normalizes canonical Thread records", () => {
    expect(normalizeSessionsPayload({
      threads: [{
        threadId: "thread-1",
        title: "Review workspace",
        status: "idle",
        createdAt: "2026-07-27T08:00:00Z",
        updatedAt: "2026-07-27T08:01:00Z",
        metadata: {
          workingDirectory: "D:\\code\\tinybot",
          extra: { pinned: true },
        },
      }],
    })).toEqual([{
      key: "thread-1",
      chatId: "thread-1",
      threadId: "thread-1",
      title: "Review workspace",
      status: "idle",
      createdAt: "2026-07-27T08:00:00Z",
      updatedAt: "2026-07-27T08:01:00Z",
      pinned: true,
      workingDirectory: "D:\\code\\tinybot",
    }]);
  });

  test("tracks the active canonical Thread without creating message buckets", () => {
    const state = createNativeChatState();
    const sessions = normalizeSessionsPayload({
      threads: [{
        threadId: "thread-1",
        title: "Review workspace",
        status: "idle",
        createdAt: "2026-07-27T08:00:00Z",
        updatedAt: "2026-07-27T08:01:00Z",
      }],
    });

    setSessions(state, sessions);
    activateSession(state, "thread-1", "thread-1");

    expect(state.activeSessionKey).toBe("thread-1");
    expect(state.activeChatId).toBe("thread-1");
    expect(state.sessions).toEqual(sessions);
  });
});
