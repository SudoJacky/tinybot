import { describe, expect, test } from "vitest";
import { NativeSessionBridge } from "./sessionBridge";

describe("NativeSessionBridge", () => {
  test("deletes a WebUI session through native session.delete", async () => {
    const requests: Array<{ traceId: string; method: string; params: Record<string, unknown> }> = [];
    const bridge = new NativeSessionBridge({
      request: async (traceId, method, params) => {
        requests.push({ traceId, method, params });
        return {
          session_id: "websocket:chat-1",
          deleted: true,
        };
      },
    });

    await expect((bridge as any).deleteSession("websocket:chat-1", "trace-webui")).resolves.toEqual({
      sessionId: "websocket:chat-1",
      deleted: true,
    });
    expect(requests).toEqual([
      {
        traceId: "trace-webui",
        method: "session.delete",
        params: { session_id: "websocket:chat-1" },
      },
    ]);
  });

  test("loads WebUI session messages through native session.get_metadata", async () => {
    const requests: Array<{ traceId: string; method: string; params: Record<string, unknown> }> = [];
    const bridge = new NativeSessionBridge({
      request: async (traceId, method, params) => {
        requests.push({ traceId, method, params });
        return {
          session_id: "websocket:chat-1",
          title: "Chat one",
          created_at: "2026-06-13T08:00:00.000Z",
          updated_at: "2026-06-13T09:00:00.000Z",
          extra: {
            messages: [
              { role: "user", content: "Hello", timestamp: "2026-06-13T08:00:00.000Z" },
            ],
          },
        };
      },
    });

    await expect((bridge as any).getWebuiSessionMessages("websocket:chat-1", "trace-webui")).resolves.toEqual({
      sessionId: "websocket:chat-1",
      messages: [{ role: "user", content: "Hello", timestamp: "2026-06-13T08:00:00.000Z" }],
    });
    expect(requests).toEqual([
      {
        traceId: "trace-webui",
        method: "session.get_metadata",
        params: { session_id: "websocket:chat-1" },
      },
    ]);
  });

  test("loads WebUI session profile through native session.get_metadata", async () => {
    const requests: Array<{ traceId: string; method: string; params: Record<string, unknown> }> = [];
    const bridge = new NativeSessionBridge({
      request: async (traceId, method, params) => {
        requests.push({ traceId, method, params });
        return {
          session_id: "websocket:chat-1",
          extra: {
            user_profile: { display_name: "Ada", role: "developer" },
          },
        };
      },
    });

    await expect((bridge as any).getWebuiSessionProfile("websocket:chat-1", "trace-webui")).resolves.toEqual({
      sessionId: "websocket:chat-1",
      profile: { display_name: "Ada", role: "developer" },
    });
    expect(requests).toEqual([
      {
        traceId: "trace-webui",
        method: "session.get_metadata",
        params: { session_id: "websocket:chat-1" },
      },
    ]);
  });

  test("patches WebUI session metadata through native session.patch_metadata", async () => {
    const requests: Array<{ traceId: string; method: string; params: Record<string, unknown> }> = [];
    const bridge = new NativeSessionBridge({
      request: async (traceId, method, params) => {
        requests.push({ traceId, method, params });
        return {
          session_id: "websocket:chat-1",
          updated_at: "2026-06-13T10:00:00.000Z",
          extra: {
            metadata: { pinned: true, topic: "native-route" },
          },
        };
      },
    });

    await expect((bridge as any).patchSessionMetadata(
      "websocket:chat-1",
      { pinned: true },
      "trace-webui",
    )).resolves.toEqual({
      sessionId: "websocket:chat-1",
      metadata: { pinned: true, topic: "native-route" },
      updatedAt: "2026-06-13T10:00:00.000Z",
    });
    expect(requests).toEqual([
      {
        traceId: "trace-webui",
        method: "session.patch_metadata",
        params: { session_id: "websocket:chat-1", metadata: { pinned: true } },
      },
    ]);
  });

  test("lists WebUI temporary files through native knowledge.session_list", async () => {
    const requests: Array<{ traceId: string; method: string; params: Record<string, unknown> }> = [];
    const bridge = new NativeSessionBridge({
      request: async (traceId, method, params) => {
        requests.push({ traceId, method, params });
        return {
          session_id: "websocket:chat-1",
          temporary_files: [
            {
              id: "tmp-1",
              name: "context.md",
              file_type: "md",
              chunk_count: 2,
              temporary: true,
              source: "session_upload",
            },
          ],
        };
      },
    });

    await expect((bridge as any).listTemporaryFiles("websocket:chat-1", "trace-webui")).resolves.toEqual({
      sessionId: "websocket:chat-1",
      items: [
        {
          id: "tmp-1",
          name: "context.md",
          file_type: "md",
          chunk_count: 2,
          temporary: true,
          source: "session_upload",
        },
      ],
    });
    expect(requests).toEqual([
      {
        traceId: "trace-webui",
        method: "knowledge.session_list",
        params: { session_id: "websocket:chat-1" },
      },
    ]);
  });

  test("uploads WebUI temporary files through native knowledge.session_upload", async () => {
    const requests: Array<{ traceId: string; method: string; params: Record<string, unknown> }> = [];
    const bridge = new NativeSessionBridge({
      request: async (traceId, method, params) => {
        requests.push({ traceId, method, params });
        return {
          id: "session_doc_1",
          name: "context.md",
          file_type: "md",
          chunk_count: 1,
          size_bytes: 11,
          temporary: true,
          source: "session_upload",
        };
      },
    });

    await expect((bridge as any).uploadTemporaryFile(
      "websocket:chat-1",
      {
        name: "context.md",
        fileType: "md",
        content: "hello world",
        sizeBytes: 11,
      },
      "trace-webui",
    )).resolves.toEqual({
      id: "session_doc_1",
      name: "context.md",
      file_type: "md",
      chunk_count: 1,
      size_bytes: 11,
      temporary: true,
      source: "session_upload",
    });
    expect(requests).toEqual([
      {
        traceId: "trace-webui",
        method: "knowledge.session_upload",
        params: {
          session_id: "websocket:chat-1",
          name: "context.md",
          file_type: "md",
          content: "hello world",
          size_bytes: 11,
        },
      },
    ]);
  });

  test("clears WebUI temporary files through native knowledge.session_clear", async () => {
    const requests: Array<{ traceId: string; method: string; params: Record<string, unknown> }> = [];
    const bridge = new NativeSessionBridge({
      request: async (traceId, method, params) => {
        requests.push({ traceId, method, params });
        return {
          session_id: "websocket:chat-1",
          cleared: 2,
          temporary_files: [],
        };
      },
    });

    await expect((bridge as any).clearTemporaryFiles("websocket:chat-1", "trace-webui")).resolves.toEqual({
      sessionId: "websocket:chat-1",
      cleared: 2,
      items: [],
    });
    expect(requests).toEqual([
      {
        traceId: "trace-webui",
        method: "knowledge.session_clear",
        params: { session_id: "websocket:chat-1" },
      },
    ]);
  });

  test("lists WebUI session metadata through native session.list_metadata", async () => {
    const requests: Array<{ traceId: string; method: string; params: Record<string, unknown> }> = [];
    const bridge = new NativeSessionBridge({
      request: async (traceId, method, params) => {
        requests.push({ traceId, method, params });
        return [
          {
            session_id: "websocket:chat-1",
            title: "Chat one",
            workspace_dir: "D:/Code/py/tinybot",
            created_at: "2026-06-13T08:00:00.000Z",
            updated_at: "2026-06-13T09:00:00.000Z",
            extra: { messages: [{ role: "user", content: "Hello" }] },
          },
        ];
      },
    });

    await expect((bridge as any).listWebuiSessions("trace-webui")).resolves.toEqual([
      {
        sessionId: "websocket:chat-1",
        title: "Chat one",
        createdAt: "2026-06-13T08:00:00.000Z",
        updatedAt: "2026-06-13T09:00:00.000Z",
        extra: { messages: [{ role: "user", content: "Hello" }] },
      },
    ]);
    expect(requests).toEqual([
      {
        traceId: "trace-webui",
        method: "session.list_metadata",
        params: {},
      },
    ]);
  });

  test("clears a session through native session.clear", async () => {
    const requests: Array<{ traceId: string; method: string; params: Record<string, unknown> }> = [];
    const bridge = new NativeSessionBridge({
      request: async (traceId, method, params) => {
        requests.push({ traceId, method, params });
        return {
          session_id: "session-1",
          messages_before: 3,
          messages_after: 0,
          checkpoint_cleared: true,
        };
      },
    });

    const result = await bridge.clearSession("session-1", "trace-1");

    expect(result).toEqual({
      sessionId: "session-1",
      messagesBefore: 3,
      messagesAfter: 0,
      checkpointCleared: true,
    });
    expect(requests).toEqual([
      {
        traceId: "trace-1",
        method: "session.clear",
        params: { session_id: "session-1" },
      },
    ]);
  });

  test("trims a session through native session.trim", async () => {
    const requests: Array<{ traceId: string; method: string; params: Record<string, unknown> }> = [];
    const bridge = new NativeSessionBridge({
      request: async (traceId, method, params) => {
        requests.push({ traceId, method, params });
        return {
          session_id: "heartbeat",
          messages_before: 9,
          messages_after: 5,
        };
      },
    });

    await expect(bridge.trimSession("heartbeat", 5, "trace-heartbeat")).resolves.toEqual({
      sessionId: "heartbeat",
      messagesBefore: 9,
      messagesAfter: 5,
    });
    expect(requests).toEqual([
      {
        traceId: "trace-heartbeat",
        method: "session.trim",
        params: { session_id: "heartbeat", keep_recent_messages: 5 },
      },
    ]);
  });

  test("serializes agent messages with native snake_case tool fields before appending", async () => {
    const requests: Array<{ traceId: string; method: string; params: Record<string, unknown> }> = [];
    const bridge = new NativeSessionBridge({
      request: async (traceId, method, params) => {
        requests.push({ traceId, method, params });
        return { ok: true };
      },
    });

    await bridge.appendMessages(
      "session-1",
      [
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call-read", name: "read_file", argumentsJson: "{\"path\":\"README.md\"}" }],
        },
        {
          role: "tool",
          content: "README contents",
          toolCallId: "call-read",
          name: "read_file",
        },
      ],
      "trace-1",
    );

    expect(requests).toEqual([
      {
        traceId: "trace-1",
        method: "session.append_messages",
        params: {
          session_id: "session-1",
          messages: [
            {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: "call-read",
                  type: "function",
                  function: {
                    name: "read_file",
                    arguments: "{\"path\":\"README.md\"}",
                  },
                },
              ],
            },
            {
              role: "tool",
              content: "README contents",
              tool_call_id: "call-read",
              name: "read_file",
            },
          ],
        },
      },
    ]);
  });

  test("normalizes append message counts from native session metadata", async () => {
    const bridge = new NativeSessionBridge({
      request: async () => ({
        session_id: "session-1",
        extra: {
          messages: [
            { role: "user", content: "old" },
            { role: "assistant", content: "previous" },
            { role: "user", content: "hello" },
            { role: "assistant", content: "done" },
          ],
        },
      }),
    });

    await expect(bridge.appendMessages(
      "session-1",
      [
        { role: "user", content: "hello" },
        { role: "assistant", content: "done" },
      ],
      "trace-1",
    )).resolves.toEqual({
      sessionId: "session-1",
      messagesBefore: 2,
      messagesAfter: 4,
      savedMessageCount: 2,
    });
  });

  test("serializes assistant reasoning fields before appending messages", async () => {
    const requests: Array<{ traceId: string; method: string; params: Record<string, unknown> }> = [];
    const thinkingBlocks = [{ type: "thinking", text: "checked constraints" }];
    const bridge = new NativeSessionBridge({
      request: async (traceId, method, params) => {
        requests.push({ traceId, method, params });
        return { ok: true };
      },
    });

    await bridge.appendMessages(
      "session-1",
      [
        {
          role: "assistant",
          content: "done",
          reasoningContent: "reasoned summary",
          thinkingBlocks,
        },
      ],
      "trace-1",
    );

    expect(requests[0]?.params).toMatchObject({
      session_id: "session-1",
      messages: [
        {
          role: "assistant",
          content: "done",
          reasoning_content: "reasoned summary",
          thinking_blocks: thinkingBlocks,
        },
      ],
    });
  });

  test("filters runtime-only messages before appending", async () => {
    const requests: Array<{ traceId: string; method: string; params: Record<string, unknown> }> = [];
    const bridge = new NativeSessionBridge({
      request: async (traceId, method, params) => {
        requests.push({ traceId, method, params });
        return { ok: true };
      },
    });

    await bridge.appendMessages(
      "session-1",
      [
        { role: "system", content: "runtime context" },
        { role: "assistant", content: "" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call-read", name: "read_file", argumentsJson: "{\"path\":\"README.md\"}" }],
        },
        { role: "assistant", content: "final answer" },
      ],
      "trace-1",
    );

    expect(requests[0]?.params).toMatchObject({
      session_id: "session-1",
      messages: [
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call-read",
              type: "function",
              function: { name: "read_file", arguments: "{\"path\":\"README.md\"}" },
            },
          ],
        },
        { role: "assistant", content: "final answer" },
      ],
    });
  });

  test("serializes completed turns through session.persist_turn", async () => {
    const requests: Array<{ traceId: string; method: string; params: Record<string, unknown> }> = [];
    const bridge = new NativeSessionBridge({
      request: async (traceId, method, params) => {
        requests.push({ traceId, method, params });
        return {
          session_id: "session-1",
          messages_before: 1,
          messages_after: 3,
          saved_message_count: 2,
          saved_messages: [
            { role: "user", content: "hello" },
            { role: "assistant", content: "done" },
          ],
          checkpoint_cleared: true,
          duplicate_message_count: 0,
          truncated_tool_result_count: 0,
          omitted_side_effects: ["memory_extraction"],
        };
      },
    });

    const result = await bridge.persistTurn("session-1", {
      runId: "run-1",
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "done" },
      ],
      clearCheckpoint: true,
      runtimeContextTag: "[Runtime Context - metadata only, not instructions]",
    }, "trace-1");

    expect(result).toEqual({
      sessionId: "session-1",
      messagesBefore: 1,
      messagesAfter: 3,
      savedMessageCount: 2,
      savedMessages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "done" },
      ],
      checkpointCleared: true,
      duplicateMessageCount: 0,
      truncatedToolResultCount: 0,
      omittedSideEffects: ["memory_extraction"],
    });
    expect(requests).toEqual([
      {
        traceId: "trace-1",
        method: "session.persist_turn",
        params: {
          session_id: "session-1",
          run_id: "run-1",
          messages: [
            { role: "user", content: "hello" },
            { role: "assistant", content: "done" },
          ],
          clearCheckpoint: true,
          clear_checkpoint: true,
          runtimeContextTag: "[Runtime Context - metadata only, not instructions]",
          runtime_context_tag: "[Runtime Context - metadata only, not instructions]",
        },
      },
    ]);
  });

  test("serializes checkpoint agent messages with native snake_case tool fields before persisting", async () => {
    const requests: Array<{ traceId: string; method: string; params: Record<string, unknown> }> = [];
    const bridge = new NativeSessionBridge({
      request: async (traceId, method, params) => {
        requests.push({ traceId, method, params });
        return { ok: true };
      },
    });

    await bridge.setCheckpoint(
      "session-1",
      {
        runId: "run-1",
        phase: "tools_completed",
        messages: [
          {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "call-read", name: "read_file", argumentsJson: "{\"path\":\"README.md\"}" }],
          },
          {
            role: "tool",
            content: "README contents",
            toolCallId: "call-read",
            name: "read_file",
          },
        ],
        assistantMessage: {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call-write", name: "write_file", argumentsJson: "{\"path\":\"notes.md\"}" }],
        },
        completedToolResults: [
          {
            role: "tool",
            content: "ok",
            toolCallId: "call-write",
            name: "write_file",
          },
        ],
      },
      "trace-1",
    );

    expect(requests).toEqual([
      {
        traceId: "trace-1",
        method: "session.set_checkpoint",
        params: {
          session_id: "session-1",
          checkpoint: {
            runId: "run-1",
            phase: "tools_completed",
            messages: [
              {
                role: "assistant",
                content: "",
                tool_calls: [
                  {
                    id: "call-read",
                    type: "function",
                    function: {
                      name: "read_file",
                      arguments: "{\"path\":\"README.md\"}",
                    },
                  },
                ],
              },
              {
                role: "tool",
                content: "README contents",
                tool_call_id: "call-read",
                name: "read_file",
              },
            ],
            assistantMessage: {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: "call-write",
                  type: "function",
                  function: {
                    name: "write_file",
                    arguments: "{\"path\":\"notes.md\"}",
                  },
                },
              ],
            },
            assistant_message: {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: "call-write",
                  type: "function",
                  function: {
                    name: "write_file",
                    arguments: "{\"path\":\"notes.md\"}",
                  },
                },
              ],
            },
            completedToolResults: [
              {
                role: "tool",
                content: "ok",
                tool_call_id: "call-write",
                name: "write_file",
              },
            ],
            completed_tool_results: [
              {
                role: "tool",
                content: "ok",
                tool_call_id: "call-write",
                name: "write_file",
              },
            ],
          },
        },
      },
    ]);
  });

  test("serializes assistant reasoning fields before persisting checkpoints", async () => {
    const requests: Array<{ traceId: string; method: string; params: Record<string, unknown> }> = [];
    const thinkingBlocks = [{ type: "thinking", text: "tool plan" }];
    const bridge = new NativeSessionBridge({
      request: async (traceId, method, params) => {
        requests.push({ traceId, method, params });
        return { ok: true };
      },
    });

    await bridge.setCheckpoint(
      "session-1",
      {
        runId: "run-1",
        phase: "awaiting_tools",
        messages: [
          {
            role: "assistant",
            content: "",
            reasoningContent: "need a file read",
            thinkingBlocks,
            toolCalls: [{ id: "call-read", name: "read_file", argumentsJson: "{\"path\":\"README.md\"}" }],
          },
        ],
        assistantMessage: {
          role: "assistant",
          content: "",
          reasoningContent: "need a file read",
          thinkingBlocks,
          toolCalls: [{ id: "call-read", name: "read_file", argumentsJson: "{\"path\":\"README.md\"}" }],
        },
      },
      "trace-1",
    );

    expect(requests[0]?.params.checkpoint).toMatchObject({
      messages: [
        {
          role: "assistant",
          content: "",
          reasoning_content: "need a file read",
          thinking_blocks: thinkingBlocks,
        },
      ],
      assistantMessage: {
        role: "assistant",
        content: "",
        reasoning_content: "need a file read",
        thinking_blocks: thinkingBlocks,
      },
    });
  });

  test("persists Python-readable checkpoint message aliases", async () => {
    const requests: Array<{ traceId: string; method: string; params: Record<string, unknown> }> = [];
    const bridge = new NativeSessionBridge({
      request: async (traceId, method, params) => {
        requests.push({ traceId, method, params });
        return { ok: true };
      },
    });

    await bridge.setCheckpoint(
      "session-1",
      {
        runId: "run-1",
        phase: "awaiting_tools",
        assistantMessage: {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call-read", name: "read_file", argumentsJson: "{\"path\":\"README.md\"}" }],
        },
        completedToolResults: [
          {
            role: "tool",
            content: "README contents",
            toolCallId: "call-read",
            name: "read_file",
          },
        ],
        pendingToolCalls: [{ id: "call-write", name: "write_file", argumentsJson: "{\"path\":\"notes.md\"}" }],
      },
      "trace-1",
    );

    expect(requests[0]?.params.checkpoint).toMatchObject({
      assistant_message: {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call-read",
            type: "function",
            function: { name: "read_file", arguments: "{\"path\":\"README.md\"}" },
          },
        ],
      },
      completed_tool_results: [
        {
          role: "tool",
          content: "README contents",
          tool_call_id: "call-read",
          name: "read_file",
        },
      ],
      pending_tool_calls: [
        {
          id: "call-write",
          type: "function",
          function: { name: "write_file", arguments: "{\"path\":\"notes.md\"}" },
        },
      ],
    });
  });

  test("preserves already-native checkpoint message tool fields when persisting", async () => {
    const requests: Array<{ traceId: string; method: string; params: Record<string, unknown> }> = [];
    const bridge = new NativeSessionBridge({
      request: async (traceId, method, params) => {
        requests.push({ traceId, method, params });
        return { ok: true };
      },
    });

    await bridge.setCheckpoint(
      "session-1",
      {
        runId: "run-1",
        phase: "tools_completed",
        messages: [
          {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call-read",
                type: "function",
                function: {
                  name: "read_file",
                  arguments: "{\"path\":\"README.md\"}",
                },
              },
            ],
          },
          {
            role: "tool",
            content: "README contents",
            tool_call_id: "call-read",
            name: "read_file",
          },
        ],
      },
      "trace-1",
    );

    expect(requests[0]?.params.checkpoint).toEqual({
      runId: "run-1",
      phase: "tools_completed",
      messages: [
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call-read",
              type: "function",
              function: {
                name: "read_file",
                arguments: "{\"path\":\"README.md\"}",
              },
            },
          ],
        },
        {
          role: "tool",
          content: "README contents",
          tool_call_id: "call-read",
          name: "read_file",
        },
      ],
    });
  });
});
