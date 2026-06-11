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

  test("creates an OpenAI-compatible provider from a resolved runtime provider", async () => {
    const clientOptions: unknown[] = [];
    const requests: unknown[] = [];
    const provider = createModelProvider(
      {
        kind: "resolved",
        resolved: {
          providerId: "openrouter",
          model: "openai/gpt-4o-mini",
          source: "explicit",
          apiMode: "openai_chat_completions",
          apiKey: "or-key",
          apiKeySource: "config",
          apiBase: "https://openrouter.ai/api/v1",
          models: [],
          manualModelIds: [],
          supportsModelDiscovery: true,
          requestTraits: {
            tokenParameter: "max_tokens",
            temperaturePolicy: "standard",
            stripModelPrefix: true,
            extraBodyDefaults: {},
            supportsPromptCaching: false,
          },
          extraBody: { route: "fallback" },
          warnings: [],
        },
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

    const response = await provider.complete([{ role: "user", content: "hello" }]);

    expect(response.content).toBe("done");
    expect(clientOptions).toEqual([
      {
        apiKey: "or-key",
        baseURL: "https://openrouter.ai/api/v1",
        maxRetries: 0,
      },
    ]);
    expect(requests).toEqual([
      expect.objectContaining({
        model: "gpt-4o-mini",
        extra_body: { route: "fallback" },
      }),
    ]);
  });

  test("returns an unconfigured provider for unsupported resolved API modes", async () => {
    const provider = createModelProvider({
      kind: "resolved",
      resolved: {
        providerId: "native_provider",
        model: "native-model",
        source: "explicit",
        apiMode: "unsupported",
        models: [],
        manualModelIds: [],
        supportsModelDiscovery: false,
        requestTraits: {
          tokenParameter: "max_tokens",
          temperaturePolicy: "standard",
          stripModelPrefix: false,
          extraBodyDefaults: {},
          supportsPromptCaching: false,
        },
        extraBody: {},
        warnings: [],
      },
    });

    await expect(provider.complete([{ role: "user", content: "hello" }])).rejects.toThrow(
      "Unsupported provider api_mode: unsupported",
    );
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
    const toolCallDeltas: Array<{
      index: number;
      deltaText: string;
      toolCallId?: string;
      toolName?: string;
      phase?: string;
      status?: string;
      completed?: boolean;
    }> = [];
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
        phase: "arguments",
        status: "streaming",
        completed: false,
      },
      {
        index: 0,
        deltaText: "",
        toolCallId: "call-1",
        toolName: "read_file",
        phase: "terminal",
        status: "completed",
        completed: true,
      },
    ]);
  });

  test("fixture provider honors response delay for cancellation tests", async () => {
    const provider = createModelProvider({
      kind: "fixture",
      responses: [
        {
          content: "delayed answer",
          stopReason: "stop",
          toolCalls: [],
          delayMs: 20,
        },
      ],
    });
    const start = Date.now();

    const response = await provider.complete([{ role: "user", content: "hello" }]);

    expect(response.content).toBe("delayed answer");
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
  });
});
