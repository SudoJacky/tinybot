import { describe, expect, test } from "vitest";

import type { AgentMessage } from "../agent/agentRunSpec";
import { OpenAIProvider } from "./openaiProvider";

async function* chunks(values: unknown[]): AsyncIterable<unknown> {
  for (const value of values) {
    yield value;
  }
}

describe("OpenAIProvider", () => {
  test("calls an injected OpenAI-compatible chat completions client and parses the stream", async () => {
    const requests: unknown[] = [];
    const client = {
      chat: {
        completions: {
          create: async (request: unknown) => {
            requests.push(request);
            return chunks([
              {
                choices: [{ delta: { content: "done" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
              },
            ]);
          },
        },
      },
    };
    const provider = new OpenAIProvider({ client, defaultModel: "gpt-test" });
    const messages: AgentMessage[] = [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call-1", name: "search", argumentsJson: "{\"query\":\"docs\"}" }],
      },
      { role: "tool", content: "result", toolCallId: "call-1", name: "search" },
    ];

    const response = await provider.complete(messages);

    expect(response).toEqual({
      content: "done",
      reasoningContent: undefined,
      toolCalls: [],
      usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
      stopReason: "stop",
    });
    expect(requests).toEqual([
      {
        model: "gpt-test",
        messages: [
          { role: "user", content: "hello" },
          {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: { name: "search", arguments: "{\"query\":\"docs\"}" },
              },
            ],
          },
          { role: "tool", content: "result", tool_call_id: "call-1", name: "search" },
        ],
        stream: true,
        stream_options: { include_usage: true },
      },
    ]);
  });

  test("serializes tool definitions into the OpenAI request", async () => {
    const requests: unknown[] = [];
    const client = {
      chat: {
        completions: {
          create: async (request: unknown) => {
            requests.push(request);
            return chunks([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
          },
        },
      },
    };
    const provider = new OpenAIProvider({ client, defaultModel: "gpt-test" });

    await provider.complete([{ role: "user", content: "search docs" }], {
      tools: [
        {
          name: "search",
          description: "Search docs",
          parameters: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        },
      ],
    });

    expect(requests).toEqual([
      {
        model: "gpt-test",
        messages: [{ role: "user", content: "search docs" }],
        stream: true,
        stream_options: { include_usage: true },
        tools: [
          {
            type: "function",
            function: {
              name: "search",
              description: "Search docs",
              parameters: {
                type: "object",
                properties: { query: { type: "string" } },
                required: ["query"],
              },
            },
          },
        ],
        tool_choice: "auto",
      },
    ]);
  });
});
