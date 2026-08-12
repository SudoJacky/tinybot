import type { QueuedInput } from "./chatUiProjection";

export const MAX_QUEUED_INPUTS = 5;

export type SubmitComposerTextInput = {
  isRunning: boolean;
  content: string;
  queuedInputs: QueuedInput[];
  now: string;
};

export type SubmitComposerTextResult =
  | {
      kind: "queue_input";
      input: QueuedInput;
    }
  | {
      kind: "send_message";
      content: string;
    }
  | {
      kind: "queue_limit_reached";
      maxQueuedInputs: number;
      message: string;
    };

export function submitComposerText(input: SubmitComposerTextInput): SubmitComposerTextResult {
  const content = input.content.trim();
  if (input.isRunning) {
    const pendingCount = input.queuedInputs.filter((queued) => (
      queued.status === "queued" || queued.status === "paused"
    )).length;
    if (pendingCount >= MAX_QUEUED_INPUTS) {
      return {
        kind: "queue_limit_reached",
        maxQueuedInputs: MAX_QUEUED_INPUTS,
        message: "已有 5 条排队消息，请等待处理或删除一条后再发送。",
      };
    }
    return {
      kind: "queue_input",
      input: {
        id: `queued-${input.now}`,
        mode: "queued",
        content,
        createdAt: input.now,
        status: "queued",
      },
    };
  }
  return {
    kind: "send_message",
    content,
  };
}

export function pauseQueuedInputs(inputs: QueuedInput[]): QueuedInput[] {
  return inputs.map((input) => (
    input.mode === "interrupt"
      || input.status === "sent"
      || input.status === "failed"
      ? input
      : { ...input, status: "paused" }
  ));
}

export function resumeNextQueuedInput(inputs: QueuedInput[]): { nextInput?: QueuedInput; remainingInputs: QueuedInput[] } {
  const nextIndex = inputs.findIndex((input) => input.status === "paused" || input.status === "queued");
  if (nextIndex === -1) {
    return { remainingInputs: inputs };
  }
  return {
    nextInput: { ...inputs[nextIndex], status: "queued" },
    remainingInputs: inputs.filter((_, index) => index !== nextIndex),
  };
}

export function dispatchNextQueuedInput(inputs: QueuedInput[]): { nextInput?: QueuedInput; remainingInputs: QueuedInput[] } {
  const nextIndex = inputs.findIndex((input) => input.status === "queued");
  if (nextIndex === -1) {
    return { remainingInputs: inputs };
  }
  return {
    nextInput: { ...inputs[nextIndex], status: "queued" },
    remainingInputs: inputs.filter((_, index) => index !== nextIndex),
  };
}

export function deleteQueuedInput(inputs: QueuedInput[], inputId: string): QueuedInput[] {
  return inputs.filter((input) => input.id !== inputId || (input.mode === "queued" && input.status === "sent"));
}

export function updateInterruptStatus(
  inputs: QueuedInput[],
  inputId: string,
  status: "sent" | "failed",
): QueuedInput[] {
  return inputs.map((input) => {
    if (input.id !== inputId || input.mode !== "interrupt") return input;
    if (status === "sent" && input.status !== "queued") return input;
    return { ...input, status };
  });
}
