import { describe, expect, test, vi } from "vitest";

import { createDesktopChatSessionController } from "./desktopChatSessionController";

function createController(overrides: Record<string, unknown> = {}) {
  const submitThreadTurn = vi.fn(async () => ({
    threadId: "thread-1",
    sessionId: "thread-1",
    runId: "run-1",
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
    listAgentRuns: vi.fn(async () => ({ runs: [] })),
    getAgentRunRuntimeState: vi.fn(async () => null),
    submitThreadTurn,
    ...overrides,
  };
  return {
    api,
    controller: createDesktopChatSessionController({
      api,
      createClientEventId: () => "client-1",
      createRunId: () => "run-1",
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

    await expect(controller.submitMessage("hello", true, "model-1", [{
      kind: "reference",
      title: "README",
      detail: "selected file",
    }])).resolves.toEqual({
      status: "sent",
      sessionId: "thread-1",
      threadId: "thread-1",
      runId: "run-1",
      content: "hello",
      clientEventId: "client-1",
    });
    expect(submitThreadTurn).toHaveBeenCalledWith({
      threadId: "thread-1",
      input: {
        role: "user",
        content: "hello",
        clientEventId: "client-1",
        references: [{ kind: "reference", title: "README", detail: "selected file" }],
      },
      spec: {
        runId: "run-1",
        sessionId: "thread-1",
        stream: true,
        model: "model-1",
        metadata: {
          clientEventId: "client-1",
          usePersistentRag: true,
          references: [{ kind: "reference", title: "README", detail: "selected file" }],
        },
      },
    });
  });

  test("applies typed timeline patches after the Thread timeline is loaded", async () => {
    const { controller } = createController();
    await controller.loadSessions();
    const patch = {
      schemaVersion: "tinybot.timeline_patch.v2",
      sessionId: "thread-1",
      runId: "run-1",
      snapshotRevision: 1,
      item: {
        schemaVersion: "tinybot.turn_item.v2",
        itemId: "user-1",
        sessionId: "thread-1",
        threadId: "thread-1",
        runId: "run-1",
        turnId: "run-1",
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
      turns: [expect.objectContaining({ id: "run-1" })],
    });
  });
});
