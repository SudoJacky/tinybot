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
              content: "Use uv for Python commands.",
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
        detail: "Use uv for Python commands.",
        sourcePath: "memory/notes.jsonl",
        sourceLine: 4,
        sourceText: "Use uv for Python commands.",
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
              content: "Use uv for Python commands.",
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
      detail: "Use uv for Python commands.",
      sourcePath: "memory/MEMORY.md",
      sourceLine: 18,
      sourceText: "Use uv for Python commands.",
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
        session_key: "WebSocket:chat-1",
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
        session_key: "WebSocket:chat-1",
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
                id: "call-python",
                state: "failed",
                function: { name: "python", arguments: "raise SystemExit(1)" },
              },
            ],
            tool_results: [
              {
                tool_call_id: "call-python",
                name: "python",
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
        id: "call-python",
        name: "python",
        argsText: "raise SystemExit(1)",
        responseText: "Exit code 1",
        kind: "result",
        status: "failed",
      },
    ]);
  });
});
