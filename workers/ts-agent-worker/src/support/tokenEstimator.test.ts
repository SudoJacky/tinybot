import { describe, expect, test } from "vitest";

import {
  applyReasoningRiskBuffer,
  estimateMessageTokens,
  estimatePromptTokens,
  estimatePromptTokensChain,
  isReasoningModel,
  resolveEncodingName,
} from "./tokenEstimator";

describe("tokenEstimator", () => {
  test("resolves model encoding hints", () => {
    expect(resolveEncodingName("gpt-4.1-mini")).toBe("o200k_base");
    expect(resolveEncodingName("openai/gpt-5")).toBe("o200k_base");
    expect(resolveEncodingName("claude-3-5-sonnet")).toBe("cl100k_base");
    expect(resolveEncodingName("qwen-max")).toBe("cl100k_base");
    expect(resolveEncodingName(undefined)).toBe("cl100k_base");
  });

  test("applies the reasoning risk buffer only to reasoning models", () => {
    expect(isReasoningModel("deepseek-r1")).toBe(true);
    expect(isReasoningModel("o3-mini")).toBe(true);
    expect(isReasoningModel("gpt-4.1-mini")).toBe(false);
    expect(applyReasoningRiskBuffer(100, "deepseek-r1")).toBe(113);
    expect(applyReasoningRiskBuffer(100, "gpt-4.1-mini")).toBe(100);
    expect(applyReasoningRiskBuffer(0, "o3-mini")).toBe(0);
  });

  test("counts provider-visible message fields with framing overhead", () => {
    expect(estimateMessageTokens({
      role: "assistant",
      content: "hello world",
      reasoningContent: "hidden reasoning",
      toolCallId: "call-1",
      name: "echo",
      toolCalls: [{ id: "call-2", name: "search", argumentsJson: "{}" }],
    })).toBeGreaterThan(4);
    expect(estimateMessageTokens({ role: "user", content: "" })).toBe(4);
  });

  test("estimates prompt tokens and reports heuristic source", () => {
    const result = estimatePromptTokens([
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "text", text: "world" }] },
    ], {
      tools: [{ name: "echo", parameters: { type: "object" } }],
      model: "gpt-4.1-mini",
    });

    expect(result.tokens).toBeGreaterThan(0);
    expect(result.source).toBe("heuristic");
    expect(result.encodingName).toBe("o200k_base");
    expect(result.estimated).toBe(true);
  });

  test("uses provider counter first and preserves reasoning source suffix", () => {
    const result = estimatePromptTokensChain({
      provider: {
        estimatePromptTokens: () => ({ tokens: 100, source: "provider_counter" }),
      },
      model: "o3-mini",
      messages: [{ role: "user", content: "hello" }],
    });

    expect(result).toEqual({
      tokens: 113,
      source: "provider_counter+reasoning_buffer",
      estimated: false,
    });
  });
});
