import { describe, expect, test } from "vitest";

import { OpenAIProvider } from "../model/openaiProvider";
import { UnconfiguredProvider } from "../model/unconfiguredProvider";
import { createModelProvider } from "./providerFactory";

async function* chunks(values: unknown[]): AsyncIterable<unknown> {
  for (const value of values) {
    yield value;
  }
}

describe("createModelProvider", () => {
  test("returns an unconfigured provider when no provider kind is set", () => {
    const provider = createModelProvider({});

    expect(provider).toBeInstanceOf(UnconfiguredProvider);
  });

  test("creates an OpenAI provider with an injected SDK client factory", async () => {
    const clientOptions: unknown[] = [];
    const requests: unknown[] = [];
    const provider = createModelProvider(
      {
        kind: "openai",
        apiKey: "test-key",
        baseURL: "https://example.test/v1",
        model: "gpt-test",
      },
      {
        createOpenAIClient: (options) => {
          clientOptions.push(options);
          return {
            chat: {
              completions: {
                create: async (request: unknown) => {
                  requests.push(request);
                  return chunks([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
                },
              },
            },
          };
        },
      },
    );

    expect(provider).toBeInstanceOf(OpenAIProvider);
    const response = await provider.complete([{ role: "user", content: "hello" }]);

    expect(response.content).toBe("done");
    expect(clientOptions).toEqual([
      {
        apiKey: "test-key",
        baseURL: "https://example.test/v1",
        maxRetries: 0,
      },
    ]);
    expect(requests).toEqual([
      {
        model: "gpt-test",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
        stream_options: { include_usage: true },
      },
    ]);
  });

  test("creates a fixture provider for offline worker integration tests", async () => {
    const provider = createModelProvider({
      kind: "fixture",
      responses: [
        {
          content: "fixture answer",
          stopReason: "stop",
          toolCalls: [],
        },
      ],
    });

    const response = await provider.complete([{ role: "user", content: "hello" }]);

    expect(response).toEqual({
      content: "fixture answer",
      stopReason: "stop",
      toolCalls: [],
    });
  });

  test("fixture provider emits streaming callbacks for content and tool calls", async () => {
    const contentDeltas: string[] = [];
    const toolCallDeltas: Array<{ index: number; deltaText: string; toolCallId?: string; toolName?: string }> = [];
    const provider = createModelProvider({
      kind: "fixture",
      responses: [
        {
          content: "fixture answer",
          stopReason: "tool_calls",
          toolCalls: [{ id: "call-1", name: "read_file", argumentsJson: "{\"path\":\"README.md\"}" }],
        },
      ],
    });

    await provider.complete([{ role: "user", content: "hello" }], {
      onContentDelta: (delta) => contentDeltas.push(delta),
      onToolCallDelta: (delta) => toolCallDeltas.push(delta),
    });

    expect(contentDeltas).toEqual(["fixture answer"]);
    expect(toolCallDeltas).toEqual([
      {
        index: 0,
        deltaText: "{\"path\":\"README.md\"}",
        toolCallId: "call-1",
        toolName: "read_file",
      },
    ]);
  });
});
