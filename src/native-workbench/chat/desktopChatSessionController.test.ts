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

  test("hydrates restored chat surface messages from backend turn items when available", async () => {
    const sent: unknown[] = [];
    const listAgentRuns = vi.fn(async () => ({
      sessionId: "WebSocket:chat-1",
      runs: [{ runId: "run-1", startedAt: "2026-07-03T01:00:00Z" }],
    }));
    const getAgentRunRuntimeState = vi.fn(async () => ({
      sessionId: "WebSocket:chat-1",
      runId: "run-1",
      runtimeEvents: [],
      turnItems: [{
        itemId: "call-read",
        sessionId: "WebSocket:chat-1",
        turnId: "run-1",
        kind: "tool_call",
        status: "completed",
        createdAt: "2026-07-03T01:00:01Z",
        title: "read_file",
        summary: "README contents",
        payload: {
          toolCallId: "call-read",
          toolName: "read_file",
          argsPreview: "{\"path\":\"README.md\"}",
          resultPreview: "README contents",
        },
      }],
    }));
    const controller = createDesktopChatSessionController({
      api: {
        listSessions: vi.fn(async () => ({
          items: [{ key: "WebSocket:chat-1", chat_id: "chat-1", title: "Plan", updated_at: "2026-07-03T01:00:00Z" }],
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

    expect(listAgentRuns).toHaveBeenCalledWith("WebSocket:chat-1");
    expect(getAgentRunRuntimeState).toHaveBeenCalledWith("WebSocket:chat-1", "run-1");
    expect(controller.state.chatRuns.turnsBySession.get("WebSocket:chat-1")?.[0]).toMatchObject({
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
    expect(controller.state.messages.get("WebSocket:chat-1")?.flatMap((message) => message.toolActivities ?? [])).toEqual([
      expect.objectContaining({
        id: "call-read",
        name: "read_file",
        responseText: "README contents",
      }),
    ]);
    expect(sent).toEqual([{ type: "attach", chat_id: "chat-1" }]);
  });

  test("replays delegated trace events when selecting a persisted native session", async () => {
    const sent: unknown[] = [];
    const listTraceEvents = vi.fn(async () => ({
      events: [{
        eventId: "trace-event-1",
        eventType: "agent.delegate.trace.updated",
        sessionKey: "WebSocket:chat-1",
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
            parentSessionKey: "WebSocket:chat-1",
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
          items: [{ key: "WebSocket:chat-1", chat_id: "chat-1", title: "Spawn", updated_at: "2026-06-28T04:00:00Z" }],
        })),
        loadMessages: vi.fn(async () => ({
          messages: [{ role: "user", content: "spawn a subagent", message_id: "m-user" }],
        })),
        listTraceEvents,
      },
      sendSocketMessage: (message) => sent.push(message),
    });

    await controller.loadSessions();

    expect(listTraceEvents).toHaveBeenCalledWith({ sessionKey: "WebSocket:chat-1" });
    const toolActivities = [...(controller.state.messages.get("WebSocket:chat-1") ?? [])]
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
      sessionKey: "WebSocket:chat-1",
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
      sessionKey: "WebSocket:chat-1",
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

  test("deletes the active session, refreshes gateway sessions, and selects the next chat", async () => {
    const sent: unknown[] = [];
    const deleted: string[] = [];
    let sessions = [
      { key: "WebSocket:chat-1", chat_id: "chat-1", title: "First chat" },
      { key: "WebSocket:chat-2", chat_id: "chat-2", title: "Second chat" },
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

    await expect(controller.deleteSession("WebSocket:chat-1")).resolves.toEqual({
      status: "deleted",
      deletedSessionKey: "WebSocket:chat-1",
      nextSessionKey: "WebSocket:chat-2",
    });

    expect(deleted).toEqual(["WebSocket:chat-1"]);
    expect(controller.state.sessions.map((session) => session.key)).toEqual(["WebSocket:chat-2"]);
    expect(controller.state.activeSessionKey).toBe("WebSocket:chat-2");
    expect(controller.state.activeChatId).toBe("chat-2");
    expect(controller.state.messages.has("WebSocket:chat-1")).toBe(false);
    expect(controller.state.messages.get("WebSocket:chat-2")).toMatchObject([{ content: "loaded WebSocket:chat-2" }]);
    expect(sent).toEqual([
      { type: "attach", chat_id: "chat-1" },
      { type: "attach", chat_id: "chat-2" },
    ]);
  });

  test("retries session deletion with the gateway WebSocket key when the visible key is bare", async () => {
    const deleted: string[] = [];
    let sessions = [
      { key: "5225ad1670a7", chat_id: "5225ad1670a7", title: "New session" },
      { key: "WebSocket:f9387efaabab", chat_id: "f9387efaabab", title: "Next session" },
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
      nextSessionKey: "WebSocket:f9387efaabab",
    });

    expect(deleted).toEqual(["5225ad1670a7", "WebSocket:5225ad1670a7"]);
    expect(controller.state.sessions.map((session) => session.key)).toEqual(["WebSocket:f9387efaabab"]);
    expect(controller.state.activeSessionKey).toBe("WebSocket:f9387efaabab");
  });

  test("patches session metadata and refreshes the local session list", async () => {
    const patched: unknown[] = [];
    let sessions = [
      { key: "WebSocket:chat-1", chat_id: "chat-1", title: "First chat", metadata: { pinned: false } },
    ];
    const controller = createDesktopChatSessionController({
      api: {
        listSessions: vi.fn(async () => ({ items: sessions })),
        loadMessages: vi.fn(async () => ({ messages: [] })),
        patchSession: vi.fn(async (sessionKey: string, body: unknown) => {
          patched.push({ body, sessionKey });
          sessions = [
            { key: "WebSocket:chat-1", chat_id: "chat-1", title: "Renamed chat", metadata: { pinned: true } },
          ];
          return { key: sessionKey };
        }),
      },
      sendSocketMessage: vi.fn(),
    });

    await controller.loadSessions();

    await expect(controller.patchSession("WebSocket:chat-1", { metadata: { pinned: true, title: "Renamed chat" } })).resolves.toBe(true);

    expect(patched).toEqual([{
      body: { metadata: { pinned: true, title: "Renamed chat" } },
      sessionKey: "WebSocket:chat-1",
    }]);
    expect(controller.state.sessions[0]).toMatchObject({
      pinned: true,
      title: "Renamed chat",
    });
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

  test("keeps a new chat in recent sessions when the gateway list has not persisted it yet", async () => {
    const sent: unknown[] = [];
    const controller = createDesktopChatSessionController({
      api: {
        listSessions: vi.fn(async () => ({ items: [] })),
        loadMessages: vi.fn(async () => ({ messages: [] })),
      },
      sendSocketMessage: (message) => sent.push(message),
      now: () => "2026-06-22T05:30:00.000Z",
    });

    expect(controller.submitMessage("  live question  ")).toEqual({
      status: "creating",
      pendingContent: "live question",
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
        title: "live question",
      },
    ]);
    expect(controller.state.messages.get(sessionKeyForChat("chat-live"))).toMatchObject([
      { role: "user", content: "live question" },
    ]);
    expect(sent).toEqual([
      { type: "new_chat" },
      { type: "message", chat_id: "chat-live", content: "live question", use_persistent_rag: true },
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
          items: [{ key: "WebSocket:chat-old", chat_id: "chat-old", title: "Older chat" }],
        })),
        loadMessages,
      },
      sendSocketMessage: (message) => sent.push(message),
    });

    await controller.loadSessions();
    controller.startNewChat();
    await controller.handleGatewayEvent({ kind: "chat.created", chatId: "chat-live", raw: {} });
    await controller.selectSession("WebSocket:chat-old", "chat-old");

    await expect(controller.selectSession(sessionKeyForChat("chat-live"), "chat-live")).resolves.toBeUndefined();

    expect(controller.state.activeSessionKey).toBe(sessionKeyForChat("chat-live"));
    expect(controller.state.activeChatId).toBe("chat-live");
    expect(controller.state.messages.get(sessionKeyForChat("chat-live"))).toEqual([]);
    expect(controller.state.error).toContain("Gateway bootstrap failed: Failed to fetch");
    expect(sent).toEqual([
      { type: "attach", chat_id: "chat-old" },
      { type: "new_chat" },
      { type: "attach", chat_id: "chat-old" },
      { type: "attach", chat_id: "chat-live" },
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
