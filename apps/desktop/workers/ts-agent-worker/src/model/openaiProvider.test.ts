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
        reasoningContent: "need search",
        thinkingBlocks: [{ type: "thinking", text: "need search trace" }],
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
            content: null,
            reasoning_content: "need search",
            thinking_blocks: [{ type: "thinking", text: "need search trace" }],
            tool_calls: [
              {
                id: "60064fdb8",
                type: "function",
                function: { name: "search", arguments: "{\"query\":\"docs\"}" },
              },
            ],
          },
          { role: "tool", content: "result", tool_call_id: "60064fdb8", name: "search" },
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

  test("uses the per-run model when one is provided", async () => {
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
    const provider = new OpenAIProvider({ client, defaultModel: "default-model" });

    await provider.complete([{ role: "user", content: "hello" }], { model: "gpt-run-model" });

    expect(requests).toMatchObject([
      {
        model: "gpt-run-model",
      },
    ]);
  });

  test("serializes generation settings into the OpenAI request", async () => {
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
    const provider = new OpenAIProvider({ client, defaultModel: "default-model" });

    await provider.complete([{ role: "user", content: "hello" }], {
      temperature: 0.2,
      maxTokens: 2048,
      reasoningEffort: "none",
    });

    expect(requests).toMatchObject([
      {
        temperature: 0.2,
        max_tokens: 2048,
        reasoning_effort: "none",
      },
    ]);
  });

  test("omits temperature when reasoning effort is active", async () => {
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
    const provider = new OpenAIProvider({ client, defaultModel: "default-model" });

    await provider.complete([{ role: "user", content: "hello" }], {
      temperature: 0.2,
      reasoningEffort: "medium",
    });

    expect(requests).toEqual([
      expect.not.objectContaining({
        temperature: expect.anything(),
      }),
    ]);
    expect(requests).toMatchObject([
      {
        reasoning_effort: "medium",
      },
    ]);
  });

  test("omits temperature for GPT-5 and reasoning model families", async () => {
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
    const provider = new OpenAIProvider({ client, defaultModel: "gpt-5" });

    await provider.complete([{ role: "user", content: "hello" }], {
      temperature: 0.2,
    });
    await provider.complete([{ role: "user", content: "hello" }], {
      model: "o3-mini",
      temperature: 0.2,
    });

    expect(requests).toEqual([
      expect.not.objectContaining({
        temperature: expect.anything(),
      }),
      expect.not.objectContaining({
        temperature: expect.anything(),
      }),
    ]);
  });

  test("sanitizes empty non-tool-call message content like the Python provider", async () => {
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

    await provider.complete([
      { role: "system", content: "" },
      { role: "user", content: "" },
      { role: "assistant", content: "" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call-1", name: "read_file", argumentsJson: "{}" }],
      },
    ]);

    expect(requests).toMatchObject([
      {
        messages: [
          { role: "system", content: "(empty)" },
          { role: "user", content: "(empty)" },
          { role: "assistant", content: "(empty)" },
          { role: "assistant", content: null },
        ],
      },
    ]);
  });

  test("normalizes tool call ids consistently for OpenAI requests", async () => {
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

    await provider.complete([
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call-read-file-very-long", name: "read_file", argumentsJson: "{}" }],
      },
      {
        role: "tool",
        content: "file contents",
        toolCallId: "call-read-file-very-long",
        name: "read_file",
      },
    ]);

    expect(requests).toMatchObject([
      {
        messages: [
          {
            tool_calls: [
              {
                id: "8314c6a5e",
              },
            ],
          },
          {
            tool_call_id: "8314c6a5e",
          },
        ],
      },
    ]);
  });

  test("returns an error response when the OpenAI stream cannot be created", async () => {
    const client = {
      chat: {
        completions: {
          create: async () => {
            throw new Error("request failed");
          },
        },
      },
    };
    const provider = new OpenAIProvider({ client, defaultModel: "gpt-test" });

    const response = await provider.complete([{ role: "user", content: "hello" }]);

    expect(response).toMatchObject({
      content: "Error calling LLM: request failed",
      toolCalls: [],
      stopReason: "error",
    });
  });

  test("returns provider error body when the OpenAI stream cannot be created", async () => {
    const client = {
      chat: {
        completions: {
          create: async () => {
            throw Object.assign(new Error("bad request"), {
              response: {
                text: "provider rejected request",
              },
            });
          },
        },
      },
    };
    const provider = new OpenAIProvider({ client, defaultModel: "gpt-test" });

    const response = await provider.complete([{ role: "user", content: "hello" }]);

    expect(response).toMatchObject({
      content: "Error: provider rejected request",
      toolCalls: [],
      stopReason: "error",
    });
  });
});
