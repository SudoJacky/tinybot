import { describe, expect, test } from "vitest";

import { collectChatCompletionStream } from "./streamParser";

async function* chunks(values: unknown[]): AsyncIterable<unknown> {
  for (const value of values) {
    yield value;
  }
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
    expect(toolArgumentDeltas).toEqual([
      { index: 0, deltaText: "{\"query\"", toolCallId: "call-1", toolName: "search" },
      { index: 0, deltaText: ":\"docs\"}" },
    ]);
  });
});
