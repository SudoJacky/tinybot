import { describe, expect, test } from "vitest";
import {
  activateChat,
  applyChatEvent,
  appendUserMessage,
  createNativeChatState,
  hydrateDelegatedRunsFromTraceEvents,
  normalizeMessagesPayload,
  normalizeSessionsPayload,
  resolveNativeChatApproval,
  setMessages,
  setSessions,
  sessionKeyForChat,
} from "./nativeChat";

describe("native chat state", () => {
  test("normalizes gateway sessions and messages without changing existing shapes", () => {
    expect(
      normalizeSessionsPayload({
        items: [
          {
            key: "websocket:chat-1",
            chat_id: "chat-1",
            title: "Existing session",
            created_at: "2026-05-29T08:00:00Z",
            updated_at: "2026-05-29T08:01:00Z",
          },
        ],
      }),
    ).toEqual([
      {
        key: "websocket:chat-1",
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
            tool_calls: [{
              id: "call-read",
              function: { name: "read_file", arguments: "{\"path\":\"docs/desktop.md\"}" },
            }],
            tool_results: [{ tool_call_id: "call-read", content: "file contents" }],
            browser_references: [{ title: "Browser snapshot", url: "https://example.com" }],
            memory_references: [{ id: "mem-1", summary: "Remembered setting" }],
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
        toolActivities: [
          {
            id: "call-read",
            name: "read_file",
            argsText: "{\"path\":\"docs/desktop.md\"}",
            responseText: "file contents",
            kind: "result",
            status: "completed",
          },
        ],
        references: [
          { kind: "browser", title: "Browser snapshot", detail: "https://example.com" },
          { kind: "memory", title: "mem-1", detail: "Remembered setting" },
        ],
        timestamp: "2026-05-29T08:00:01Z",
        messageId: "m-assistant",
      },
    ]);
  });

  test("canonicalizes legacy WebSocket session keys to the native backend key", () => {
    expect(
      normalizeSessionsPayload({
        items: [
          {
            key: "WebSocket:chat-legacy",
            chat_id: "chat-legacy",
            title: "Legacy session",
          },
        ],
      })[0],
    ).toMatchObject({
      key: "websocket:chat-legacy",
      chatId: "chat-legacy",
    });

    const state = createNativeChatState();
    state.messages.set("WebSocket:chat-legacy", [{
      role: "user",
      content: "kept message",
      reasoningContent: "",
      timestamp: "2026-07-05T10:00:00.000Z",
      messageId: "legacy-user",
    }]);

    setSessions(state, [{
      key: "WebSocket:chat-legacy",
      chatId: "chat-legacy",
      title: "Legacy session",
      createdAt: "",
      updatedAt: "",
    }]);

    expect(state.sessions[0].key).toBe("websocket:chat-legacy");
    expect(state.messages.has("WebSocket:chat-legacy")).toBe(false);
    expect(state.messages.get("websocket:chat-legacy")).toMatchObject([{ content: "kept message" }]);
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

  test("normalizes backend memory and recent context references from persisted messages", () => {
    expect(
      normalizeMessagesPayload({
        messages: [
          {
            role: "assistant",
            content: "Memory-backed answer",
            _memory_references: [{
              note_id: "note_1",
              content: "Use workspace command policies.",
              file: "memory/notes.jsonl",
              line: 4,
            }],
            _recent_context_references: [{
              evidence_id: "ev_1",
              excerpt: "Earlier turn mentioned native chat references.",
              file: "memory/conversations/2026-06-08.jsonl",
              line: 12,
            }],
            timestamp: "2026-06-08T08:00:01Z",
            message_id: "m-memory",
          },
        ],
      })[0].references,
    ).toEqual([
      {
        kind: "memory",
        title: "note_1",
        detail: "Use workspace command policies.",
        sourcePath: "memory/notes.jsonl",
        sourceLine: 4,
        sourceText: "Use workspace command policies.",
        noteId: "note_1",
      },
      {
        kind: "recent",
        title: "ev_1",
        detail: "Earlier turn mentioned native chat references.",
        sourcePath: "memory/conversations/2026-06-08.jsonl",
        sourceLine: 12,
        sourceText: "Earlier turn mentioned native chat references.",
        evidenceId: "ev_1",
      },
    ]);
  });

  test("normalizes persisted TS worker camelCase tool history into native tool activities", () => {
    expect(
      normalizeMessagesPayload({
        messages: [
          {
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "call-read",
                name: "read_file",
                argumentsJson: "{\"path\":\"README.md\"}",
              },
            ],
            timestamp: "2026-05-29T08:00:01Z",
            message_id: "m-tool-call",
          },
          {
            role: "tool",
            content: "README contents",
            toolCallId: "call-read",
            name: "read_file",
            timestamp: "2026-05-29T08:00:02Z",
            message_id: "m-tool-result",
          },
        ],
      }),
    ).toEqual([
      {
        role: "assistant",
        content: "",
        reasoningContent: "",
        toolActivities: [
          {
            id: "call-read",
            name: "read_file",
            argsText: "{\"path\":\"README.md\"}",
            responseText: "README contents",
            kind: "result",
            status: "completed",
          },
        ],
        timestamp: "2026-05-29T08:00:01Z",
        messageId: "m-tool-call",
      },
    ]);
  });

  test("preserves memory reference source location and original excerpt metadata", () => {
    expect(
      normalizeMessagesPayload({
        messages: [
          {
            role: "assistant",
            content: "Memory-backed answer",
            _memory_references: [{
              note_id: "note_1",
              content: "Use workspace command policies.",
              file: "memory/notes.jsonl",
              line: 4,
              view_file: "memory/MEMORY.md",
              view_line: 18,
              scope: "project",
              type: "instruction",
            }],
            timestamp: "2026-06-08T08:00:01Z",
            message_id: "m-memory-source",
          },
        ],
      })[0].references,
    ).toEqual([{
      kind: "memory",
      title: "note_1",
      detail: "Use workspace command policies.",
      sourcePath: "memory/MEMORY.md",
      sourceLine: 18,
      sourceText: "Use workspace command policies.",
      rawPath: "memory/notes.jsonl",
      rawLine: 4,
      noteId: "note_1",
      scope: "project",
      type: "instruction",
    }]);
  });

  test("attaches backend references from live completed and streamed messages", () => {
    const state = createNativeChatState();
    applyChatEvent(state, { kind: "attached", chatId: "chat-1", raw: {} });

    applyChatEvent(state, {
      kind: "message.completed",
      chatId: "chat-1",
      messageId: "m-complete",
      text: "Complete answer",
      raw: {
        _memory_references: [{ note_id: "note_complete", content: "Complete memory" }],
      },
    });
    applyChatEvent(state, {
      kind: "message.delta",
      chatId: "chat-1",
      messageId: "m-stream",
      text: "Streamed answer",
      reasoning: false,
      raw: {},
    });
    applyChatEvent(state, {
      kind: "message.stream.completed",
      chatId: "chat-1",
      messageId: "m-stream",
      raw: {
        _recent_context_references: [{ evidence_id: "ev_stream", excerpt: "Stream context" }],
      },
    });

    expect(state.messages.get(sessionKeyForChat("chat-1"))).toMatchObject([
      {
        messageId: "m-complete",
        references: [{ kind: "memory", title: "note_complete", detail: "Complete memory" }],
      },
      {
        messageId: "m-stream",
        references: [{ kind: "recent", title: "ev_stream", detail: "Stream context" }],
      },
    ]);
  });

  test("does not append a completed message for a stream message with the same id", () => {
    const state = createNativeChatState();
    applyChatEvent(state, { kind: "attached", chatId: "chat-1", raw: {} });

    applyChatEvent(state, {
      kind: "message.delta",
      chatId: "chat-1",
      messageId: "m-stream",
      text: "Streamed answer",
      reasoning: false,
      raw: {},
    });
    applyChatEvent(state, {
      kind: "message.completed",
      chatId: "chat-1",
      messageId: "m-stream",
      text: "Streamed answer",
      raw: {
        _memory_references: [{ note_id: "note_stream", content: "Stream memory" }],
      },
    });

    expect(state.messages.get(sessionKeyForChat("chat-1"))).toMatchObject([
      {
        content: "Streamed answer",
        messageId: "m-stream",
        references: [{ kind: "memory", title: "note_stream", detail: "Stream memory" }],
      },
    ]);
    expect(state.messages.get(sessionKeyForChat("chat-1"))).toHaveLength(1);
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

  test("normalizes standalone tool result messages into native tool activities", () => {
    expect(
      normalizeMessagesPayload({
        messages: [
          {
            role: "tool",
            name: "shell",
            tool_call_id: "call-shell",
            content: "stdout: done",
            timestamp: "2026-05-29T08:00:02Z",
            message_id: "tool-1",
          },
        ],
      }),
    ).toEqual([
      {
        role: "tool",
        content: "stdout: done",
        reasoningContent: "",
        toolActivities: [
          {
            id: "call-shell",
            name: "shell",
            argsText: "",
            responseText: "stdout: done",
            kind: "result",
            status: "completed",
          },
        ],
        timestamp: "2026-05-29T08:00:02Z",
        messageId: "tool-1",
      },
    ]);
  });

  test("normalizes assistant tool detail metadata without rendering it as assistant text", () => {
    expect(
      normalizeMessagesPayload({
        messages: [
          {
            role: "assistant",
            content: "list_dir(path=\"C:\\\\Users\\\\12921\\\\tinybot\\\\workspace\\\\web-articles\")",
            _tool_hint: true,
            _tool_detail: true,
            _tool_name: "list_dir",
            timestamp: "2026-05-29T08:00:02Z",
            message_id: "tool-detail-1",
          },
        ],
      }),
    ).toEqual([
      {
        role: "assistant",
        content: "",
        reasoningContent: "",
        toolActivities: [
          {
            id: "tool-detail-1",
            name: "list_dir",
            argsText: "list_dir(path=\"C:\\\\Users\\\\12921\\\\tinybot\\\\workspace\\\\web-articles\")",
            responseText: "",
            kind: "call",
            status: "running",
          },
        ],
        timestamp: "2026-05-29T08:00:02Z",
        messageId: "tool-detail-1",
      },
    ]);
  });

  test("coalesces persisted tool status messages with the same tool call id", () => {
    expect(
      normalizeMessagesPayload({
        messages: [
          {
            role: "assistant",
            content: "search_memory_notes(query=\"financial banking\")",
            _tool_hint: true,
            _tool_detail: true,
            _tool_call_id: "call-search-memory",
            _tool_name: "search_memory_notes",
            status: "running",
            timestamp: "2026-05-29T08:00:02Z",
            message_id: "tool-running-1",
          },
          {
            role: "assistant",
            content: "[{\"summary\":\"User follows AI impact on financial banking.\"}]",
            _tool_result: true,
            tool_call_id: "call-search-memory",
            _tool_name: "search_memory_notes",
            status: "completed",
            timestamp: "2026-05-29T08:00:03Z",
            message_id: "tool-completed-1",
          },
        ],
      }),
    ).toEqual([
      {
        role: "assistant",
        content: "",
        reasoningContent: "",
        toolActivities: [
          {
            id: "call-search-memory",
            name: "search_memory_notes",
            argsText: "search_memory_notes(query=\"financial banking\")",
            responseText: "[{\"summary\":\"User follows AI impact on financial banking.\"}]",
            kind: "result",
            status: "completed",
          },
        ],
        timestamp: "2026-05-29T08:00:02Z",
        messageId: "tool-running-1",
      },
    ]);
  });

  test("routes live tool hint messages into tool activities instead of assistant body text", () => {
    const state = createNativeChatState();
    applyChatEvent(state, { kind: "attached", chatId: "chat-1", raw: {} });

    applyChatEvent(state, {
      kind: "message.completed",
      chatId: "chat-1",
      messageId: "tool-detail-1",
      text: "list_dir(path=\"C:\\\\Users\\\\12921\\\\tinybot\\\\workspace\\\\web-articles\")",
      raw: {
        _tool_hint: true,
        _tool_detail: true,
        _tool_name: "list_dir",
      },
    });

    expect(state.messages.get(sessionKeyForChat("chat-1"))).toMatchObject([
      {
        role: "assistant",
        content: "",
        messageId: "tool-detail-1",
        toolActivities: [
          {
            id: "tool-detail-1",
            name: "list_dir",
            argsText: "list_dir(path=\"C:\\\\Users\\\\12921\\\\tinybot\\\\workspace\\\\web-articles\")",
            responseText: "",
            kind: "call",
            status: "running",
          },
        ],
      },
    ]);
  });

  test("updates live tool activity status instead of appending duplicate tool messages", () => {
    const state = createNativeChatState();
    applyChatEvent(state, { kind: "attached", chatId: "chat-1", raw: {} });

    applyChatEvent(state, {
      kind: "message.completed",
      chatId: "chat-1",
      messageId: "tool-running-1",
      text: "search_memory_notes(query=\"financial banking\")",
      raw: {
        _tool_hint: true,
        _tool_detail: true,
        _tool_call_id: "call-search-memory",
        _tool_name: "search_memory_notes",
        status: "running",
      },
    });
    applyChatEvent(state, {
      kind: "message.completed",
      chatId: "chat-1",
      messageId: "tool-completed-1",
      text: "[{\"summary\":\"User follows AI impact on financial banking.\"}]",
      raw: {
        _tool_result: true,
        tool_call_id: "call-search-memory",
        _tool_name: "search_memory_notes",
        status: "completed",
      },
    });

    expect(state.messages.get(sessionKeyForChat("chat-1"))).toMatchObject([
      {
        role: "assistant",
        content: "",
        messageId: "tool-running-1",
        toolActivities: [
          {
            id: "call-search-memory",
            name: "search_memory_notes",
            argsText: "search_memory_notes(query=\"financial banking\")",
            responseText: "[{\"summary\":\"User follows AI impact on financial banking.\"}]",
            kind: "result",
            status: "completed",
          },
        ],
      },
    ]);
    expect(state.messages.get(sessionKeyForChat("chat-1"))).toHaveLength(1);
  });

  test("keeps late live tool events before the streamed final answer", () => {
    const state = createNativeChatState();
    applyChatEvent(state, { kind: "attached", chatId: "chat-1", raw: {} });
    applyChatEvent(state, {
      kind: "message.delta",
      chatId: "chat-1",
      messageId: "answer-1",
      text: "The workspace contains apps and docs.",
      reasoning: false,
      raw: {},
    });
    applyChatEvent(state, {
      kind: "message.completed",
      chatId: "chat-1",
      messageId: "tool-list-1",
      text: "AGENTS.md\napps/\ndocs/",
      raw: {
        _tool_result: true,
        tool_call_id: "call-list",
        _tool_name: "list_dir",
        status: "completed",
      },
    });

    expect(state.messages.get(sessionKeyForChat("chat-1"))).toMatchObject([
      {
        role: "assistant",
        content: "",
        messageId: "tool-list-1",
        toolActivities: [
          {
            id: "call-list",
            name: "list_dir",
            responseText: "AGENTS.md\napps/\ndocs/",
            status: "completed",
          },
        ],
      },
      {
        role: "assistant",
        content: "The workspace contains apps and docs.",
        messageId: "answer-1",
      },
    ]);
  });

  test("projects structured agent events through the native chat message timeline", () => {
    const state = createNativeChatState();
    applyChatEvent(state, { kind: "attached", chatId: "chat-1", raw: {} });
    appendUserMessage(state, "Inspect files", "2026-06-27T04:00:00.000Z");

    applyChatEvent(state, {
      kind: "agent.event",
      chatId: "chat-1",
      raw: {
        event: "agent_event",
        schema_version: "tinybot.agent_event.v1",
        event_id: "event-tool-start",
        event_type: "tool.call.started",
        chat_id: "chat-1",
        session_key: "websocket:chat-1",
        turn_id: "turn-1",
        step_id: "step-tool",
        sequence: 2,
        created_at: "2026-06-27T04:00:01.000Z",
        payload: {
          args_preview: "{\"path\":\".\"}",
          name: "list_dir",
          status: "running",
          tool_call_id: "call-list",
        },
      },
    });
    applyChatEvent(state, {
      kind: "agent.event",
      chatId: "chat-1",
      raw: {
        event: "agent_event",
        schema_version: "tinybot.agent_event.v1",
        event_id: "event-final",
        event_type: "message.completed",
        chat_id: "chat-1",
        session_key: "websocket:chat-1",
        turn_id: "turn-1",
        step_id: "step-final",
        sequence: 3,
        created_at: "2026-06-27T04:00:02.000Z",
        payload: {
          message_id: "assistant-final",
          text: "Files inspected.",
        },
      },
    });

    expect(state.messages.get(sessionKeyForChat("chat-1"))).toMatchObject([
      { role: "user", content: "Inspect files" },
      {
        role: "assistant",
        content: "",
        toolActivities: [{
          id: "call-list",
          name: "list_dir",
          argsText: "{\"path\":\".\"}",
          status: "running",
        }],
      },
      { role: "assistant", content: "Files inspected." },
    ]);
    expect(state.respondingSessionKeys.has(sessionKeyForChat("chat-1"))).toBe(false);
  });

  test("marks live structured message deltas as non-final while the turn is running", () => {
    const state = createNativeChatState();
    applyChatEvent(state, { kind: "attached", chatId: "chat-1", raw: {} });
    applyChatEvent(state, {
      kind: "agent.event",
      chatId: "chat-1",
      raw: {
        event: "agent_event",
        schema_version: "tinybot.agent_event.v1",
        event_id: "event-turn-start",
        event_type: "agent.turn.started",
        chat_id: "chat-1",
        session_key: "websocket:chat-1",
        turn_id: "turn-1",
        sequence: 1,
        created_at: "2026-06-27T04:00:00.000Z",
        payload: {
          user_message: { id: "user-1", role: "user", text: "Use subagent" },
          user_message_id: "user-1",
        },
      },
    });
    applyChatEvent(state, {
      kind: "agent.event",
      chatId: "chat-1",
      raw: {
        event: "agent_event",
        schema_version: "tinybot.agent_event.v1",
        event_id: "event-delta",
        event_type: "message.delta",
        chat_id: "chat-1",
        session_key: "websocket:chat-1",
        turn_id: "turn-1",
        sequence: 2,
        created_at: "2026-06-27T04:00:01.000Z",
        payload: {
          message_id: "assistant-stream",
          text: "working with a child agent",
        },
      },
    });

    expect(state.messages.get(sessionKeyForChat("chat-1"))).toMatchObject([
      { role: "user", content: "Use subagent" },
      {
        role: "assistant",
        content: "working with a child agent",
        copyable: false,
      },
    ]);
  });

  test("normalizes tool activity execution status for timeline rendering", () => {
    expect(
      normalizeMessagesPayload({
        messages: [
          {
            role: "assistant",
            content: "running tools",
            tool_calls: [
              {
                id: "call-shell",
                _approval_id: "approval-1",
                status: "running",
                function: { name: "shell", arguments: "npm test" },
              },
              {
                id: "call-node",
                state: "failed",
                function: { name: "node", arguments: "raise SystemExit(1)" },
              },
            ],
            tool_results: [
              {
                tool_call_id: "call-node",
                name: "node",
                status: "failed",
                content: "Exit code 1",
              },
            ],
            timestamp: "2026-05-29T08:00:03Z",
            message_id: "m-tools",
          },
        ],
      })[0].toolActivities,
    ).toEqual([
      {
        id: "call-shell",
        name: "shell",
        argsText: "npm test",
        responseText: "",
        kind: "call",
        approvalId: "approval-1",
        status: "running",
      },
      {
        id: "call-node",
        name: "node",
        argsText: "raise SystemExit(1)",
        responseText: "Exit code 1",
        kind: "result",
        status: "failed",
      },
    ]);
  });

  test("restores awaiting approval tool results from persisted metadata", () => {
    expect(
      normalizeMessagesPayload({
        messages: [
          {
            role: "tool",
            content: "Waiting for approval.",
            tool_call_id: "call-spawn",
            name: "spawn",
            metadata: {
              approvalId: "approval-1",
              awaitingUserInput: true,
              stopReason: "awaiting_approval",
            },
            timestamp: "2026-06-27T04:00:03Z",
            message_id: "tool-approval",
          },
        ],
      })[0].toolActivities,
    ).toEqual([{
      id: "call-spawn",
      name: "spawn",
      argsText: "",
      responseText: "Waiting for approval.",
      kind: "result",
      approvalId: "approval-1",
      approvalStatus: "approval_required",
      status: "blocked",
    }]);
  });

  test("restores pending delegated approvals from persisted delegated metadata", () => {
    const messages = normalizeMessagesPayload({
      messages: [
        {
          role: "tool",
          content: "Waiting for approval.",
          tool_call_id: "call-spawn",
          name: "spawn",
          approvalId: "approval-1",
          awaitingUserInput: true,
          stopReason: "awaiting_approval",
          _delegate_event: true,
          _delegate_id: "delegate-1",
          _delegate_status: "awaiting_approval",
          _delegate_task: "请用中文说一句\"你好\"",
          timestamp: "2026-06-27T04:00:03Z",
          message_id: "tool-approval",
        },
      ],
    });

    expect(messages[0].toolActivities).toEqual([expect.objectContaining({
      id: "call-spawn",
      name: "spawn",
      responseText: "Waiting for approval.",
      kind: "result",
      approvalId: "approval-1",
      approvalStatus: "approval_required",
      status: "blocked",
    })]);
    expect(messages[0].toolActivities?.[0]?.argsText).toContain("请用中文说一句");
  });

  test("restores completed delegated results without losing delegated task details", () => {
    const messages = normalizeMessagesPayload({
      messages: [
        {
          role: "tool",
          content: "child final result",
          tool_call_id: "call-spawn",
          name: "spawn",
          _delegate_event: true,
          _delegate_id: "delegate-1",
          _delegate_result: { summary: "你好", status: "completed" },
          _delegate_status: "completed",
          _delegate_task: "请用中文说一句\"你好\"",
          _delegate_trace: {
            steps: [{
              id: "tool:call-1:completed",
              kind: "tool_call",
              status: "completed",
              title: "say",
              resultPreview: "child said hello",
            }],
          },
          timestamp: "2026-06-27T04:00:04Z",
          message_id: "tool-delegate",
        },
      ],
    });

    expect(messages[0].toolActivities).toEqual([expect.objectContaining({
      id: "call-spawn",
      name: "spawn",
      responseText: "child final result",
      kind: "result",
      status: "completed",
    })]);
    expect(messages[0].toolActivities?.[0]?.argsText).toContain("请用中文说一句");
    expect(messages[0].toolActivities?.[0]?.argsText).toContain("Spawned agent workflow");
    expect(messages[0].toolActivities?.[0]?.argsText).toContain("tool:call-1:completed");
  });

  test("hydrates delegated trace snapshots into chat run state when messages reload", () => {
    const state = createNativeChatState();
    const messages = normalizeMessagesPayload({
      messages: [
        {
          role: "user",
          content: "Spawn a subagent",
          timestamp: "2026-06-27T04:00:00Z",
          message_id: "user-1",
        },
        {
          role: "tool",
          content: "child final result",
          tool_call_id: "call-spawn",
          name: "spawn",
          _delegate_event: true,
          _delegate_id: "delegate-1",
          _delegate_label: "Greeter",
          _delegate_status: "completed",
          _delegate_task: "Say hello",
          _delegate_trace_ref: "trace-delegate-1",
          _delegate_result: { summary: "hello", status: "completed" },
          _delegate_trace: {
            delegateId: "delegate-1",
            childRunId: "delegate-1",
            parentRunId: "run-1",
            parentSessionKey: "websocket:chat-1",
            status: "completed",
            steps: [{
              id: "message:delegate-1",
              kind: "message",
              status: "completed",
              title: "Assistant message",
              summary: "hello",
              createdAt: "2026-06-27T04:00:01Z",
              updatedAt: "2026-06-27T04:00:01Z",
            }],
            approvals: [],
            artifacts: [],
            updatedAt: "2026-06-27T04:00:01Z",
          },
          timestamp: "2026-06-27T04:00:02Z",
          message_id: "tool-delegate",
        },
      ],
    });

    setMessages(state, "websocket:chat-1", messages);

    const delegate = state.chatRuns.delegatedRunsBySession.get("websocket:chat-1")?.get("delegate-1");
    expect(delegate).toMatchObject({
      id: "delegate-1",
      title: "Greeter",
      task: "Say hello",
      status: "completed",
      traceRef: "trace-delegate-1",
      trace: {
        steps: [expect.objectContaining({
          id: "message:delegate-1",
          summary: "hello",
        })],
      },
    });
  });

  test("hydrates child trace journal events into delegated run traces", () => {
    const state = createNativeChatState();
    const sessionKey = "websocket:chat-1";
    setMessages(state, sessionKey, normalizeMessagesPayload({
      messages: [
        {
          role: "user",
          content: "Use a subagent",
          timestamp: "2026-06-27T04:00:00Z",
          message_id: "user-1",
        },
      ],
    }));

    hydrateDelegatedRunsFromTraceEvents(state, sessionKey, [
      {
        eventId: "delegate-1:1:agent.delegate.started",
        eventType: "agent.delegate.started",
        sessionKey,
        turnId: "turn-1",
        stepId: "delegate-1",
        traceRef: "trace-delegate-1",
        sequence: 1,
        createdAt: "2026-06-27T04:00:01Z",
        payload: {
          child_run_id: "delegate-1",
          delegate_id: "delegate-1",
          status: "running",
          task: "Say hello",
          title: "Greeter",
          trace_ref: "trace-delegate-1",
        },
      },
      {
        eventId: "delegate-1:2:child.message.completed:final:delegate-1",
        eventType: "child.message.completed",
        sessionKey,
        turnId: "turn-1",
        stepId: "delegate-1",
        traceRef: "trace-delegate-1",
        sequence: 2,
        createdAt: "2026-06-27T04:00:02Z",
        payload: {
          child_run_id: "delegate-1",
          child_step_id: "final:delegate-1",
          delegate_id: "delegate-1",
          status: "completed",
          summary: "hello from child",
          trace_ref: "trace-delegate-1",
          step: {
            id: "final:delegate-1",
            kind: "message",
            status: "completed",
            title: "Final answer",
            summary: "hello from child",
            resultPreview: "hello from child",
            createdAt: "2026-06-27T04:00:02Z",
            updatedAt: "2026-06-27T04:00:02Z",
          },
        },
      },
    ]);

    const delegate = state.chatRuns.delegatedRunsBySession.get(sessionKey)?.get("delegate-1");
    expect(delegate).toMatchObject({
      id: "delegate-1",
      trace: {
        steps: [expect.objectContaining({
          id: "final:delegate-1",
          kind: "message",
          status: "completed",
          summary: "hello from child",
        })],
      },
    });
    const toolActivities = (state.messages.get(sessionKey) ?? []).flatMap((message) => message.toolActivities ?? []);
    expect(toolActivities).toContainEqual(expect.objectContaining({
      delegateId: "delegate-1",
      delegatedTrace: expect.objectContaining({
        steps: [expect.objectContaining({
          id: "final:delegate-1",
          summary: "hello from child",
        })],
      }),
    }));
  });

  test("merges pending approval tool result messages into the latest running tool by name", () => {
    const state = createNativeChatState();
    activateChat(state, "chat-1");
    appendUserMessage(state, "Use subagent");

    applyChatEvent(state, {
      kind: "message.completed",
      chatId: "chat-1",
      messageId: "run-1:call-spawn:start",
      text: "spawn({\"task\":\"say hi\"})",
      raw: {
        event: "agent.tool.start",
        chat_id: "chat-1",
        content: "spawn({\"task\":\"say hi\"})",
        message_id: "run-1:call-spawn:start",
        status: "running",
        _tool_call_id: "call-spawn",
        _tool_detail: true,
        _tool_hint: true,
        _tool_name: "spawn",
      },
    });
    applyChatEvent(state, {
      kind: "message.completed",
      chatId: "chat-1",
      messageId: "run-1:approval-1:approval",
      text: "Waiting for approval.",
      raw: {
        event: "agent.awaiting_approval",
        chat_id: "chat-1",
        content: "Waiting for approval.",
        message_id: "run-1:approval-1:approval",
        status: "blocked",
        _approval_id: "approval-1",
        _approval_status: "approval_required",
        _tool_call_id: "approval-1",
        _tool_name: "spawn",
        _tool_result: true,
      },
    });

    const assistantMessages = state.messages.get(sessionKeyForChat("chat-1"))?.filter((message) => message.role === "assistant") ?? [];
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0].toolActivities).toEqual([{
      id: "call-spawn",
      name: "spawn",
      argsText: "spawn({\"task\":\"say hi\"})",
      responseText: "Waiting for approval.",
      kind: "result",
      approvalId: "approval-1",
      approvalStatus: "approval_required",
      status: "blocked",
    }]);
  });

  test("merges approval requests into the matching tool activity", () => {
    const state = createNativeChatState();
    activateChat(state, "chat-1");
    appendUserMessage(state, "Use subagent");

    applyChatEvent(state, {
      kind: "agent.event",
      chatId: "chat-1",
      raw: {
        event: "agent_event",
        schema_version: "tinybot.agent_event.v1",
        event_id: "event-tool-start",
        event_type: "tool.call.started",
        chat_id: "chat-1",
        session_key: "websocket:chat-1",
        turn_id: "turn-1",
        step_id: "turn-1:call-spawn",
        sequence: 2,
        created_at: "2026-06-27T04:00:01.000Z",
        payload: {
          args_preview: "spawn({\"task\":\"say hi\"})",
          name: "spawn",
          status: "running",
          tool_call_id: "call-spawn",
        },
      },
    });
    applyChatEvent(state, {
      kind: "agent.event",
      chatId: "chat-1",
      raw: {
        event: "agent_event",
        schema_version: "tinybot.agent_event.v1",
        event_id: "event-approval",
        event_type: "approval.requested",
        chat_id: "chat-1",
        session_key: "websocket:chat-1",
        turn_id: "turn-1",
        step_id: "turn-1:approval:approval-1",
        sequence: 3,
        created_at: "2026-06-27T04:00:02.000Z",
        payload: {
          approval_id: "approval-1",
          approval_status: "approval_required",
          args_preview: "spawn({\"task\":\"say hi\"})",
          title: "Approval required",
          tool_call_id: "call-spawn",
        },
      },
    });

    const assistantMessages = state.messages.get(sessionKeyForChat("chat-1"))?.filter((message) => message.role === "assistant") ?? [];
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0].toolActivities).toEqual([{
      id: "call-spawn",
      name: "spawn",
      argsText: "spawn({\"task\":\"say hi\"})",
      responseText: "",
      kind: "call",
      approvalId: "approval-1",
      approvalStatus: "approval_required",
      status: "blocked",
    }]);
  });

  test("marks pending approval tool activities as resolved locally", () => {
    const state = createNativeChatState();
    activateChat(state, "chat-1");
    appendUserMessage(state, "Use subagent");

    applyChatEvent(state, {
      kind: "agent.event",
      chatId: "chat-1",
      raw: {
        event: "agent_event",
        schema_version: "tinybot.agent_event.v1",
        event_id: "event-tool-start",
        event_type: "tool.call.started",
        chat_id: "chat-1",
        session_key: "websocket:chat-1",
        turn_id: "turn-1",
        step_id: "turn-1:call-spawn",
        sequence: 2,
        created_at: "2026-06-27T04:00:01.000Z",
        payload: {
          args_preview: "spawn({\"task\":\"say hi\"})",
          name: "spawn",
          status: "running",
          tool_call_id: "call-spawn",
        },
      },
    });
    applyChatEvent(state, {
      kind: "agent.event",
      chatId: "chat-1",
      raw: {
        event: "agent_event",
        schema_version: "tinybot.agent_event.v1",
        event_id: "event-approval",
        event_type: "approval.requested",
        chat_id: "chat-1",
        session_key: "websocket:chat-1",
        turn_id: "turn-1",
        step_id: "turn-1:approval:approval-1",
        sequence: 3,
        created_at: "2026-06-27T04:00:02.000Z",
        payload: {
          approval_id: "approval-1",
          approval_status: "approval_required",
          title: "Approval required",
          tool_call_id: "call-spawn",
        },
      },
    });

    expect(resolveNativeChatApproval(state, {
      approvalId: "approval-1",
      decision: "approved",
      sessionKey: "websocket:chat-1",
    })).toBe(true);

    const assistantMessages = state.messages.get(sessionKeyForChat("chat-1"))?.filter((message) => message.role === "assistant") ?? [];
    expect(assistantMessages[0].toolActivities).toEqual([expect.objectContaining({
      approvalId: "approval-1",
      approvalStatus: "approved",
      id: "call-spawn",
      responseText: "Approved.",
      status: "completed",
    })]);
  });

  test("coalesces resolved approval activities with the original delegated tool call", () => {
    const state = createNativeChatState();
    activateChat(state, "chat-1");
    appendUserMessage(state, "Use subagent");

    applyChatEvent(state, {
      kind: "message.completed",
      chatId: "chat-1",
      messageId: "run-1:call-spawn:start",
      text: "spawn({\"task\":\"say hi\"})",
      raw: {
        event: "agent.tool.start",
        chat_id: "chat-1",
        content: "spawn({\"task\":\"say hi\"})",
        message_id: "run-1:call-spawn:start",
        status: "running",
        _tool_call_id: "call-spawn",
        _tool_detail: true,
        _tool_hint: true,
        _tool_name: "spawn",
      },
    });
    applyChatEvent(state, {
      kind: "message.completed",
      chatId: "chat-1",
      messageId: "run-1:approval:approval-1:result",
      text: "Waiting for approval.",
      raw: {
        event: "message",
        chat_id: "chat-1",
        content: "Waiting for approval.",
        message_id: "run-1:approval:approval-1:result",
        status: "blocked",
        _approval_id: "approval-1",
        _approval_status: "approval_required",
        _tool_call_id: "approval-1",
        _tool_name: "spawn",
        _tool_result: true,
      },
    });
    applyChatEvent(state, {
      kind: "agent.event",
      chatId: "chat-1",
      raw: {
        event: "agent_event",
        schema_version: "tinybot.agent_event.v1",
        event_id: "event-approval",
        event_type: "approval.requested",
        chat_id: "chat-1",
        session_key: "websocket:chat-1",
        turn_id: "run-1",
        step_id: "run-1:approval:approval-1",
        sequence: 3,
        created_at: "2026-06-27T04:00:02.000Z",
        payload: {
          approval_id: "approval-1",
          approval_status: "approval_required",
          args_preview: "",
          title: "Approval required",
          tool_call_id: "approval-1",
        },
      },
    });

    expect(resolveNativeChatApproval(state, {
      approvalId: "approval-1",
      decision: "approved",
      sessionKey: "websocket:chat-1",
    })).toBe(true);

    const toolActivities = (state.messages.get(sessionKeyForChat("chat-1")) ?? [])
      .flatMap((message) => message.toolActivities ?? []);
    expect(toolActivities).toHaveLength(1);
    expect(toolActivities[0]).toEqual(expect.objectContaining({
      approvalId: "approval-1",
      approvalStatus: "approved",
      argsText: "spawn({\"task\":\"say hi\"})",
      name: "spawn",
      responseText: "Approved.",
      status: "completed",
    }));
  });

  test("merges completed tool results into the locally approved delegated tool call", () => {
    const state = createNativeChatState();
    activateChat(state, "chat-1");
    appendUserMessage(state, "Use subagent");

    applyChatEvent(state, {
      kind: "message.completed",
      chatId: "chat-1",
      messageId: "run-1:call-spawn:start",
      text: "spawn({\"task\":\"say hi\"})",
      raw: {
        event: "agent.tool.start",
        chat_id: "chat-1",
        content: "spawn({\"task\":\"say hi\"})",
        message_id: "run-1:call-spawn:start",
        status: "running",
        _tool_call_id: "call-spawn",
        _tool_detail: true,
        _tool_hint: true,
        _tool_name: "spawn",
      },
    });
    applyChatEvent(state, {
      kind: "message.completed",
      chatId: "chat-1",
      messageId: "run-1:approval:approval-1:result",
      text: "Waiting for approval.",
      raw: {
        event: "message",
        chat_id: "chat-1",
        content: "Waiting for approval.",
        message_id: "run-1:approval:approval-1:result",
        status: "blocked",
        _approval_id: "approval-1",
        _approval_status: "approval_required",
        _tool_call_id: "approval-1",
        _tool_name: "spawn",
        _tool_result: true,
      },
    });

    expect(resolveNativeChatApproval(state, {
      approvalId: "approval-1",
      decision: "approved",
      sessionKey: "websocket:chat-1",
    })).toBe(true);
    applyChatEvent(state, {
      kind: "message.completed",
      chatId: "chat-1",
      messageId: "run-1:approval-1:completed",
      text: "你好",
      raw: {
        event: "message",
        chat_id: "chat-1",
        content: "你好",
        message_id: "run-1:approval-1:completed",
        status: "completed",
        _tool_call_id: "approval-1",
        _tool_name: "spawn",
        _tool_result: true,
      },
    });

    const toolActivities = (state.messages.get(sessionKeyForChat("chat-1")) ?? [])
      .flatMap((message) => message.toolActivities ?? []);
    expect(toolActivities).toHaveLength(1);
    expect(toolActivities[0]).toEqual(expect.objectContaining({
      approvalId: "approval-1",
      approvalStatus: "approved",
      argsText: "spawn({\"task\":\"say hi\"})",
      id: "call-spawn",
      name: "spawn",
      responseText: "你好",
      status: "completed",
    }));
  });
});
