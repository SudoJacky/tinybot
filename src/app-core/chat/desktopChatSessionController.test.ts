import { describe, expect, test, vi } from "vitest";

import { createDesktopChatSessionController } from "./desktopChatSessionController";

function createController(overrides: Record<string, unknown> = {}) {
  const submitThreadTurn = vi.fn(async () => ({
    threadId: "thread-1",
    sessionId: "thread-1",
    turnId: "turn-1",
  }));
  const api = {
    listThreads: vi.fn(async () => ({
      threads: [{
        threadId: "thread-1",
        sessionKey: "thread-1",
        title: "Native thread",
        status: "idle" as const,
        createdAt: "2026-07-14T00:00:00.000Z",
        updatedAt: "2026-07-14T00:00:00.000Z",
      }],
      total: 1,
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
    }),
    submitThreadTurn,
  };
}

function usageItem(sequence: number, createdAt: string) {
  return {
    schemaVersion: "tinybot.turn_item.v2",
    itemId: "turn-usage:usage:0",
    sessionId: "thread-1",
    threadId: "thread-1",
    turnId: "turn-usage",
    sequence,
    revision: 1,
    kind: "usage",
    status: "completed",
    createdAt,
    data: {
      type: "usage",
      id: "turn-usage:usage:0",
      inputTokens: 4_469,
      outputTokens: 219,
      totalTokens: 4_688,
      providerPayload: {},
    },
  };
}

function usageRuntimeState(sequence: number, createdAt: string) {
  return {
    runtimeEvents: [],
    status: "running",
    timeline: {
      schemaVersion: "tinybot.timeline.v2",
      sessionId: "thread-1",
      turnId: "turn-usage",
      snapshotRevision: 1,
      items: [usageItem(sequence, createdAt)],
    },
  };
}

function usagePatch(sequence: number, createdAt: string) {
  return {
    schemaVersion: "tinybot.timeline_patch.v2",
    sessionId: "thread-1",
    turnId: "turn-usage",
    snapshotRevision: 1,
    item: usageItem(sequence, createdAt),
  };
}

function toolCallItem(sequence: number, revision: number, status: "running" | "completed") {
  return {
    schemaVersion: "tinybot.turn_item.v2",
    itemId: "call-1",
    sessionId: "thread-1",
    threadId: "thread-1",
    turnId: "turn-tool",
    sequence,
    revision,
    kind: "tool_call",
    status,
    createdAt: "1786682410223",
    ...(revision > 1 ? { updatedAt: "1786682412260" } : {}),
    data: {
      type: "tool_call",
      toolCallId: "call-1",
      name: "exec_command",
      status,
      args: { command: "dir" },
      result: status === "completed" ? { exitCode: 0 } : null,
      timing: {},
    },
  };
}

function toolRuntimeState(sequence: number, revision: number, status: "running" | "completed") {
  return {
    runtimeEvents: [],
    status: "running",
    timeline: {
      schemaVersion: "tinybot.timeline.v2",
      sessionId: "thread-1",
      turnId: "turn-tool",
      snapshotRevision: revision,
      items: [toolCallItem(sequence, revision, status)],
    },
  };
}

describe("desktop native chat session controller", () => {
  test("loads and selects Thread records without a transport attach", async () => {
    const { controller } = createController();

    await expect(controller.loadSessions()).resolves.toBe(1);

    expect(controller.state.activeThreadId).toBe("thread-1");
    expect(controller.state.threads[0]?.threadId).toBe("thread-1");
  });

  test("preserves the exact canonical Thread ID without WebSocket alias rewriting", async () => {
    const threadId = "WebSocket:thread-case-sensitive";
    const { api, controller } = createController({
      listThreads: vi.fn(async () => ({
        threads: [{
          threadId,
          title: "Case-sensitive Thread",
          status: "idle" as const,
          createdAt: "2026-07-14T00:00:00.000Z",
          updatedAt: "2026-07-14T00:00:00.000Z",
        }],
        total: 1,
      })),
    });

    await controller.loadSessions();

    expect(controller.state.activeThreadId).toBe(threadId);
    expect(controller.state.threads[0]?.threadId).toBe(threadId);
    expect(api.listTurns).toHaveBeenCalledWith(threadId);
  });

  test("refreshes canonical runtime state when an existing session is selected again", async () => {
    const { api, controller } = createController();
    await controller.loadSessions();
    expect(api.listTurns).toHaveBeenCalledTimes(1);

    await controller.selectSession("thread-1");

    expect(api.listTurns).toHaveBeenCalledTimes(2);
  });

  test("submits a typed Thread turn and preserves optimistic references", async () => {
    const { controller, submitThreadTurn } = createController();
    await controller.loadSessions();

    const result = await controller.submitMessage("hello", {
      model: "model-1",
      provider: "openai",
      reasoningEffort: "xhigh",
      references: [{
        kind: "reference",
        title: "README",
        detail: "selected file",
      }],
      selectedSkills: ["create-agent-plugin:migrate-agent-plugin"],
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
        provider: "openai",
        reasoningEffort: "xhigh",
        metadata: {
          clientEventId: "client-1",
          references: [{ kind: "reference", title: "README", detail: "selected file" }],
          selectedSkills: ["create-agent-plugin:migrate-agent-plugin"],
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

  test("does not replay a buffered live patch already covered by the loaded snapshot", async () => {
    let resolveRuntimeState: (value: unknown) => void = () => undefined;
    const runtimeState = new Promise<unknown>((resolve) => {
      resolveRuntimeState = resolve;
    });
    const getAgentTurnRuntimeState = vi.fn(() => runtimeState);
    const { controller } = createController({
      listTurns: vi.fn(async () => ({ turns: [{ turnId: "turn-usage" }] })),
      getAgentTurnRuntimeState,
    });

    const loading = controller.loadTimeline("thread-1");
    await vi.waitFor(() => expect(getAgentTurnRuntimeState).toHaveBeenCalledTimes(1));
    await expect(controller.applyTimelinePatch("thread-1", usagePatch(23, "1786673534920")))
      .resolves.toBeNull();
    resolveRuntimeState(usageRuntimeState(16, "2026-08-14T02:12:14.921Z"));

    await expect(loading).resolves.toMatchObject({
      turnRevisions: { "turn-usage": 1 },
      turns: [expect.objectContaining({
        canonicalItems: [expect.objectContaining({ sequence: 16 })],
      })],
    });
  });

  test("coalesces concurrent reloads for the same session", async () => {
    let resolveTurns: (value: unknown) => void = () => undefined;
    const turns = new Promise<unknown>((resolve) => {
      resolveTurns = resolve;
    });
    const listTurns = vi.fn(() => turns);
    const { controller } = createController({ listTurns });

    const first = controller.reloadTimeline("thread-1");
    const second = controller.reloadTimeline("thread-1");

    expect(listTurns).toHaveBeenCalledTimes(1);
    resolveTurns({ turns: [] });
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });

  test("reloads durable state when a legacy tool patch disagrees with its persisted sequence", async () => {
    let durableRevision = 1;
    const getAgentTurnRuntimeState = vi.fn(async () => (
      toolRuntimeState(20, durableRevision, durableRevision === 1 ? "running" : "completed")
    ));
    const { controller } = createController({
      listTurns: vi.fn(async () => ({ turns: [{ turnId: "turn-tool" }] })),
      getAgentTurnRuntimeState,
    });
    await controller.loadTimeline("thread-1");
    durableRevision = 2;

    await expect(controller.applyTimelinePatch("thread-1", {
      schemaVersion: "tinybot.timeline_patch.v2",
      sessionId: "thread-1",
      turnId: "turn-tool",
      snapshotRevision: 2,
      item: toolCallItem(33, 2, "completed"),
    })).resolves.toMatchObject({
      turnRevisions: { "turn-tool": 2 },
      turns: [expect.objectContaining({
        canonicalItems: [expect.objectContaining({
          itemId: "call-1",
          sequence: 20,
          revision: 2,
          status: "completed",
        })],
      })],
    });
    expect(getAgentTurnRuntimeState).toHaveBeenCalledTimes(2);
  });
});
