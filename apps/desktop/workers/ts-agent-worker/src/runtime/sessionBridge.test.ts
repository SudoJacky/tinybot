import { describe, expect, test } from "vitest";
import { NativeSessionBridge } from "./sessionBridge";

describe("NativeSessionBridge", () => {
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
