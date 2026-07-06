import type { ApprovalRequest, QueuedInput } from "./chatUiProjection";

export const MAX_QUEUED_INPUTS = 5;

export const SESSION_APPROVAL_GRANT_POLICY = {
  scope: "current_session",
  lifetime: "in_memory_session_runtime",
  sharedAcrossSessions: false,
  persistedAcrossRestart: false,
  global: false,
} as const;

export type ComposerMode = "normal" | "approval_guidance";

export type ComposerModeInput = {
  approvals: ApprovalRequest[];
  isRunning: boolean;
};

export type SubmitComposerTextInput = ComposerModeInput & {
  content: string;
  queuedInputs: QueuedInput[];
  now: string;
};

export type SubmitComposerTextResult =
  | {
      kind: "reject_approval_with_guidance";
      approvalId: string;
      guidance: string;
    }
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

export function resolveComposerMode(input: ComposerModeInput): ComposerMode {
  return input.approvals.some((approval) => approval.status === "pending") ? "approval_guidance" : "normal";
}

export function submitComposerText(input: SubmitComposerTextInput): SubmitComposerTextResult {
  const content = input.content.trim();
  const pendingApproval = input.approvals.find((approval) => approval.status === "pending");
  if (pendingApproval) {
    return {
      kind: "reject_approval_with_guidance",
      approvalId: pendingApproval.id,
      guidance: content,
    };
  }
  if (input.isRunning) {
    if (input.queuedInputs.length >= MAX_QUEUED_INPUTS) {
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
  return inputs.map((input) => input.status === "sent" || input.status === "guided" ? input : { ...input, status: "paused" });
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
  return inputs.filter((input) => input.id !== inputId || input.status === "sent" || input.status === "guided");
}
