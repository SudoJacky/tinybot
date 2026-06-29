import { describe, expect, test } from "vitest";

import { findCatalogEntry } from "../providers/providerCatalog";
import { buildOpenAIChatRequest } from "./openaiRequestBuilder";

describe("buildOpenAIChatRequest", () => {
  test("uses catalog token parameter and omits temperature for reasoning OpenAI models", () => {
    const request = buildOpenAIChatRequest({
      defaultModel: "gpt-5",
      messages: [{ role: "user", content: "hi" }],
      options: { maxTokens: 123, temperature: 0.1, reasoningEffort: "medium" },
      requestTraits: findCatalogEntry("openai")?.requestTraits,
    });

    expect(request.max_completion_tokens).toBe(123);
    expect(request).not.toHaveProperty("max_tokens");
    expect(request).not.toHaveProperty("temperature");
    expect(request.reasoning_effort).toBe("medium");
  });

  test("strips gateway provider prefix and merges extra body defaults with run overrides", () => {
    const request = buildOpenAIChatRequest({
      defaultModel: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
      options: { extraBody: { run_flag: true } },
      requestTraits: findCatalogEntry("openrouter")?.requestTraits,
      extraBodyDefaults: { route: "fallback" },
    });

    expect(request.model).toBe("gpt-4o-mini");
    expect(request.extra_body).toEqual({ route: "fallback", run_flag: true });
  });

  test("sets enable_search in extra body for OpenAI-compatible providers", () => {
    const request = buildOpenAIChatRequest({
      defaultModel: "qwen-plus",
      messages: [{ role: "user", content: "hi" }],
      options: {},
      enableSearch: true,
    });

    expect(request.extra_body).toEqual({ enable_search: true });
  });

  test("adds prompt cache markers to system context recent messages and tool definitions", () => {
    const request = buildOpenAIChatRequest({
      defaultModel: "gpt-test",
      messages: [
        { role: "system", content: "You are TinyBot." },
        { role: "user", content: "Earlier message" },
        { role: "assistant", content: "Earlier answer" },
        { role: "user", content: "Latest message" },
      ],
      options: {
        tools: [
          {
            name: "read_file",
            description: "Read a file",
            parameters: { type: "object", properties: { path: { type: "string" } } },
          },
          {
            name: "write_file",
            description: "Write a file",
            parameters: { type: "object", properties: { path: { type: "string" } } },
          },
        ],
      },
      requestTraits: { supportsPromptCaching: true },
    });

    expect(request.messages).toEqual([
      {
        role: "system",
        content: [{ type: "text", text: "You are TinyBot.", cache_control: { type: "ephemeral" } }],
      },
      { role: "user", content: "Earlier message" },
      {
        role: "assistant",
        content: [{ type: "text", text: "Earlier answer", cache_control: { type: "ephemeral" } }],
      },
      { role: "user", content: "Latest message" },
    ]);
    expect(request.tools).toEqual([
      {
        type: "function",
        function: {
          name: "read_file",
          description: "Read a file",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      },
      {
        type: "function",
        function: {
          name: "write_file",
          description: "Write a file",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
        cache_control: { type: "ephemeral" },
      },
    ]);
  });

  test("preserves message sanitization and tool-call id normalization", () => {
    const request = buildOpenAIChatRequest({
      defaultModel: "gpt-test",
      messages: [
        { role: "user", content: "" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call-read-file-very-long", name: "read_file", argumentsJson: "{}" }],
        },
        { role: "tool", content: "", toolCallId: "call-read-file-very-long", name: "read_file" },
      ],
      options: {},
    });

    expect(request.messages).toEqual([
      { role: "user", content: "(empty)" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "8314c6a5e",
            type: "function",
            function: { name: "read_file", arguments: "{}" },
          },
        ],
      },
      { role: "tool", content: "(empty)", tool_call_id: "8314c6a5e", name: "read_file" },
    ]);
  });
});
