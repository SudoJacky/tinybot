import { describe, expect, test } from "vitest";
import { createAgentTimelineModel } from "./agentTimelineModel";

const sessionId = "WebSocket:timeline-test";
const runId = "run-1";

function item(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "tinybot.turn_item.v1",
    itemId: "assistant-1",
    sessionId,
    runId,
    turnId: runId,
    sequence: 4,
    revision: 1,
    kind: "assistant_message",
    status: "running",
    createdAt: "2026-07-11T00:00:00Z",
    data: { type: "assistant_message", messageId: "assistant-1", content: "hel" },
    ...overrides,
  };
}

function runtimeState(
  snapshotRevision = 1,
  items: Array<Record<string, unknown>> = [item()],
) {
  return {
    runtimeEvents: [],
    timeline: {
      schemaVersion: "tinybot.timeline.v1",
      sessionId,
      runId,
      snapshotRevision,
      items,
    },
  };
}

function patch(snapshotRevision: number, itemOverrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "tinybot.timeline_patch.v1",
    sessionId,
    runId,
    snapshotRevision,
    item: item(itemOverrides),
  };
}

describe("canonical agent timeline model", () => {
  test("loads snapshots and applies the next canonical item revision", () => {
    const model = createAgentTimelineModel();
    model.load(sessionId, [runtimeState()]);

    const snapshot = model.applyPatch(sessionId, patch(2, {
      revision: 2,
      status: "completed",
      updatedAt: "2026-07-11T00:00:01Z",
      data: { type: "assistant_message", messageId: "assistant-1", content: "hello" },
    }));

    expect(snapshot.runRevisions).toEqual({ [runId]: 2 });
    expect(snapshot.turns[0]).toMatchObject({
      id: runId,
      status: "completed",
      finalMessage: { id: "assistant-1", text: "hello" },
    });
  });

  test("projects one form lifecycle with validation errors and submitted values", () => {
    const model = createAgentTimelineModel();
    model.load(sessionId, [runtimeState(1, [item({
      itemId: "form-1",
      sequence: 1,
      kind: "form",
      status: "waiting",
      title: "Travel preferences",
      data: {
        type: "form",
        formId: "form-1",
        status: "waiting",
        fieldIds: ["destination"],
        values: null,
        errors: { destination: "Required" },
      },
    })])]);

    const waiting = model.snapshot(sessionId);
    expect(waiting.turns[0].steps[0]).toMatchObject({
      id: "form-1",
      kind: "form",
      status: "blocked",
      form: {
        formId: "form-1",
        fieldIds: ["destination"],
        errors: { destination: "Required" },
      },
    });

    const submitted = model.applyPatch(sessionId, patch(2, {
      itemId: "form-1",
      sequence: 1,
      revision: 2,
      kind: "form",
      status: "completed",
      title: "Travel preferences",
      data: {
        type: "form",
        formId: "form-1",
        status: "completed",
        action: "submit",
        fieldIds: ["destination"],
        values: { destination: "Singapore" },
        errors: {},
      },
    }));
    expect(submitted.turns[0].steps[0]).toMatchObject({
      id: "form-1",
      status: "completed",
      form: {
        formId: "form-1",
        action: "submit",
        values: { destination: "Singapore" },
      },
    });
  });

  test("projects plan current-step and context compaction token details", () => {
    const model = createAgentTimelineModel();
    model.load(sessionId, [runtimeState(2, [
      item({
        itemId: "plan-1",
        sequence: 1,
        kind: "plan_progress",
        status: "running",
        data: {
          type: "plan_progress",
          id: "plan-1",
          summary: "Implement timeline",
          completed: 1,
          total: 3,
          currentStep: "Render plan progress",
          explanation: "Implementation order updated",
          steps: [
            { step: "Inspect timeline model", status: "completed" },
            { step: "Render plan progress", status: "in_progress" },
            { step: "Run focused tests", status: "pending" },
          ],
        },
      }),
      item({
        itemId: "compaction-1",
        sequence: 2,
        kind: "context_compaction",
        status: "completed",
        data: {
          type: "context_compaction",
          id: "compaction-1",
          summary: "compact",
          droppedItemCount: 12,
          estimatedTokensBefore: 12000,
          estimatedTokensAfter: 4200,
        },
      }),
    ])]);

    expect(model.snapshot(sessionId).turns[0].steps).toEqual([
      expect.objectContaining({
        kind: "plan",
        plan: {
          completed: 1,
          currentStep: "Render plan progress",
          explanation: "Implementation order updated",
          steps: [
            { step: "Inspect timeline model", status: "completed" },
            { step: "Render plan progress", status: "in_progress" },
            { step: "Run focused tests", status: "pending" },
          ],
          total: 3,
        },
      }),
      expect.objectContaining({
        compaction: {
          droppedItemCount: 12,
          estimatedTokensAfter: 4200,
          estimatedTokensBefore: 12000,
        },
        kind: "compaction",
      }),
    ]);
  });

  test("rejects canonical plan counters that disagree with the complete step snapshot", () => {
    const model = createAgentTimelineModel();

    expect(() => model.load(sessionId, [runtimeState(1, [item({
      itemId: "plan-invalid",
      sequence: 1,
      kind: "plan_progress",
      status: "running",
      data: {
        type: "plan_progress",
        id: "plan-invalid",
        summary: "Invalid counters",
        completed: 0,
        total: 2,
        currentStep: "Implement plan",
        steps: [
          { step: "Inspect model", status: "completed" },
          { step: "Implement plan", status: "in_progress" },
        ],
      },
    })])])).toThrow("progress counters do not match its steps");
  });

  test("attaches parented errors to their owning canonical step", () => {
    const model = createAgentTimelineModel();
    model.load(sessionId, [runtimeState(2, [
      item({
        itemId: "tool-1",
        sequence: 1,
        kind: "tool_call",
        status: "failed",
        data: {
          type: "tool_call",
          toolCallId: "tool-1",
          name: "workspace.read_file",
          status: "failed",
          args: { path: "missing.md" },
          result: null,
          timing: {},
        },
      }),
      item({
        itemId: "error-1",
        parentItemId: "tool-1",
        sequence: 2,
        kind: "error",
        status: "failed",
        data: {
          type: "error",
          id: "error-1",
          code: "not_found",
          message: "missing.md does not exist",
          cancelled: false,
        },
      }),
    ])]);

    expect(model.snapshot(sessionId).turns[0].steps).toEqual([
      expect.objectContaining({
        id: "tool-1",
        scopedErrors: [{ code: "not_found", message: "missing.md does not exist", cancelled: false }],
      }),
    ]);
  });

  test("rejects gaps, equal-revision conflicts, and terminal regressions", () => {
    const model = createAgentTimelineModel();
    model.load(sessionId, [runtimeState()]);

    expect(() => model.applyPatch(sessionId, patch(3, { revision: 2 })))
      .toThrow("patch gap");

    expect(() => model.applyPatch(sessionId, patch(1, {
      data: { type: "assistant_message", messageId: "assistant-1", content: "conflict" },
    }))).toThrow("equal-revision conflict");

    model.applyPatch(sessionId, patch(2, { revision: 2, status: "completed" }));
    expect(() => model.applyPatch(sessionId, patch(3, { revision: 3, status: "running" })))
      .toThrow("cannot transition from completed to running");
  });

  test("ignores a lower item revision but advances the run cursor with a diagnostic", () => {
    const model = createAgentTimelineModel();
    model.load(sessionId, [runtimeState(2, [item({ revision: 2 })])]);

    const snapshot = model.applyPatch(sessionId, patch(3, { revision: 1 }));

    expect(snapshot.runRevisions).toEqual({ [runId]: 3 });
    expect(snapshot.diagnostics).toMatchObject([{
      code: "lower_item_revision",
      itemId: "assistant-1",
      receivedRevision: 1,
    }]);
  });

  test("fails visibly for malformed canonical schemas instead of falling back", () => {
    const model = createAgentTimelineModel();
    expect(() => model.load(sessionId, [{ timeline: { schemaVersion: "legacy", items: [] } }]))
      .toThrow("Unsupported canonical timeline schema");
  });

  test("produces the same visible timeline from live patches and a reloaded snapshot", () => {
    const canonicalItem = (
      itemId: string,
      sequence: number,
      revision: number,
      kind: string,
      status: string,
      data: Record<string, unknown>,
      extra: Record<string, unknown> = {},
    ) => ({
      schemaVersion: "tinybot.turn_item.v1",
      itemId,
      sessionId,
      runId,
      turnId: runId,
      sequence,
      revision,
      kind,
      status,
      createdAt: `2026-07-11T00:00:${String(sequence).padStart(2, "0")}Z`,
      data,
      ...extra,
    });
    const mutations = [
      canonicalItem("user-1", 1, 1, "user_message", "completed", {
        type: "user_message",
        messageId: "user-1",
        clientEventId: "client-message-1",
        content: "Complete the acceptance path",
      }),
      canonicalItem("reasoning-1", 2, 1, "reasoning", "running", {
        type: "reasoning",
        summary: "Inspecting",
      }),
      canonicalItem("reasoning-1", 2, 2, "reasoning", "completed", {
        type: "reasoning",
        summary: "Inspection complete",
      }),
      canonicalItem("tool-1", 4, 1, "tool_call", "running", {
        type: "tool_call",
        toolCallId: "tool-1",
        name: "workspace.read_file",
        status: "running",
        args: { path: "README.md" },
        result: null,
        timing: {},
      }),
      canonicalItem("tool-1", 4, 2, "tool_call", "completed", {
        type: "tool_call",
        toolCallId: "tool-1",
        name: "workspace.read_file",
        status: "completed",
        args: { path: "README.md" },
        result: { summary: "README loaded" },
        timing: {},
      }),
      canonicalItem("approval-1", 6, 1, "approval", "waiting", {
        type: "approval",
        approvalId: "approval-1",
        toolCallId: "tool-1",
        status: "waiting",
        reason: "Confirm read",
      }),
      canonicalItem("approval-1", 6, 2, "approval", "completed", {
        type: "approval",
        approvalId: "approval-1",
        toolCallId: "tool-1",
        status: "completed",
        decision: "approved",
      }),
      canonicalItem("plan-1", 8, 1, "plan_progress", "running", {
        type: "plan_progress",
        id: "plan-1",
        summary: "Finish acceptance",
        completed: 1,
        total: 2,
        currentStep: "Finish acceptance",
        steps: [
          { step: "Inspect implementation", status: "completed" },
          { step: "Finish acceptance", status: "in_progress" },
        ],
      }),
      canonicalItem("plan-1", 8, 2, "plan_progress", "completed", {
        type: "plan_progress",
        id: "plan-1",
        summary: "Acceptance finished",
        completed: 2,
        total: 2,
        explanation: "All acceptance checks passed.",
        steps: [
          { step: "Inspect implementation", status: "completed" },
          { step: "Finish acceptance", status: "completed" },
        ],
      }),
      canonicalItem("file-1", 10, 1, "file_reference", "completed", {
        type: "file_reference",
        id: "file-1",
        path: "output/report.md",
        mimeType: "text/markdown",
        referenceKind: "file",
      }, { parentItemId: "tool-1" }),
      canonicalItem("usage-1", 11, 1, "usage", "completed", {
        type: "usage",
        id: "usage-1",
        inputTokens: 100,
        outputTokens: 25,
        totalTokens: 125,
        providerPayload: {},
      }),
      canonicalItem("assistant-1", 12, 1, "assistant_message", "completed", {
        type: "assistant_message",
        messageId: "assistant-1",
        content: "Acceptance complete",
      }),
    ];

    const liveModel = createAgentTimelineModel();
    liveModel.load(sessionId, []);
    let live = liveModel.snapshot(sessionId);
    mutations.forEach((mutation, index) => {
      live = liveModel.applyPatch(sessionId, {
        schemaVersion: "tinybot.timeline_patch.v1",
        sessionId,
        runId,
        snapshotRevision: index + 1,
        item: mutation,
      });
    });

    const latestById = new Map<string, Record<string, unknown>>();
    mutations.forEach((mutation) => latestById.set(String(mutation.itemId), mutation));
    const reloadModel = createAgentTimelineModel();
    const reloaded = reloadModel.load(sessionId, [runtimeState(
      mutations.length,
      [...latestById.values()].sort((left, right) => Number(left.sequence) - Number(right.sequence)),
    )]);

    expect(live).toEqual(reloaded);
    expect(live.runRevisions).toEqual({ [runId]: 12 });
    expect(live.turns[0]).toMatchObject({
      id: runId,
      status: "completed",
      userMessage: { clientEventId: "client-message-1", id: "user-1" },
      finalMessage: { id: "assistant-1", text: "Acceptance complete" },
      usage: { promptTokens: 100, completionTokens: 25, totalTokens: 125 },
    });
    expect(live.turns[0].steps.map((step) => [step.id, step.status])).toEqual([
      ["reasoning-1", "completed"],
      ["tool-1", "completed"],
      ["approval-1", "completed"],
      ["plan-1", "completed"],
    ]);
  });
});
