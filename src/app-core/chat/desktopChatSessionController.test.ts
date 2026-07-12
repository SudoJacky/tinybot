import { describe, expect, test, vi } from "vitest";
import {
  createDesktopChatSessionController as createControllerUnderTest,
  type DesktopChatSessionControllerOptions,
} from "./desktopChatSessionController";
import { sessionKeyForChat } from "./nativeChat";

function createDesktopChatSessionController(options: DesktopChatSessionControllerOptions) {
  return createControllerUnderTest({
    ...options,
    api: {
      listAgentRuns: vi.fn(async () => ({ runs: [] })),
      getAgentRunRuntimeState: vi.fn(async () => null),
      ...options.api,
    },
  });
}

describe("desktop chat session controller", () => {
  test("loads sessions and attaches the first active chat through gateway-compatible contracts", async () => {
    const sent: unknown[] = [];
    const controller = createDesktopChatSessionController({
      api: {
        listSessions: vi.fn(async () => ({
          items: [{ key: "websocket:chat-1", chat_id: "chat-1", title: "Plan", updated_at: "2026-05-31T08:00:00Z" }],
        })),
        loadMessages: vi.fn(async (key: string) => ({
          messages: [{ role: "user", content: `loaded ${key}`, message_id: "m-user" }],
        })),
      },
      sendSocketMessage: (message) => sent.push(message),
    });

    await expect(controller.loadSessions()).resolves.toBe(1);

    expect(controller.state.activeSessionKey).toBe("websocket:chat-1");
    expect(controller.state.chatRuns.turnsBySession.get("websocket:chat-1")).toEqual([]);
    expect(sent).toEqual([{ type: "attach", chat_id: "chat-1" }]);
  });

  test("hydrates restored chat surface messages from backend turn items when available", async () => {
    const sent: unknown[] = [];
    const listAgentRuns = vi.fn(async () => ({
      sessionId: "websocket:chat-1",
      runs: [{ runId: "run-1", startedAt: "2026-07-03T01:00:00Z" }],
    }));
    const getAgentRunRuntimeState = vi.fn(async () => ({
      runtimeEvents: [],
      timeline: {
        schemaVersion: "tinybot.timeline.v2",
        sessionId: "websocket:chat-1",
        runId: "run-1",
        snapshotRevision: 2,
        items: [
          {
            schemaVersion: "tinybot.turn_item.v2",
            itemId: "m-user",
            sessionId: "websocket:chat-1",
            runId: "run-1",
            turnId: "run-1",
            sequence: 1,
            revision: 1,
            kind: "user_message",
            status: "completed",
            createdAt: "2026-07-03T01:00:00Z",
            data: { type: "user_message", messageId: "m-user", content: "Read README" },
          },
          {
            schemaVersion: "tinybot.turn_item.v2",
            itemId: "call-read",
            sessionId: "websocket:chat-1",
            runId: "run-1",
            turnId: "run-1",
            sequence: 2,
            revision: 1,
            kind: "tool_call",
            status: "completed",
            createdAt: "2026-07-03T01:00:01Z",
            title: "read_file",
            summary: "README contents",
            data: {
              type: "tool_call",
              toolCallId: "call-read",
              name: "read_file",
              status: "completed",
              args: { path: "README.md" },
              result: { summary: "README contents" },
              detailId: "tool:call-read",
              timing: {},
            },
          },
        ],
      },
    }));
    const controller = createDesktopChatSessionController({
      api: {
        listSessions: vi.fn(async () => ({
          items: [{ key: "websocket:chat-1", chat_id: "chat-1", title: "Plan", updated_at: "2026-07-03T01:00:00Z" }],
        })),
        loadMessages: vi.fn(async () => ({
          messages: [{ role: "user", content: "Read README", timestamp: "2026-07-03T01:00:00Z", message_id: "m-user" }],
        })),
        listAgentRuns,
        getAgentRunRuntimeState,
      },
      sendSocketMessage: (message) => sent.push(message),
    });

    await controller.loadSessions();

    expect(listAgentRuns).toHaveBeenCalledWith("websocket:chat-1");
    expect(getAgentRunRuntimeState).toHaveBeenCalledWith("websocket:chat-1", "run-1");
    expect(controller.state.chatRuns.turnsBySession.get("websocket:chat-1")?.[0]).toMatchObject({
      id: "run-1",
      userMessage: { text: "Read README" },
      steps: [expect.objectContaining({
        kind: "tool_call",
        toolCall: expect.objectContaining({
          id: "call-read",
          resultPreview: "README contents",
        }),
      })],
    });
    expect(sent).toEqual([{ type: "attach", chat_id: "chat-1" }]);
  });

  test("reloads the authoritative snapshot when a live patch skips a revision", async () => {
    const sessionId = "websocket:chat-gap";
    const runId = "run-gap";
    const userItem = {
      schemaVersion: "tinybot.turn_item.v2",
      itemId: "user-gap",
      sessionId,
      runId,
      turnId: runId,
      sequence: 1,
      revision: 1,
      kind: "user_message",
      status: "completed",
      createdAt: "2026-07-11T00:00:00Z",
      data: { type: "user_message", messageId: "user-gap", content: "Recover the gap" },
    };
    const assistantItem = {
      schemaVersion: "tinybot.turn_item.v2",
      itemId: "assistant-gap",
      sessionId,
      runId,
      turnId: runId,
      sequence: 2,
      revision: 2,
      kind: "assistant_message",
      status: "completed",
      createdAt: "2026-07-11T00:00:01Z",
      updatedAt: "2026-07-11T00:00:02Z",
      data: { type: "assistant_message", messageId: "assistant-gap", modelCallId: "call-gap", phase: "final_answer", content: "Recovered" },
    };
    const getAgentRunRuntimeState = vi.fn()
      .mockResolvedValueOnce({
        runtimeEvents: [],
        timeline: { schemaVersion: "tinybot.timeline.v2", sessionId, runId, snapshotRevision: 1, items: [userItem] },
      })
      .mockResolvedValue({
        runtimeEvents: [],
        timeline: { schemaVersion: "tinybot.timeline.v2", sessionId, runId, snapshotRevision: 3, items: [userItem, assistantItem] },
      });
    const controller = createDesktopChatSessionController({
      api: {
        listSessions: vi.fn(async () => ({
          items: [{ key: sessionId, chat_id: "chat-gap", title: "Gap", updated_at: "2026-07-11T00:00:00Z" }],
        })),
        loadMessages: vi.fn(async () => ({ messages: [] })),
        listAgentRuns: vi.fn(async () => ({ runs: [{ runId }] })),
        getAgentRunRuntimeState,
      },
      sendSocketMessage: vi.fn(),
    });
    await controller.loadSessions();

    const recovered = await controller.applyTimelinePatch(sessionId, {
      schemaVersion: "tinybot.timeline_patch.v2",
      sessionId,
      runId,
      snapshotRevision: 3,
      item: assistantItem,
    });

    expect(getAgentRunRuntimeState).toHaveBeenCalledTimes(2);
    expect(recovered?.runRevisions).toEqual({ [runId]: 3 });
    expect(recovered?.turns[0]).toMatchObject({
      status: "completed",
      finalAnswer: { id: "assistant-gap", text: "Recovered" },
    });
  });

  test("replays delegated trace events when selecting a persisted native session", async () => {
    const sent: unknown[] = [];
    const listTraceEvents = vi.fn(async () => ({
      events: [{
        eventId: "trace-event-1",
        eventType: "agent.delegate.trace.updated",
        sessionKey: "websocket:chat-1",
        turnId: "turn-restored",
        stepId: "step-delegate-1",
        sequence: 1,
        createdAt: "2026-06-28T04:00:01Z",
        payload: {
          delegate_id: "delegate-1",
          delegate_type: "spawn",
          final_output: "hello",
          parent_tool_call_id: "call-spawn",
          status: "completed",
          task: "Say hello",
          title: "Greeter",
          tool_name: "spawn_agent",
          trace_ref: "trace-delegate-1",
          trace: {
            delegateId: "delegate-1",
            parentRunId: "run-parent",
            parentSessionKey: "websocket:chat-1",
            status: "completed",
            steps: [{
              id: "message:delegate-1",
              kind: "message",
              status: "completed",
              title: "Assistant message",
              summary: "hello",
            }],
          },
        },
      }],
    }));
    const controller = createDesktopChatSessionController({
      api: {
        listSessions: vi.fn(async () => ({
          items: [{ key: "websocket:chat-1", chat_id: "chat-1", title: "Spawn", updated_at: "2026-06-28T04:00:00Z" }],
        })),
        loadMessages: vi.fn(async () => ({
          messages: [{ role: "user", content: "spawn a subagent", message_id: "m-user" }],
        })),
        listTraceEvents,
      },
      sendSocketMessage: (message) => sent.push(message),
    });

    await controller.loadSessions();

    expect(listTraceEvents).toHaveBeenCalledWith({ sessionKey: "websocket:chat-1" });
    const toolActivities = [...(controller.state.messages.get("websocket:chat-1") ?? [])]
      .flatMap((message) => message.toolActivities ?? []);
    expect(toolActivities).toEqual([
      expect.objectContaining({
        delegatedTrace: expect.objectContaining({
          delegateId: "delegate-1",
          steps: [expect.objectContaining({ summary: "hello" })],
        }),
        delegateId: "delegate-1",
        delegateTask: "Say hello",
        delegateTitle: "Greeter",
        finalOutput: "hello",
        id: "call-spawn",
        name: "spawn_agent",
        status: "completed",
        traceRef: "trace-delegate-1",
      }),
    ]);
    expect(sent).toEqual([{ type: "attach", chat_id: "chat-1" }]);
  });

  test("loads a delegated artifact through the trace API", async () => {
    const getArtifact = vi.fn(async () => ({
      artifact: {
        artifactId: "artifact-1",
        content: "artifact body",
      },
    }));
    const controller = createDesktopChatSessionController({
      api: {
        getArtifact,
        listSessions: vi.fn(async () => ({ items: [] })),
        loadMessages: vi.fn(async () => ({ messages: [] })),
      },
      sendSocketMessage: vi.fn(),
    });

    await expect(controller.loadArtifact({
      artifactId: "artifact-1",
      delegateId: "delegate-1",
      sessionKey: "websocket:chat-1",
      traceRef: "trace-1",
    })).resolves.toEqual({
      artifact: {
        artifactId: "artifact-1",
        content: "artifact body",
      },
    });

    expect(getArtifact).toHaveBeenCalledWith({
      artifactId: "artifact-1",
      delegateId: "delegate-1",
      sessionKey: "websocket:chat-1",
      traceRef: "trace-1",
    });
  });

  test("preserves gateway session keys when selecting recent chats with non-WebSocket keys", async () => {
    const sent: unknown[] = [];
    const controller = createDesktopChatSessionController({
      api: {
        listSessions: vi.fn(async () => ({
          items: [
            { key: "7e9e439b4487", chat_id: "chat-7e9e", title: "你好", updated_at: "2026-06-03T08:11:21Z" },
            { key: "websocket:chat-1", chat_id: "chat-1", title: "New session" },
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
    expect(controller.state.chatRuns.turnsBySession.get("7e9e439b4487")).toEqual([]);
    expect(sent).toContainEqual({ type: "attach", chat_id: "chat-7e9e" });
  });

  test("deletes the active session, refreshes gateway sessions, and selects the next chat", async () => {
    const sent: unknown[] = [];
    const deleted: string[] = [];
    let sessions = [
      { key: "websocket:chat-1", chat_id: "chat-1", title: "First chat" },
      { key: "websocket:chat-2", chat_id: "chat-2", title: "Second chat" },
    ];
    const controller = createDesktopChatSessionController({
      api: {
        listSessions: vi.fn(async () => ({ items: sessions })),
        loadMessages: vi.fn(async (key: string) => ({
          messages: [{ role: "assistant", content: `loaded ${key}`, message_id: `m-${key}` }],
        })),
        deleteSession: vi.fn(async (key: string) => {
          deleted.push(key);
          sessions = sessions.filter((session) => session.key !== key);
          return { deleted: true };
        }),
      },
      sendSocketMessage: (message) => sent.push(message),
    });

    await controller.loadSessions();

    await expect(controller.deleteSession("websocket:chat-1")).resolves.toEqual({
      status: "deleted",
      deletedSessionKey: "websocket:chat-1",
      nextSessionKey: "websocket:chat-2",
    });

    expect(deleted).toEqual(["websocket:chat-1"]);
    expect(controller.state.sessions.map((session) => session.key)).toEqual(["websocket:chat-2"]);
    expect(controller.state.activeSessionKey).toBe("websocket:chat-2");
    expect(controller.state.activeChatId).toBe("chat-2");
    expect(controller.state.messages.has("websocket:chat-1")).toBe(false);
    expect(controller.state.chatRuns.turnsBySession.get("websocket:chat-2")).toEqual([]);
    expect(sent).toEqual([
      { type: "attach", chat_id: "chat-1" },
      { type: "attach", chat_id: "chat-2" },
    ]);
  });

  test("retries session deletion with the gateway WebSocket key when the visible key is bare", async () => {
    const deleted: string[] = [];
    let sessions = [
      { key: "5225ad1670a7", chat_id: "5225ad1670a7", title: "New session" },
      { key: "websocket:f9387efaabab", chat_id: "f9387efaabab", title: "Next session" },
    ];
    const controller = createDesktopChatSessionController({
      api: {
        listSessions: vi.fn(async () => ({ items: sessions })),
        loadMessages: vi.fn(async (key: string) => ({
          messages: [{ role: "assistant", content: `loaded ${key}`, message_id: `m-${key}` }],
        })),
        deleteSession: vi.fn(async (key: string) => {
          deleted.push(key);
          if (key === "5225ad1670a7") {
            throw new Error("Gateway request failed: HTTP 404");
          }
          sessions = sessions.filter((session) => session.key !== "5225ad1670a7");
          return { deleted: true };
        }),
      },
      sendSocketMessage: () => undefined,
    });

    await controller.loadSessions();

    await expect(controller.deleteSession("5225ad1670a7")).resolves.toEqual({
      status: "deleted",
      deletedSessionKey: "5225ad1670a7",
      nextSessionKey: "websocket:f9387efaabab",
    });

    expect(deleted).toEqual(["5225ad1670a7", "websocket:5225ad1670a7"]);
    expect(controller.state.sessions.map((session) => session.key)).toEqual(["websocket:f9387efaabab"]);
    expect(controller.state.activeSessionKey).toBe("websocket:f9387efaabab");
  });

  test("patches session metadata and refreshes the local session list", async () => {
    const patched: unknown[] = [];
    let sessions = [
      { key: "websocket:chat-1", chat_id: "chat-1", title: "First chat", metadata: { pinned: false } },
    ];
    const controller = createDesktopChatSessionController({
      api: {
        listSessions: vi.fn(async () => ({ items: sessions })),
        loadMessages: vi.fn(async () => ({ messages: [] })),
        patchSession: vi.fn(async (sessionKey: string, body: unknown) => {
          patched.push({ body, sessionKey });
          sessions = [
            { key: "websocket:chat-1", chat_id: "chat-1", title: "Renamed chat", metadata: { pinned: true } },
          ];
          return { key: sessionKey };
        }),
      },
      sendSocketMessage: vi.fn(),
    });

    await controller.loadSessions();

    await expect(controller.patchSession("websocket:chat-1", { metadata: { pinned: true, title: "Renamed chat" } })).resolves.toBe(true);

    expect(patched).toEqual([{
      body: { metadata: { pinned: true, title: "Renamed chat" } },
      sessionKey: "websocket:chat-1",
    }]);
    expect(controller.state.sessions[0]).toMatchObject({
      pinned: true,
      title: "Renamed chat",
    });
  });

  test("preserves one client event id while a new chat is created and the message is sent", async () => {
    const sent: unknown[] = [];
    const references = [{
      detail: "TinyOS file selection",
      evidenceId: "item-1",
      kind: "reference" as const,
      sourceLine: 3,
      sourcePath: "src/main.ts",
      sourceText: "const value = 1;",
      title: "src/main.ts · L3",
      type: "tinyos.file",
    }];
    const controller = createDesktopChatSessionController({
      api: {
        listSessions: vi.fn(async () => ({
          items: [{ key: "websocket:chat-2", chat_id: "chat-2", title: "", updated_at: "2026-05-31T08:00:00Z" }],
        })),
        loadMessages: vi.fn(async () => ({ messages: [] })),
      },
      sendSocketMessage: (message) => sent.push(message),
      now: () => "2026-05-31T08:00:00.000Z",
      createClientEventId: () => "client-message-1",
    });

    expect(controller.submitMessage("  hello desktop  ", true, undefined, references)).toEqual({
      status: "creating",
      pendingContent: "hello desktop",
      clientEventId: "client-message-1",
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
        references,
        timestamp: "2026-05-31T08:00:00.000Z",
      },
    ]);
    expect(sent).toEqual([
      { type: "new_chat" },
      {
        type: "message",
        chat_id: "chat-2",
        client_event_id: "client-message-1",
        content: "hello desktop",
        references,
        use_persistent_rag: true,
      },
    ]);
  });

  test("keeps a new chat in recent sessions when the gateway list has not persisted it yet", async () => {
    const sent: unknown[] = [];
    const controller = createDesktopChatSessionController({
      api: {
        listSessions: vi.fn(async () => ({ items: [] })),
        loadMessages: vi.fn(async () => ({ messages: [] })),
      },
      sendSocketMessage: (message) => sent.push(message),
      now: () => "2026-06-22T05:30:00.000Z",
      createClientEventId: () => "client-live-question",
    });

    expect(controller.submitMessage("  live question  ")).toEqual({
      status: "creating",
      pendingContent: "live question",
      clientEventId: "client-live-question",
    });

    await expect(controller.handleGatewayEvent({ kind: "chat.created", chatId: "chat-live", raw: {} })).resolves.toEqual({
      pendingMessageSent: true,
      loadedMessagesForChatId: "",
      reloadedSessions: true,
    });

    expect(controller.state.sessions).toMatchObject([
      {
        key: sessionKeyForChat("chat-live"),
        chatId: "chat-live",
        title: "New session",
      },
    ]);
    expect(controller.state.messages.get(sessionKeyForChat("chat-live"))).toMatchObject([
      { role: "user", content: "live question" },
    ]);
    expect(sent).toEqual([
      { type: "new_chat" },
      {
        type: "message",
        chat_id: "chat-live",
        client_event_id: "client-live-question",
        content: "live question",
        use_persistent_rag: true,
      },
    ]);
  });

  test("keeps locally created sessions selectable when gateway messages are not ready yet", async () => {
    const sent: unknown[] = [];
    const loadMessages = vi.fn(async (key: string) => {
      if (key === sessionKeyForChat("chat-live")) {
        throw new Error("Gateway bootstrap failed: Failed to fetch");
      }
      return { messages: [{ role: "assistant", content: `loaded ${key}`, message_id: `m-${key}` }] };
    });
    const controller = createDesktopChatSessionController({
      api: {
        listSessions: vi.fn(async () => ({
          items: [{ key: "websocket:chat-old", chat_id: "chat-old", title: "Older chat" }],
        })),
        loadMessages,
      },
      sendSocketMessage: (message) => sent.push(message),
    });

    await controller.loadSessions();
    controller.startNewChat();
    await controller.handleGatewayEvent({ kind: "chat.created", chatId: "chat-live", raw: {} });
    await controller.selectSession("websocket:chat-old", "chat-old");

    await expect(controller.selectSession(sessionKeyForChat("chat-live"), "chat-live")).resolves.toBeUndefined();

    expect(controller.state.activeSessionKey).toBe(sessionKeyForChat("chat-live"));
    expect(controller.state.activeChatId).toBe("chat-live");
    expect(controller.state.messages.get(sessionKeyForChat("chat-live"))).toEqual([]);
    expect(controller.state.error).toBe("");
    expect(sent).toEqual([
      { type: "attach", chat_id: "chat-old" },
      { type: "new_chat" },
      { type: "attach", chat_id: "chat-old" },
      { type: "attach", chat_id: "chat-live" },
    ]);
  });

  test("sends active chat messages, model overrides, interrupt requests, and attached message loads through existing gateway shapes", async () => {
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
      createClientEventId: () => "client-active-question",
    });

    await controller.handleGatewayEvent({ kind: "attached", chatId: "chat-3", raw: {} });

    expect(controller.submitMessage("question", false, "deepseek-reasoner")).toEqual({
      status: "sent",
      chatId: "chat-3",
      content: "question",
      clientEventId: "client-active-question",
    });
    expect(controller.interruptActiveChat()).toBe(true);
    expect(controller.state.messages.get(sessionKeyForChat("chat-3"))).toMatchObject([
      { role: "user", content: "question" },
    ]);
    expect(sent).toEqual([
      {
        type: "message",
        chat_id: "chat-3",
        client_event_id: "client-active-question",
        content: "question",
        use_persistent_rag: false,
        model: "deepseek-reasoner",
      },
      { type: "interrupt", chat_id: "chat-3" },
    ]);
  });

  test("reloads the canonical timeline through the existing session key", async () => {
    const loadMessages = vi.fn(async (sessionKey: string) => ({
      messages: [{ role: "assistant", content: `loaded ${sessionKey}`, message_id: "m1" }],
    }));
    const controller = createDesktopChatSessionController({
      api: {
        listSessions: vi.fn(async () => ({
          items: [{ key: "WebSocket:chat-native", chat_id: "chat-native", title: "Native chat" }],
        })),
        loadMessages,
      },
      sendSocketMessage: vi.fn(),
    });

    await controller.loadSessions();
    loadMessages.mockClear();

    await controller.handleGatewayEvent({ kind: "attached", chatId: "chat-native", raw: {} });

    expect(loadMessages).not.toHaveBeenCalled();
    expect(controller.state.chatRuns.turnsBySession.get("websocket:chat-native")).toEqual([]);
    expect(controller.state.messages.has("WebSocket:chat-native")).toBe(false);
  });
});
