import { describe, expect, test } from "vitest";
import {
  MAX_QUEUED_INPUTS,
  deleteQueuedInput,
  dispatchNextQueuedInput,
  pauseQueuedInputs,
  resumeNextQueuedInput,
  submitComposerText,
  updateInterruptStatus,
} from "./chatInputState";
import type { QueuedInput } from "./chatUiProjection";

describe("chat input state", () => {
  test("queues ordinary input while running", () => {
    expect(submitComposerText({
      content: "Summarize after this run.",
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

  test("creates an interrupt-and-new-turn input explicitly", () => {
    expect(submitComposerText({
      content: "Use the new API instead.",
      isRunning: true,
      runningAction: "interrupt",
      queuedInputs: [],
      now: "2026-07-01T10:11:00Z",
    })).toEqual({
      kind: "interrupt_input",
      input: {
        id: "interrupt-2026-07-01T10:11:00Z",
        mode: "interrupt",
        content: "Use the new API instead.",
        createdAt: "2026-07-01T10:11:00Z",
        status: "queued",
      },
    });
  });

  test("enforces five pending inputs", () => {
    const queuedInputs = Array.from({ length: MAX_QUEUED_INPUTS }, (_, index): QueuedInput => ({
      id: `queued-${index}`,
      mode: "queued",
      content: `message ${index}`,
      createdAt: `2026-07-01T10:1${index}:00Z`,
      status: "queued",
    }));

    expect(submitComposerText({
      content: "one too many",
      isRunning: true,
      queuedInputs,
      now: "2026-07-01T10:20:00Z",
    })).toEqual({
      kind: "queue_limit_reached",
      maxQueuedInputs: 5,
      message: "已有 5 条排队消息，请等待处理或删除一条后再发送。",
    });
  });

  test("tracks interrupt handoff before the input is submitted", () => {
    const input: QueuedInput = {
      id: "interrupt-1",
      mode: "interrupt",
      content: "Correct course",
      createdAt: "2026-07-01T10:12:00Z",
      status: "queued",
    };

    expect(updateInterruptStatus([input], input.id, "sent")[0].status).toBe("sent");
    expect(updateInterruptStatus([input], input.id, "failed")[0].status).toBe("failed");
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
