import { describe, expect, test } from "vitest";
import {
  applyLoadedDelegatedAgentTrace,
  projectBackendTimeline,
} from "./chatProjection";
import { normalizeAgentTurnRuntimeStatePayload } from "./chatTimelinePayload";

function canonicalRuntimeState(
  turnId: string,
  items: Array<Record<string, unknown>>,
  sessionId = "WebSocket:chat-1",
  lifecycle: Record<string, unknown> = {},
): unknown {
  return {
    runtimeEvents: [],
    ...lifecycle,
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

describe("chat projection", () => {
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

    const [turn] = projectBackendTimeline("WebSocket:chat-1", [runtimeState]);

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

  test("preserves managed image metadata from persisted user references", () => {
    const runtimeState = normalizeAgentTurnRuntimeStatePayload(canonicalRuntimeState("turn-image", [{
      itemId: "user-image",
      kind: "user_message",
      status: "completed",
      data: {
        type: "user_message",
        messageId: "user-image",
        content: "Describe this image",
        references: [{
          contentHash: "abc123",
          detail: "PNG - 2 KB",
          kind: "reference",
          mimeType: "image/png",
          rawPath: "C:\\Users\\tester\\.tinybot\\chat-attachments\\images\\abc123.png",
          sizeBytes: 2048,
          title: "diagram.png",
          type: "tinyos.image",
        }],
      },
    }]));

    const [turn] = projectBackendTimeline("WebSocket:chat-1", [runtimeState]);

    expect(turn.userMessage.references).toEqual([expect.objectContaining({
      contentHash: "abc123",
      mimeType: "image/png",
      sizeBytes: 2048,
      type: "tinyos.image",
    })]);
  });

  test("projects a persisted data view artifact from a canonical tool result", () => {
    const content = {
      schemaVersion: "tinybot.data_view.v1",
      title: "Quarterly revenue",
      insight: "Revenue increased in Q2.",
      dataset: {
        columns: [
          { key: "quarter", label: "Quarter", type: "category" },
          { key: "revenue", label: "Revenue", type: "number" },
        ],
        rows: [
          { id: "q1", values: { quarter: "Q1", revenue: 100 } },
          { id: "q2", values: { quarter: "Q2", revenue: 120 } },
        ],
      },
      view: { kind: "cartesian", x: "quarter", series: [{ field: "revenue", mark: "bar" }] },
      provenance: { status: "user_provided", sources: [], caveats: [] },
    };
    const runtimeState = normalizeAgentTurnRuntimeStatePayload(canonicalRuntimeState("turn-chart", [{
      itemId: "call-chart",
      kind: "tool_call",
      status: "completed",
      title: "publish_data_view",
      data: {
        type: "tool_call",
        toolCallId: "call-chart",
        name: "publish_data_view",
        status: "completed",
        args: {},
        result: {
          status: "ok",
          artifacts: [{ id: "dv_1", kind: "data_view", title: content.title, content }],
        },
        timing: {},
      },
    }]));

    const [turn] = projectBackendTimeline("WebSocket:chat-1", [runtimeState]);

    expect(turn.steps[0].artifacts?.[0]).toMatchObject({
      id: "dv_1",
      kind: "data_view",
      dataView: { title: "Quarterly revenue", view: { kind: "cartesian" } },
    });
  });

  test("projects a failed data view result as a failed tool step", () => {
    const runtimeState = normalizeAgentTurnRuntimeStatePayload(canonicalRuntimeState("turn-chart-error", [{
      itemId: "call-chart-error",
      kind: "tool_call",
      status: "completed",
      title: "publish_data_view",
      data: {
        type: "tool_call",
        toolCallId: "call-chart-error",
        name: "publish_data_view",
        status: "completed",
        resultStatus: "error",
        args: {},
        result: "publish_data_view cannot be mixed with other tools",
        timing: {},
      },
    }]));

    const [turn] = projectBackendTimeline("WebSocket:chat-1", [runtimeState]);

    expect(turn.steps[0]).toMatchObject({
      kind: "tool_call",
      status: "failed",
      toolCall: { name: "publish_data_view" },
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

    const [turn] = projectBackendTimeline("WebSocket:chat-1", [runtimeState]);

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

  test("preserves backend replay order when persisted source sequences are mixed", () => {
    const runtimeState = normalizeAgentTurnRuntimeStatePayload(canonicalRuntimeState("turn-mixed-sequence", [
      {
        itemId: "call-first",
        sequence: 56,
        kind: "tool_call",
        status: "completed",
        data: {
          type: "tool_call",
          toolCallId: "call-first",
          name: "read_file",
          status: "completed",
          args: { path: "README.md" },
          result: { summary: "first" },
          timing: {},
        },
      },
      {
        itemId: "call-second",
        sequence: 78,
        kind: "tool_call",
        status: "completed",
        data: {
          type: "tool_call",
          toolCallId: "call-second",
          name: "read_file",
          status: "completed",
          args: { path: "Cargo.toml" },
          result: { summary: "second" },
          timing: {},
        },
      },
      {
        itemId: "assistant-final",
        sequence: 55,
        kind: "assistant_message",
        status: "completed",
        data: {
          type: "assistant_message",
          messageId: "assistant-final",
          modelCallId: "call-final",
          phase: "final_answer",
          content: "Done.",
        },
      },
    ]));

    const [turn] = projectBackendTimeline("WebSocket:chat-1", [runtimeState]);

    expect(turn.steps.map((step) => step.id)).toEqual(["call-first", "call-second"]);
    expect(turn.finalAnswer?.text).toBe("Done.");
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

    const [turn] = projectBackendTimeline("WebSocket:chat-1", [runtimeState]);

    expect(turn.steps[0]?.compaction).toEqual({
      contextWindowTokens: 128000,
      droppedItemCount: 0,
      estimatedTokensAfter: 32066,
      estimatedTokensBefore: 48428,
      strategy: "compact",
    });
  });

  test("projects cached input tokens from persisted provider input details", () => {
    const runtimeState = normalizeAgentTurnRuntimeStatePayload(canonicalRuntimeState("turn-cached", [{
      itemId: "turn-cached:usage",
      kind: "usage",
      status: "completed",
      data: {
        type: "usage",
        id: "usage-1",
        inputTokens: 4216,
        outputTokens: 60,
        totalTokens: 4276,
        providerPayload: {
          input_tokens: 4216,
          input_tokens_details: { cached_tokens: 4096 },
          output_tokens: 60,
          total_tokens: 4276,
        },
      },
    }]));

    const [turn] = projectBackendTimeline("WebSocket:chat-1", [runtimeState]);

    expect(turn.usage).toMatchObject({
      cachedTokens: 4096,
      promptTokens: 4216,
    });
  });

  test("uses the completed turn boundary for a restored standalone compaction", () => {
    const runtimeState = normalizeAgentTurnRuntimeStatePayload(canonicalRuntimeState(
      "turn-compact-completed",
      [{
        itemId: "turn-compact-completed:context",
        kind: "context_compaction",
        status: "running",
        data: {
          type: "context_compaction",
          id: "context-1",
          summary: "compact",
          droppedItemCount: 1,
          estimatedTokensBefore: 2889,
          estimatedTokensAfter: 2627,
        },
      }],
      "WebSocket:chat-1",
      {
        status: "completed",
        completedAt: "2026-08-10T13:06:04Z",
        stopReason: "context_compacted",
      },
    ));

    const [turn] = projectBackendTimeline("WebSocket:chat-1", [runtimeState]);

    expect(turn).toMatchObject({
      id: "turn-compact-completed",
      status: "completed",
      completedAt: "2026-08-10T13:06:04Z",
    });
    expect(turn.steps).toEqual([
      expect.objectContaining({ kind: "compaction", status: "completed" }),
    ]);
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

    const [turn] = projectBackendTimeline("WebSocket:chat-1", [runtimeState]);

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

    const turns = projectBackendTimeline("WebSocket:chat-1", [late, early]);

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

    const [turn] = projectBackendTimeline("WebSocket:chat-1", [runtimeState]);

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

});
