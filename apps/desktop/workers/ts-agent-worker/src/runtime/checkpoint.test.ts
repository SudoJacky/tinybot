import { describe, expect, test } from "vitest";

import type { AgentMessage, AgentRunSpec } from "../agent/agentRunSpec.ts";
import type { AgentRunnerCheckpoint } from "../agent/agentRunner.ts";
import {
  approvalOperationFromCheckpoint,
  resumedSpecFromApprovedToolResult,
  resumedSpecFromDeniedApproval,
  resumedSpecFromSubmittedForm,
  sessionCheckpointFromRunner,
} from "./checkpoint.ts";

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

describe("checkpoint resume helpers", () => {
  const approvalMessages: AgentMessage[] = [
    { role: "user", content: "delete file?" },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call-approval", name: "request_approval", argumentsJson: "{}" }],
    },
    {
      role: "tool",
      content: "Waiting for approval.",
      toolCallId: "call-approval",
      name: "request_approval",
      metadata: {
        awaitingUserInput: true,
        stopReason: "awaiting_approval",
        approvalId: "approval-1",
        operation: {
          toolName: "delete_file",
          arguments: { path: "tmp.txt" },
        },
      },
    },
  ];

  test("extracts approved operations and projects approved tool results into resumed specs", () => {
    const checkpoint = {
      run_id: "run-approval",
      model: "test-model",
      max_iterations: 5,
      stream: true,
      messages: approvalMessages,
    };

    expect(approvalOperationFromCheckpoint(checkpoint, "approval-1")).toEqual({
      runId: "run-approval",
      toolName: "delete_file",
      arguments: { path: "tmp.txt" },
    });

    expect(resumedSpecFromApprovedToolResult(checkpoint, {
      sessionId: "session-1",
      approvalId: "approval-1",
      content: "deleted",
      metadata: { ok: true },
    })).toMatchObject({
      runId: "run-approval",
      sessionId: "session-1",
      model: "test-model",
      maxIterations: 5,
      stream: true,
      messages: [
        approvalMessages[0],
        approvalMessages[1],
        {
          role: "tool",
          content: "deleted",
          toolCallId: "call-approval",
          name: "request_approval",
          metadata: { ok: true },
        },
      ],
    });
  });

  test("projects denied approvals into resumed specs", () => {
    expect(resumedSpecFromDeniedApproval({
      runId: "run-denied",
      model: "test-model",
      messages: approvalMessages,
    }, {
      sessionId: "session-1",
      approvalId: "approval-1",
    })).toMatchObject({
      runId: "run-denied",
      sessionId: "session-1",
      messages: [
        approvalMessages[0],
        approvalMessages[1],
        {
          role: "tool",
          content: "Approval denied: approval-1",
          toolCallId: "call-approval",
          name: "request_approval",
          metadata: {
            approvalId: "approval-1",
            approved: false,
            status: "denied",
          },
        },
      ],
    });
  });

  test("projects submitted forms into resumed specs", () => {
    const checkpoint = {
      runId: "run-form",
      model: "test-model",
      toolResultBudget: 900,
      messages: [
        { role: "user", content: "book trip" },
        {
          role: "tool",
          content: "Waiting for form submission.",
          toolCallId: "call-form",
          name: "request_form",
          metadata: {
            awaitingUserInput: true,
            stopReason: "awaiting_form",
            formId: "travel_plan",
          },
        },
      ],
    };

    expect(resumedSpecFromSubmittedForm(checkpoint, {
      sessionId: "session-1",
      formId: "travel_plan",
      action: "submitted",
      values: { nights: 3, destination: "Tokyo" },
    })).toMatchObject({
      runId: "run-form",
      sessionId: "session-1",
      model: "test-model",
      toolResultBudget: 900,
      messages: [
        { role: "user", content: "book trip" },
        {
          role: "tool",
          content: "Agent UI form `travel_plan` was submitted for travel_plan.\n\nStructured values:\n```json\n{\"destination\": \"Tokyo\", \"nights\": 3}\n```",
          toolCallId: "call-form",
          name: "request_form",
          metadata: {
            formId: "travel_plan",
            action: "submitted",
            values: { nights: 3, destination: "Tokyo" },
          },
        },
      ],
    });

    expect(resumedSpecFromSubmittedForm(checkpoint, {
      sessionId: "session-1",
      formId: "travel_plan",
      action: "cancelled",
      values: {},
    })).toMatchObject({
      runId: "run-form",
      sessionId: "session-1",
      model: "test-model",
      toolResultBudget: 900,
      messages: [
        { role: "user", content: "book trip" },
        {
          role: "tool",
          content: "Agent UI form `travel_plan` was cancelled by the user for travel_plan.",
          toolCallId: "call-form",
          name: "request_form",
          metadata: {
            formId: "travel_plan",
            action: "cancelled",
            values: {},
          },
        },
      ],
    });
  });

  test("rejects submitted forms with mismatched checkpoint correlation", () => {
    const checkpoint = {
      runId: "run-form",
      model: "test-model",
      messages: [
        { role: "user", content: "book trip" },
        {
          role: "tool",
          content: "Waiting for form submission.",
          toolCallId: "call-form",
          name: "request_form",
          metadata: {
            awaitingUserInput: true,
            stopReason: "awaiting_form",
            formId: "travel_plan",
            correlation: {
              session_key: "websocket:chat-1",
              run_id: "run-form",
              message_id: "message-1",
              interaction_id: "interaction-1",
            },
          },
        },
      ],
    };

    expect(() => resumedSpecFromSubmittedForm(checkpoint, {
      sessionId: "websocket:chat-1",
      formId: "travel_plan",
      action: "submitted",
      values: { destination: "Tokyo" },
      correlation: {
        session_key: "websocket:chat-1",
        run_id: "other-run",
        message_id: "message-1",
        interaction_id: "interaction-1",
      },
    })).toThrow("form correlation mismatch");
  });
});
