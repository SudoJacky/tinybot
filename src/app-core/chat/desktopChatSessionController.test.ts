import { describe, expect, test, vi } from "vitest";

import { createDesktopChatSessionController } from "./desktopChatSessionController";

function createController(overrides: Record<string, unknown> = {}) {
  const submitThreadTurn = vi.fn(async () => ({
    threadId: "thread-1",
    sessionId: "thread-1",
    turnId: "turn-1",
    agentResult: {},
    snapshot: {},
  }));
  const api = {
    listSessions: vi.fn(async () => ({
      threads: [{
        threadId: "thread-1",
        sessionKey: "thread-1",
        title: "Native thread",
        status: "idle",
        createdAt: "2026-07-14T00:00:00.000Z",
        updatedAt: "2026-07-14T00:00:00.000Z",
      }],
    })),
    listTurns: vi.fn(async () => ({ turns: [] })),
    getAgentTurnRuntimeState: vi.fn(async () => null),
    submitThreadTurn,
    ...overrides,
  };
  return {
    api,
    controller: createDesktopChatSessionController({
      api,
      createClientEventId: () => "client-1",
      createTurnId: () => "turn-1",
      now: () => "2026-07-14T00:00:01.000Z",
    }),
    submitThreadTurn,
  };
}

describe("desktop native chat session controller", () => {
  test("loads and selects Thread records without a Gateway attach", async () => {
    const { controller } = createController();

    await expect(controller.loadSessions()).resolves.toBe(1);

    expect(controller.state.activeSessionKey).toBe("thread-1");
    expect(controller.state.activeChatId).toBe("thread-1");
  });

  test("submits a typed Thread turn and preserves optimistic references", async () => {
    const { controller, submitThreadTurn } = createController();
    await controller.loadSessions();

    const result = await controller.submitMessage("hello", {
      model: "model-1",
      references: [{
        kind: "reference",
        title: "README",
        detail: "selected file",
      }],
    });
    expect(result).toEqual({
      status: "sent",
      sessionId: "thread-1",
      threadId: "thread-1",
      turnId: "turn-1",
      content: "hello",
      clientEventId: "client-1",
      completion: expect.any(Promise),
    });
    if (result.status === "sent") {
      await expect(result.completion).resolves.toMatchObject({
        sessionId: "thread-1",
        turns: [],
      });
    }
    expect(submitThreadTurn).toHaveBeenCalledWith({
      threadId: "thread-1",
      input: {
        role: "user",
        content: "hello",
        clientEventId: "client-1",
        references: [{ kind: "reference", title: "README", detail: "selected file" }],
      },
      spec: {
        turnId: "turn-1",
        sessionId: "thread-1",
        stream: true,
        model: "model-1",
        metadata: {
          clientEventId: "client-1",
          references: [{ kind: "reference", title: "README", detail: "selected file" }],
        },
      },
    });
  });

  test("submits frontend user content without rewriting it", async () => {
    const { controller, submitThreadTurn } = createController();
    await controller.loadSessions();
    const content = "# Files mentioned by the user:\n\n## notes.md: C:\\Users\\tester\\notes.md\n\n## My request for Tinybot:\nReview this file\n";

    const result = await controller.submitMessage(content);

    expect(result).toEqual(expect.objectContaining({ content }));
    expect(submitThreadTurn).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({ content }),
    }));
  });

  test("uses the desktop command id as the Thread client event id", async () => {
    const { controller, submitThreadTurn } = createController();
    await controller.loadSessions();

    await expect(controller.submitMessage("hello", { clientEventId: "command-turn-1" })).resolves.toEqual(
      expect.objectContaining({ clientEventId: "command-turn-1", status: "sent" }),
    );
    expect(submitThreadTurn).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({ clientEventId: "command-turn-1" }),
      spec: expect.objectContaining({
        metadata: expect.objectContaining({ clientEventId: "command-turn-1" }),
      }),
    }));
  });

  test("applies typed timeline patches after the Thread timeline is loaded", async () => {
    const { controller } = createController();
    await controller.loadSessions();
    const patch = {
      schemaVersion: "tinybot.timeline_patch.v2",
      sessionId: "thread-1",
      turnId: "turn-1",
      snapshotRevision: 1,
      item: {
        schemaVersion: "tinybot.turn_item.v2",
        itemId: "user-1",
        sessionId: "thread-1",
        threadId: "thread-1",
        turnId: "turn-1",
        sequence: 1,
        revision: 1,
        kind: "user_message",
        status: "completed",
        createdAt: "2026-07-14T00:00:01.000Z",
        data: { type: "user_message", messageId: "user-1", content: "hello" },
      },
    };

    await expect(controller.applyTimelinePatch("thread-1", patch)).resolves.toMatchObject({
      source: "canonical",
      turns: [expect.objectContaining({ id: "turn-1" })],
    });
  });
});
