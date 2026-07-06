import { describe, expect, test } from "vitest";
import {
  MAX_QUEUED_INPUTS,
  SESSION_APPROVAL_GRANT_POLICY,
  deleteQueuedInput,
  dispatchNextQueuedInput,
  pauseQueuedInputs,
  resolveComposerMode,
  resumeNextQueuedInput,
  submitComposerText,
} from "./chatInputState";
import type { ApprovalRequest, QueuedInput } from "./chatUiProjection";

describe("chat input state", () => {
  test("documents first-version session approval grant lifetime", () => {
    expect(SESSION_APPROVAL_GRANT_POLICY).toEqual({
      scope: "current_session",
      lifetime: "in_memory_session_runtime",
      sharedAcrossSessions: false,
      persistedAcrossRestart: false,
      global: false,
    });
  });

  test("uses approval guidance mode when an approval is pending", () => {
    const approvals = [approval("approval-1")];

    expect(resolveComposerMode({ approvals, isRunning: true })).toBe("approval_guidance");
    expect(submitComposerText({
      content: "Do not write files; summarize only.",
      approvals,
      isRunning: true,
      queuedInputs: [],
      now: "2026-07-01T10:10:00Z",
    })).toEqual({
      kind: "reject_approval_with_guidance",
      approvalId: "approval-1",
      guidance: "Do not write files; summarize only.",
    });
  });

  test("queues ordinary input while running when approval guidance is not active", () => {
    expect(resolveComposerMode({ approvals: [], isRunning: true })).toBe("normal");
    expect(submitComposerText({
      content: "Summarize after this run.",
      approvals: [],
      isRunning: true,
      queuedInputs: [],
      now: "2026-07-01T10:11:00Z",
    })).toEqual({
      kind: "queue_input",
      input: {
        id: "queued-2026-07-01T10:11:00Z",
        mode: "queued",
        content: "Summarize after this run.",
        createdAt: "2026-07-01T10:11:00Z",
        status: "queued",
      },
    });
  });

  test("enforces five queued inputs and does not expose guide input creation", () => {
    const queuedInputs = Array.from({ length: MAX_QUEUED_INPUTS }, (_, index): QueuedInput => ({
      id: `queued-${index}`,
      mode: "queued",
      content: `message ${index}`,
      createdAt: `2026-07-01T10:1${index}:00Z`,
      status: "queued",
    }));

    expect(submitComposerText({
      content: "one too many",
      approvals: [],
      isRunning: true,
      queuedInputs,
      now: "2026-07-01T10:20:00Z",
    })).toEqual({
      kind: "queue_limit_reached",
      maxQueuedInputs: 5,
      message: "已有 5 条排队消息，请等待处理或删除一条后再发送。",
    });
  });

  test("pauses queued input on stop or failure and resumes one item", () => {
    const queuedInputs: QueuedInput[] = [
      {
        id: "queued-1",
        mode: "queued",
        content: "first",
        createdAt: "2026-07-01T10:12:00Z",
        status: "queued",
      },
      {
        id: "queued-2",
        mode: "queued",
        content: "second",
        createdAt: "2026-07-01T10:13:00Z",
        status: "queued",
      },
    ];

    expect(pauseQueuedInputs(queuedInputs)).toEqual([
      { ...queuedInputs[0], status: "paused" },
      { ...queuedInputs[1], status: "paused" },
    ]);
    expect(resumeNextQueuedInput(pauseQueuedInputs(queuedInputs))).toEqual({
      nextInput: { ...queuedInputs[0], status: "queued" },
      remainingInputs: [{ ...queuedInputs[1], status: "paused" }],
    });
  });

  test("dispatches one queued input on normal completion and preserves the rest", () => {
    const queuedInputs = [
      queued("queued-1", "first"),
      queued("queued-2", "second"),
      queued("queued-3", "third"),
    ];

    expect(dispatchNextQueuedInput(queuedInputs)).toEqual({
      nextInput: { ...queuedInputs[0], status: "queued" },
      remainingInputs: [queuedInputs[1], queuedInputs[2]],
    });
  });

  test("deletes an unsent queued input by id", () => {
    const queuedInputs = [
      queued("queued-1", "first"),
      queued("queued-2", "second"),
      { ...queued("queued-3", "third"), status: "sent" as const },
    ];

    expect(deleteQueuedInput(queuedInputs, "queued-2")).toEqual([
      queuedInputs[0],
      queuedInputs[2],
    ]);
    expect(deleteQueuedInput(queuedInputs, "queued-3")).toEqual(queuedInputs);
  });
});

function queued(id: string, content: string): QueuedInput {
  return {
    id,
    mode: "queued",
    content,
    createdAt: "2026-07-01T10:12:00Z",
    status: "queued",
  };
}

function approval(id: string): ApprovalRequest {
  return {
    id,
    sessionKey: "websocket:chat-1",
    toolName: "workspace.write_file",
    status: "pending",
    prompt: "Need approval",
    choices: ["allow_once", "allow_session", "deny"],
  };
}
