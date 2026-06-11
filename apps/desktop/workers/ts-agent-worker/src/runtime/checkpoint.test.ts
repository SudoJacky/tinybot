import { describe, expect, test } from "vitest";

import type { AgentRunSpec } from "../agent/agentRunSpec.ts";
import type { AgentRunnerCheckpoint } from "../agent/agentRunner.ts";
import { sessionCheckpointFromRunner } from "./checkpoint.ts";

describe("sessionCheckpointFromRunner", () => {
  test("converts runner checkpoints into versioned session checkpoint payloads with native aliases", () => {
    const spec: AgentRunSpec = {
      runId: "run-1",
      sessionId: "session-1",
      messages: [{ role: "user", content: "hello" }],
      model: "test-model",
      maxIterations: 4,
      stream: true,
      temperature: 0.2,
      maxTokens: 1024,
      reasoningEffort: "medium",
      contextWindow: 32000,
      toolResultBudget: 1200,
      failOnToolError: true,
    };
    const checkpoint: AgentRunnerCheckpoint = {
      phase: "awaiting_tools",
      iteration: 1,
      model: "test-model",
      messages: [
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call-1", name: "read_file", argumentsJson: "{\"path\":\"README.md\"}" }],
          reasoningContent: "I need the file",
        },
      ],
      assistantMessage: {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call-1", name: "read_file", argumentsJson: "{\"path\":\"README.md\"}" }],
        reasoningContent: "I need the file",
      },
      completedToolResults: [],
      pendingToolCalls: [{ id: "call-1", name: "read_file", argumentsJson: "{\"path\":\"README.md\"}" }],
    };

    expect(sessionCheckpointFromRunner(spec, checkpoint)).toEqual({
      version: 1,
      runId: "run-1",
      run_id: "run-1",
      phase: "awaiting_tools",
      iteration: 1,
      model: "test-model",
      maxIterations: 4,
      max_iterations: 4,
      stream: true,
      temperature: 0.2,
      maxTokens: 1024,
      max_tokens: 1024,
      reasoningEffort: "medium",
      reasoning_effort: "medium",
      contextWindow: 32000,
      context_window: 32000,
      toolResultBudget: 1200,
      tool_result_budget: 1200,
      failOnToolError: true,
      fail_on_tool_error: true,
      messages: checkpoint.messages,
      assistantMessage: checkpoint.assistantMessage,
      assistant_message: checkpoint.assistantMessage,
      completedToolResults: [],
      completed_tool_results: [],
      pendingToolCalls: checkpoint.pendingToolCalls,
      pending_tool_calls: checkpoint.pendingToolCalls,
    });
  });
});
