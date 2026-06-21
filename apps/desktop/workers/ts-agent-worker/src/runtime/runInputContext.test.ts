import { describe, expect, test } from "vitest";

import type { AgentRunInput, ContextBridgeLoadResult } from "../agent/contextTypes.ts";
import { buildRunInputSpec } from "./runInputContext.ts";

function input(overrides: Partial<AgentRunInput> = {}): AgentRunInput {
  return {
    runId: "run-input-1",
    sessionId: "session-1",
    input: { content: "Continue" },
    model: "test-model",
    maxIterations: 4,
    stream: true,
    contextWindow: 32000,
    toolResultBudget: 1200,
    metadata: { source: "desktop" },
    ...overrides,
  };
}

function loaded(): ContextBridgeLoadResult {
  return {
    input: {
      identity: "Identity",
      bootstrapFiles: [{ path: "AGENTS.md", contents: "Agent rules" }],
      history: [
        { role: "user", content: "Earlier" },
        { role: "assistant", content: "Earlier answer" },
      ],
      currentMessage: "Continue",
      runtime: {
        currentTime: "2026-06-11 09:00:00 Asia/Shanghai",
        channel: "desktop",
        chatId: "chat-1",
      },
    },
    metadata: {
      missingSession: false,
      malformedHistoryCount: 0,
      missingBootstrapFiles: [],
      bootstrapFallbackUsed: false,
    },
  };
}

describe("buildRunInputSpec", () => {
  test("projects loaded context into an AgentRunSpec and context metadata", () => {
    const result = buildRunInputSpec("trace-1", input(), loaded());

    expect(result.spec).toMatchObject({
      runId: "run-input-1",
      traceId: "trace-1",
      sessionId: "session-1",
      model: "test-model",
      maxIterations: 4,
      stream: true,
      contextWindow: 32000,
      toolResultBudget: 1200,
      metadata: {
        source: "desktop",
        _contextInitialMessageCount: 4,
        _contextSessionAppendMessages: [
          {
            role: "user",
            content: expect.stringContaining("Continue"),
          },
        ],
      },
    });
    expect(result.spec.messages.map((message) => message.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(result.contextMetadata).toMatchObject({
      historyMessageCount: 2,
      bootstrapFiles: ["AGENTS.md"],
      bridge: {
        missingSession: false,
        malformedHistoryCount: 0,
        missingBootstrapFiles: [],
        bootstrapFallbackUsed: false,
      },
    });
  });

  test("uses stable runner defaults when optional run_input fields are omitted", () => {
    const result = buildRunInputSpec("trace-1", input({
      model: undefined,
      maxIterations: undefined,
      stream: undefined,
      contextWindow: undefined,
      maxTokens: undefined,
      temperature: undefined,
      toolResultBudget: undefined,
      metadata: undefined,
    }), loaded());

    expect(result.spec).toMatchObject({
      model: "deepseek-reasoner",
      maxIterations: 200,
      stream: false,
      contextWindow: 65536,
      maxTokens: 8192,
      temperature: 0.1,
      toolResultBudget: 16000,
    });
    expect(result.spec.metadata).toMatchObject({
      _contextInitialMessageCount: 4,
    });
  });

  test("uses bridge run defaults when optional run_input fields are omitted", () => {
    const result = buildRunInputSpec("trace-1", input({
      model: undefined,
      maxIterations: undefined,
      contextWindow: undefined,
      maxTokens: undefined,
      providerRetryMode: undefined,
      reasoningEffort: undefined,
      temperature: undefined,
      toolResultBudget: undefined,
    }), {
      ...loaded(),
      runDefaults: {
        model: "deepseek-v4-flash",
        maxIterations: 12,
        contextWindow: 48000,
        maxTokens: 4096,
        providerRetryMode: "persistent",
        reasoningEffort: "high",
        temperature: 0.3,
        toolResultBudget: 9000,
      },
    });

    expect(result.spec).toMatchObject({
      model: "deepseek-v4-flash",
      maxIterations: 12,
      contextWindow: 48000,
      maxTokens: 4096,
      providerRetryMode: "persistent",
      reasoningEffort: "high",
      temperature: 0.3,
      toolResultBudget: 9000,
    });
  });
});
