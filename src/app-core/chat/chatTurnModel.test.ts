import { describe, expect, test } from "vitest";
import {
  applyLoadedDelegatedAgentTrace,
  backendRuntimeStatesToTurns,
  normalizeAgentTurnRuntimeStatePayload,
  redactedPreview,
  safeArtifactPreview,
} from "./chatTurnModel";

function canonicalRuntimeState(
  turnId: string,
  items: Array<Record<string, unknown>>,
  sessionId = "WebSocket:chat-1",
): unknown {
  return {
    runtimeEvents: [],
    timeline: {
      schemaVersion: "tinybot.timeline.v2",
      sessionId,
      turnId,
      snapshotRevision: items.length,
      items: items.map((item, index) => ({
        schemaVersion: "tinybot.turn_item.v2",
        itemId: `${turnId}:item:${index + 1}`,
        sessionId,
        turnId,
        sequence: index + 1,
        revision: 1,
        createdAt: `2026-07-03T01:00:0${index}Z`,
        ...item,
      })),
    },
  };
}

describe("chat turn model", () => {
  test("projects canonical messages, tools, and references into a chat turn", () => {
    const runtimeState = normalizeAgentTurnRuntimeStatePayload(canonicalRuntimeState("turn-1", [
      {
        itemId: "user-1",
        kind: "user_message",
        status: "completed",
        data: {
          type: "user_message",
          messageId: "user-1",
          content: "Check the README",
          references: [{
            detail: "TinyOS file selection",
            evidenceId: "item-file-1",
            kind: "reference",
            sourceLine: 2,
            sourcePath: "README.md",
            sourceText: "# Tinybot",
            title: "README.md · L2",
            type: "tinyos.file",
          }],
        },
      },
      {
        itemId: "reasoning-1",
        kind: "reasoning",
        status: "completed",
        summary: "Need to inspect files.",
        data: { type: "reasoning", modelCallId: "call-0", summary: "Need to inspect files." },
      },
      {
        itemId: "call-read",
        kind: "tool_call",
        status: "completed",
        title: "read_file",
        summary: "README contents",
        data: {
          type: "tool_call",
          toolCallId: "call-read",
          name: "read_file",
          status: "completed",
          args: { path: "README.md" },
          result: { summary: "README contents" },
          detailId: "tool:call-read",
          timing: {},
        },
      },
    ]));

    const [turn] = backendRuntimeStatesToTurns("WebSocket:chat-1", [runtimeState]);

    expect(turn).toMatchObject({
      id: "turn-1",
      status: "running",
      userMessage: {
        references: [expect.objectContaining({ evidenceId: "item-file-1", sourcePath: "README.md" })],
        text: "Check the README",
      },
    });
    expect(turn.steps.map((step) => [step.kind, step.title, step.status])).toEqual([
      ["reasoning", "Thinking complete", "completed"],
      ["tool_call", "read_file", "completed"],
    ]);
    expect(turn.steps[1].toolCall).toMatchObject({
      id: "call-read",
      name: "read_file",
      resultPreview: "README contents",
    });
  });

  test("restores completed assistant messages from the canonical timeline", () => {
    const runtimeState = normalizeAgentTurnRuntimeStatePayload(canonicalRuntimeState("turn-completed", [
      {
        itemId: "turn-completed:user",
        kind: "user_message",
        status: "completed",
        data: {
          type: "user_message",
          messageId: "user-completed",
          content: "Say hello",
        },
      },
      {
        itemId: "turn-completed:assistant",
        kind: "assistant_message",
        status: "completed",
        data: {
          type: "assistant_message",
          messageId: "assistant-completed",
          modelCallId: "call-0",
          phase: "final_answer",
          content: "Hello",
        },
      },
    ]));

    const [turn] = backendRuntimeStatesToTurns("WebSocket:chat-1", [runtimeState]);

    expect(turn).toMatchObject({
      id: "turn-completed",
      status: "completed",
      userMessage: { text: "Say hello" },
      finalAnswer: {
        id: "assistant-completed",
        text: "Hello",
      },
    });
  });

  test("preserves the context window budget from a restored compaction item", () => {
    const runtimeState = normalizeAgentTurnRuntimeStatePayload(canonicalRuntimeState("turn-compacted", [{
      itemId: "turn-compacted:context",
      kind: "context_compaction",
      status: "completed",
      data: {
        type: "context_compaction",
        id: "context-1",
        summary: "compact",
        droppedItemCount: 0,
        contextWindowTokens: 128000,
        strategy: "compact",
        estimatedTokensBefore: 48428,
        estimatedTokensAfter: 32066,
      },
    }]));

    const [turn] = backendRuntimeStatesToTurns("WebSocket:chat-1", [runtimeState]);

    expect(turn.steps[0]?.compaction).toEqual({
      contextWindowTokens: 128000,
      droppedItemCount: 0,
      estimatedTokensAfter: 32066,
      estimatedTokensBefore: 48428,
      strategy: "compact",
    });
  });

  test("reconciles stale running steps when a canonical turn fails", () => {
    const runtimeState = normalizeAgentTurnRuntimeStatePayload(canonicalRuntimeState("turn-failed", [
      {
        itemId: "turn-failed:user",
        kind: "user_message",
        status: "completed",
        data: { type: "user_message", messageId: "user-failed", content: "Run the plan" },
      },
      {
        itemId: "turn-failed:plan",
        kind: "plan_progress",
        status: "running",
        data: {
          type: "plan_progress",
          completed: 0,
          total: 2,
          currentStep: "Inspect inputs",
          steps: [
            { step: "Inspect inputs", status: "in_progress" },
            { step: "Report findings", status: "pending" },
          ],
        },
      },
      {
        itemId: "turn-failed:tool",
        kind: "tool_call",
        status: "running",
        title: "update_plan",
        data: { type: "tool_call", toolCallId: "call-plan", name: "update_plan", status: "running" },
      },
      {
        itemId: "turn-failed:error",
        kind: "error",
        status: "failed",
        data: { type: "error", code: "max_iterations", message: "Iteration limit reached" },
      },
    ]));

    const [turn] = backendRuntimeStatesToTurns("WebSocket:chat-1", [runtimeState]);

    expect(turn.status).toBe("failed");
    expect(turn.steps.find((step) => step.kind === "plan")).toMatchObject({
      status: "failed",
      plan: {
        currentStep: undefined,
        steps: [
          { step: "Inspect inputs", status: "failed" },
          { step: "Report findings", status: "cancelled" },
        ],
      },
    });
    expect(turn.steps.find((step) => step.kind === "tool_call")?.status).toBe("failed");
    expect(turn.steps.some((step) => step.status === "running" || step.status === "pending")).toBe(false);
  });

  test("orders restored turns by their canonical timestamps", () => {
    const early = normalizeAgentTurnRuntimeStatePayload(canonicalRuntimeState("z-turn-early", [{
      itemId: "z-turn-early:user",
      kind: "user_message",
      status: "completed",
      createdAt: "1782961828408",
      data: { type: "user_message", messageId: "user-early", content: "first restored prompt" },
    }]));
    const late = normalizeAgentTurnRuntimeStatePayload(canonicalRuntimeState("a-turn-late", [{
      itemId: "a-turn-late:user",
      kind: "user_message",
      status: "completed",
      createdAt: "1782961829408",
      data: { type: "user_message", messageId: "user-late", content: "second restored prompt" },
    }]));

    const turns = backendRuntimeStatesToTurns("WebSocket:chat-1", [late, early]);

    expect(turns.map((turn) => turn.id)).toEqual(["z-turn-early", "a-turn-late"]);
  });

  test("projects canonical subagent lifecycle and user-visible messages", () => {
    const runtimeState = normalizeAgentTurnRuntimeStatePayload(canonicalRuntimeState("turn-delegate", [
      {
        itemId: "turn-delegate:user",
        kind: "user_message",
        status: "completed",
        data: { type: "user_message", messageId: "user-delegate", content: "Review this change" },
      },
      {
        itemId: "delegate-1",
        kind: "subagent_lifecycle",
        status: "running",
        title: "Reviewer",
        data: {
          type: "subagent_lifecycle",
          agentId: "subagent-1",
          action: "started",
          status: "running",
          task: "Review implementation",
          traceRef: "trace:subagent-1",
        },
      },
      {
        itemId: "delegate-message-1",
        kind: "subagent_message",
        status: "completed",
        data: {
          type: "subagent_message",
          agentId: "subagent-1",
          messageId: "delegate-message-1",
          content: "Review complete",
          visibility: "user",
        },
      },
    ]));

    const [turn] = backendRuntimeStatesToTurns("WebSocket:chat-1", [runtimeState]);

    expect(turn.steps[0]).toMatchObject({
      kind: "delegate",
      delegate: {
        id: "subagent-1",
        status: "running",
        task: "Review implementation",
        traceRef: "trace:subagent-1",
        type: "subagent",
      },
    });
    expect(turn.steps[1]).toMatchObject({
      kind: "message",
      summary: "Review complete",
    });
  });

  test("loads an authoritative trace into a canonical subagent projection", () => {
    const delegate = {
      id: "subagent-1",
      status: "running" as const,
      task: "Review implementation",
      title: "Reviewer",
      type: "subagent" as const,
    };

    const loaded = applyLoadedDelegatedAgentTrace(delegate, {
      trace: {
        delegate_id: "subagent-1",
        final_output: "Looks good",
        status: "completed",
        steps: [{
          id: "trace-step-1",
          kind: "tool_call",
          status: "completed",
          title: "Read files",
          summary: "Inspected implementation",
        }],
        final_message: {
          id: "child-final",
          content: "Looks good",
        },
      },
    });

    expect(loaded).toMatchObject({
      finalOutput: "Looks good",
      status: "completed",
      trace: {
        delegateId: "subagent-1",
        finalMessage: { id: "child-final", text: "Looks good" },
        steps: [{ id: "trace-step-1", status: "completed" }],
      },
    });
  });

  test("redacts sensitive fields and renders unsafe artifact payloads inertly", () => {
    expect(redactedPreview({
      authorization: "Bearer token",
      nested: { password: "hunter2", safe: "value" },
    })).toBe('{"authorization":"[redacted]","nested":{"password":"[redacted]","safe":"value"}}');
    expect(safeArtifactPreview({
      html: "<script>alert(1)</script>",
      safe: "value",
      token: "secret",
    })).toBe('{"html":"[unsafe omitted]","safe":"value","token":"[redacted]"}');
  });
});
