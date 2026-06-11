import { describe, expect, test } from "vitest";

import { collectChatCompletionStream } from "./streamParser";

async function* chunks(values: unknown[]): AsyncIterable<unknown> {
  for (const value of values) {
    yield value;
  }
}

async function* interruptedToolCallStream(): AsyncIterable<unknown> {
  yield {
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "call-1",
              function: { name: "send_message", arguments: "{\"content\":\"Hi" },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  };
  throw new Error("connection dropped");
}

async function* stalledStream(): AsyncIterable<unknown> {
  yield {
    choices: [{ delta: { content: "partial" }, finish_reason: null }],
  };
  await new Promise(() => {
    // Intentionally never resolves; the parser must enforce its own idle timeout.
  });
}

describe("collectChatCompletionStream", () => {
  test("collects streamed content, reasoning, tool-call arguments, finish reason, and usage", async () => {
    const contentDeltas: string[] = [];
    const reasoningDeltas: string[] = [];
    const toolArgumentDeltas: Array<{ index: number; deltaText: string; toolName?: string; toolCallId?: string }> = [];

    const response = await collectChatCompletionStream(
      chunks([
        {
          choices: [{ delta: { content: "Hel" }, finish_reason: null }],
        },
        {
          choices: [{ delta: { content: "lo" }, finish_reason: null }],
        },
        {
          choices: [{ delta: { reasoning_content: "thinking" }, finish_reason: null }],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call-1",
                    function: { name: "search", arguments: "{\"query\"" },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: { arguments: ":\"docs\"}" },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 4,
            total_tokens: 14,
          },
        },
      ]),
      {
        onContentDelta: (delta) => contentDeltas.push(delta),
        onReasoningDelta: (delta) => reasoningDeltas.push(delta),
        onToolCallDelta: (delta) => toolArgumentDeltas.push(delta),
      },
    );

    expect(response).toEqual({
      content: "Hello",
      reasoningContent: "thinking",
      toolCalls: [
        {
          id: "call-1",
          name: "search",
          argumentsJson: "{\"query\":\"docs\"}",
        },
      ],
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        totalTokens: 14,
      },
      stopReason: "tool_calls",
    });
    expect(contentDeltas).toEqual(["Hel", "lo"]);
    expect(reasoningDeltas).toEqual(["thinking"]);
    expect(toolArgumentDeltas.slice(0, 2)).toEqual([
      {
        index: 0,
        toolCallIndex: 0,
        providerCallId: undefined,
        sequence: 1,
        deltaText: "{\"query\"",
        toolCallId: "call-1",
        toolName: "search",
        phase: "arguments",
        status: "streaming",
        completed: false,
      },
      {
        index: 0,
        toolCallIndex: 0,
        providerCallId: undefined,
        sequence: 2,
        deltaText: ":\"docs\"}",
        toolCallId: "call-1",
        toolName: "search",
        phase: "arguments",
        status: "streaming",
        completed: false,
      },
    ]);
    expect(toolArgumentDeltas.at(-1)).toEqual({
      index: 0,
      toolCallIndex: 0,
      providerCallId: undefined,
      sequence: 3,
      deltaText: "",
      toolCallId: "call-1",
      toolName: "search",
      phase: "terminal",
      status: "completed",
      completed: true,
    });
  });

  test("splits large streamed tool-call argument deltas like the Python provider", async () => {
    const toolArgumentDeltas: Array<{ index: number; deltaText: string; toolName?: string; toolCallId?: string }> = [];
    const largeArguments = "x".repeat(9000);

    const response = await collectChatCompletionStream(
      chunks([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call-1",
                    function: { name: "write_file", arguments: largeArguments },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        },
      ]),
      {
        onToolCallDelta: (delta) => toolArgumentDeltas.push(delta),
      },
    );

    expect(response.toolCalls).toEqual([
      {
        id: "call-1",
        name: "write_file",
        argumentsJson: largeArguments,
      },
    ]);
    const argumentDeltas = toolArgumentDeltas.filter((delta) => delta.phase !== "terminal");
    expect(argumentDeltas.map((delta) => delta.deltaText).join("")).toBe(largeArguments);
    expect(argumentDeltas).toHaveLength(2);
    expect(argumentDeltas.every((delta) => delta.deltaText.length <= 8192)).toBe(true);
    expect(argumentDeltas).toEqual([
      expect.objectContaining({
        index: 0,
        toolCallId: "call-1",
        toolName: "write_file",
        phase: "arguments",
        status: "streaming",
        completed: false,
      }),
      expect.objectContaining({
        index: 0,
        toolCallId: "call-1",
        toolName: "write_file",
        phase: "arguments",
        status: "streaming",
        completed: false,
      }),
    ]);
    expect(argumentDeltas[0]).toMatchObject({
      index: 0,
      toolCallId: "call-1",
      toolName: "write_file",
    });
  });

  test("emits a terminal tool-call delta when streaming tool arguments complete", async () => {
    const toolArgumentDeltas: Array<{
      index: number;
      deltaText: string;
      toolName?: string;
      toolCallId?: string;
      phase?: string;
      status?: string;
      completed?: boolean;
    }> = [];

    await collectChatCompletionStream(
      chunks([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call-1",
                    function: { name: "search", arguments: "{\"query\":\"docs\"}" },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        },
      ]),
      {
        onToolCallDelta: (delta) => toolArgumentDeltas.push(delta),
      },
    );

    expect(toolArgumentDeltas.at(-1)).toEqual({
      index: 0,
      toolCallIndex: 0,
      providerCallId: undefined,
      sequence: 2,
      deltaText: "",
      toolCallId: "call-1",
      toolName: "search",
      phase: "terminal",
      status: "completed",
      completed: true,
    });
  });

  test("normalizes cached token usage fields like the Python provider", async () => {
    const openAIResponse = await collectChatCompletionStream(
      chunks([
        {
          choices: [{ delta: { content: "done" }, finish_reason: "stop" }],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 4,
            total_tokens: 14,
            prompt_tokens_details: { cached_tokens: 6 },
          },
        },
      ]),
    );
    const topLevelResponse = await collectChatCompletionStream(
      chunks([
        {
          choices: [{ delta: { content: "done" }, finish_reason: "stop" }],
          usage: {
            prompt_tokens: 11,
            completion_tokens: 5,
            total_tokens: 16,
            cached_tokens: 7,
          },
        },
      ]),
    );
    const promptCacheHitResponse = await collectChatCompletionStream(
      chunks([
        {
          choices: [{ delta: { content: "done" }, finish_reason: "stop" }],
          usage: {
            prompt_tokens: 12,
            completion_tokens: 6,
            total_tokens: 18,
            prompt_cache_hit_tokens: 8,
          },
        },
      ]),
    );

    expect(openAIResponse.usage).toEqual({
      inputTokens: 10,
      outputTokens: 4,
      totalTokens: 14,
      cachedTokens: 6,
    });
    expect(topLevelResponse.usage).toEqual({
      inputTokens: 11,
      outputTokens: 5,
      totalTokens: 16,
      cachedTokens: 7,
    });
    expect(promptCacheHitResponse.usage).toEqual({
      inputTokens: 12,
      outputTokens: 6,
      totalTokens: 18,
      cachedTokens: 8,
    });
  });

  test("returns an error response after stream interruption while keeping prior tool-call deltas", async () => {
    const toolArgumentDeltas: Array<{
      index: number;
      deltaText: string;
      toolName?: string;
      toolCallId?: string;
      phase?: string;
      status?: string;
      completed?: boolean;
    }> = [];

    const response = await collectChatCompletionStream(interruptedToolCallStream(), {
      onToolCallDelta: (delta) => toolArgumentDeltas.push(delta),
    });

    expect(toolArgumentDeltas).toEqual([
      {
        index: 0,
        toolCallIndex: 0,
        providerCallId: undefined,
        sequence: 1,
        deltaText: "{\"content\":\"Hi",
        toolCallId: "call-1",
        toolName: "send_message",
        phase: "arguments",
        status: "streaming",
        completed: false,
      },
      {
        index: 0,
        toolCallIndex: 0,
        providerCallId: undefined,
        sequence: 2,
        deltaText: "",
        toolCallId: "call-1",
        toolName: "send_message",
        phase: "terminal",
        status: "error",
        completed: false,
      },
    ]);
    expect(response).toMatchObject({
      content: "Error calling LLM: connection dropped",
      stopReason: "error",
    });
  });

  test("returns an error response when the provider stream stalls past the idle timeout", async () => {
    const contentDeltas: string[] = [];

    const result = await Promise.race([
      collectChatCompletionStream(stalledStream(), {
        streamIdleTimeoutMs: 5,
        onContentDelta: (delta) => contentDeltas.push(delta),
      }),
      new Promise((resolve) => setTimeout(() => resolve("hung"), 100)),
    ]);

    expect(result).toEqual({
      content: "Error calling LLM: stream stalled for more than 5 ms",
      toolCalls: [],
      stopReason: "error",
    });
    expect(contentDeltas).toEqual(["partial"]);
  });
});
