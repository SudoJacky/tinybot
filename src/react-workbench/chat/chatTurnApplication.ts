import type { TFunction } from "i18next";
import type { AgentUiForm } from "../../app-core/agent-ui/agentUiEvents";
import type { ChatTimelineSnapshot } from "../../app-core/chat/agentTimelineModel";
import {
  MAX_QUEUED_INPUTS, deleteQueuedInput, dispatchNextQueuedInput,
  pauseQueuedInputs, resumeNextQueuedInput, updateInterruptStatus,
} from "../../app-core/chat/chatInputState";
import {
  THREAD_COMMAND_ACK_TIMEOUT_MS, canonicalThreadCommandAcknowledgement,
  canonicalThreadCommandCompletion, createThreadAgentCancelCommand,
  createThreadFormCancelCommand, createThreadFormSubmitCommand,
  isThreadCommandInFlight, reduceThreadCommandLifecycle,
  type ThreadCommand, type ThreadCommandLifecycle, type ThreadCommandLifecycleAction,
} from "../../app-core/chat/threadCommand";
import type { ThreadEffectiveCapabilities } from "../../app-core/chat/threadCapabilities";
import type { ChatEvent, ChatInput, ChatStore, SessionSummary } from "../services";
import { canDispatchQueuedInput, projectChatEventEffects } from "./chatEventPolicy";
import type { QueuedComposerInput } from "./chatSubmission";

type Dependencies = {
  dispatch: ChatStore["dispatch"];
  submitTurn(sessionId: string, input: ChatInput, control: string): Promise<void>;
  refreshSessions(): Promise<SessionSummary[]>;
  reportError(error: string, sessionId: string): void;
  clearError(): void;
  now(): number;
  t: TFunction<"chat">;
};

export type ChatQueueSnapshot = {
  inputs: QueuedComposerInput[];
  message: string;
};

export type ChatTurnSnapshot = {
  lifecycle: ThreadCommandLifecycle;
  canCancel: boolean;
  cancelUnavailableReason: string;
  canInterrupt: boolean;
};

const EMPTY_QUEUE: ChatQueueSnapshot = { inputs: [], message: "" };
const EMPTY_TURN: ChatTurnSnapshot = {
  lifecycle: { stage: "idle" }, canCancel: false, cancelUnavailableReason: "", canInterrupt: false,
};
type Context = { timeline: ChatTimelineSnapshot | null; capabilities: ThreadEffectiveCapabilities };
type Interrupt = { inputId: string; cancellationAccepted: boolean; terminalReceived: boolean; dispatching: boolean };

/** Owns client command/queue state; canonical turns remain owned by the Timeline model. */
export function createChatTurnApplication(deps: Dependencies) {
  const queues = new Map<string, ChatQueueSnapshot>();
  const turns = new Map<string, ChatTurnSnapshot>();
  const contexts = new Map<string, Context>();
  const interrupts = new Map<string, Interrupt>();
  const dispatchingQueues = new Set<string>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const listeners = new Set<() => void>();
  let sequence = 0;

  const queue = (sessionId: string) => queues.get(sessionId) ?? EMPTY_QUEUE;
  const turn = (sessionId: string) => turns.get(sessionId) ?? EMPTY_TURN;
  const notify = () => listeners.forEach((listener) => listener());
  const activeTurn = (sessionId: string) => [...(contexts.get(sessionId)?.timeline?.turns ?? [])]
    .reverse().find((candidate) => ["pending", "running", "awaiting_user"].includes(candidate.status));

  function publishQueue(sessionId: string, inputs: QueuedComposerInput[], message = queue(sessionId).message) {
    const previous = queue(sessionId);
    if (previous.inputs === inputs && previous.message === message) return;
    queues.set(sessionId, { inputs, message });
    notify();
  }

  function publishTurn(sessionId: string, lifecycle = turn(sessionId).lifecycle) {
    const context = contexts.get(sessionId);
    const active = activeTurn(sessionId);
    const capabilities = context?.capabilities;
    const matchesTurn = !capabilities?.evaluatedTurnId || capabilities.evaluatedTurnId === active?.id;
    const next: ChatTurnSnapshot = {
      lifecycle,
      canCancel: Boolean(active && capabilities?.threadId === sessionId
        && matchesTurn && capabilities.capabilities.agent.cancel.available),
      cancelUnavailableReason: !matchesTurn
        ? deps.t("runtime.staleCapabilities")
        : capabilities?.capabilities.agent.cancel.reason || deps.t("runtime.cancelUnavailable"),
      canInterrupt: Boolean(active && active.status !== "awaiting_user" && !isThreadCommandInFlight(lifecycle)),
    };
    const previous = turn(sessionId);
    if (previous.lifecycle === next.lifecycle && previous.canCancel === next.canCancel
      && previous.cancelUnavailableReason === next.cancelUnavailableReason
      && previous.canInterrupt === next.canInterrupt) return;
    turns.set(sessionId, next);
    notify();
  }

  function transition(sessionId: string, action: ThreadCommandLifecycleAction) {
    const previous = turn(sessionId).lifecycle;
    const next = reduceThreadCommandLifecycle(previous, action);
    if (next === previous) return;
    clearTimeout(timers.get(sessionId));
    timers.delete(sessionId);
    publishTurn(sessionId, next);
    if (next.stage === "sending" || next.stage === "waiting_for_canonical") {
      timers.set(sessionId, setTimeout(() => {
        transition(sessionId, { commandId: next.command.commandId, type: "ack_timeout" });
      }, Math.max(0, THREAD_COMMAND_ACK_TIMEOUT_MS - Math.max(0, deps.now() - next.dispatchedAtMs))));
    }
    if (next.stage === "rejected" || next.stage === "timed_out") {
      console.error("[chat-turn] command.failed", {
        sessionId, commandId: next.command.commandId, kind: next.command.kind, stage: next.stage, error: next.error,
      });
      if (next.command.kind === "operation.retry") deps.reportError(`Retry failed: ${next.error}`, sessionId);
      if (next.command.kind === "form.submit" || next.command.kind === "form.cancel") {
        deps.reportError(`Form ${next.command.kind === "form.cancel" ? "cancellation" : "submission"} failed: ${next.error}`, sessionId);
      }
    }
  }

  function acknowledge(sessionId: string) {
    const timeline = contexts.get(sessionId)?.timeline;
    let lifecycle = turn(sessionId).lifecycle;
    if (!timeline || lifecycle.stage === "idle" || lifecycle.stage === "completed") return;
    if (lifecycle.stage !== "acknowledged") {
      const acknowledgement = canonicalThreadCommandAcknowledgement(timeline.turns, lifecycle.command.commandId);
      if (acknowledgement) transition(sessionId, {
        acknowledgement, commandId: lifecycle.command.commandId, nowMs: deps.now(), type: "canonical_acknowledged",
      });
    }
    lifecycle = turn(sessionId).lifecycle;
    if (lifecycle.stage !== "acknowledged") return;
    const completion = canonicalThreadCommandCompletion(timeline.turns, lifecycle.command);
    if (completion) transition(sessionId, {
      completion, commandId: lifecycle.command.commandId, nowMs: deps.now(), type: "operation_completed",
    });
  }

  function pause(sessionId: string) {
    const inputs = queue(sessionId).inputs;
    if (inputs.some((input) => input.mode === "queued" && input.status === "queued")) {
      publishQueue(sessionId, pauseQueuedInputs(inputs) as QueuedComposerInput[]);
    }
  }

  function remove(sessionId: string, inputId: string) {
    publishQueue(sessionId, deleteQueuedInput(queue(sessionId).inputs, inputId) as QueuedComposerInput[], "");
  }

  function failQueue(sessionId: string, operation: string, error: unknown, inputId?: string) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[chat-turn] ${operation}.failed`, { sessionId, inputId, error: message });
    publishQueue(sessionId, queue(sessionId).inputs, operation === "interrupt"
      ? deps.t("errors.interruptFailed", { message }) : message);
  }

  async function dispatchCommand(command: ThreadCommand) {
    const sessionId = command.target.sessionId;
    transition(sessionId, { command, nowMs: deps.now(), type: "dispatch" });
    try {
      await deps.dispatch(command);
      acknowledge(sessionId);
    } catch (error) {
      transition(sessionId, {
        commandId: command.commandId, error: error instanceof Error ? error.message : String(error), type: "rejected",
      });
    }
  }

  async function sendNext(sessionId: string, mode: "normal_completion" | "manual_resume") {
    if (dispatchingQueues.has(sessionId)) return;
    const inputs = queue(sessionId).inputs;
    const result = mode === "manual_resume" ? resumeNextQueuedInput(inputs) : dispatchNextQueuedInput(inputs);
    if (!result.nextInput) return;
    const input = result.nextInput as QueuedComposerInput;
    dispatchingQueues.add(sessionId);
    // Reserve synchronously: terminal events and user actions may arrive while submitting.
    publishQueue(sessionId, inputs.map((candidate) => candidate.id === input.id ? { ...candidate, status: "sent" } : candidate), "");
    try {
      await deps.submitTurn(sessionId, input.turnInput, `queue-${mode}`);
      publishQueue(sessionId, queue(sessionId).inputs.filter((candidate) => candidate.id !== input.id));
      await deps.refreshSessions();
    } catch (error) {
      publishQueue(sessionId, queue(sessionId).inputs.map((candidate) => candidate.id === input.id
        ? { ...candidate, status: "paused" } : candidate));
      failQueue(sessionId, "queue.submit", error, input.id);
    } finally {
      dispatchingQueues.delete(sessionId);
    }
  }

  async function sendInterrupt(sessionId: string, terminalReceived = false): Promise<boolean> {
    const pending = interrupts.get(sessionId);
    if (!pending) return false;
    pending.terminalReceived ||= terminalReceived;
    if (!pending.cancellationAccepted || !pending.terminalReceived || pending.dispatching) return true;
    const input = queue(sessionId).inputs.find((candidate) => candidate.id === pending.inputId);
    if (!input) { interrupts.delete(sessionId); return false; }
    pending.dispatching = true;
    publishQueue(sessionId, updateInterruptStatus(queue(sessionId).inputs, input.id, "sent") as QueuedComposerInput[]);
    try {
      await deps.submitTurn(sessionId, input.turnInput, "interrupt-new-turn");
      remove(sessionId, input.id);
      await deps.refreshSessions();
    } catch (error) {
      publishQueue(sessionId, updateInterruptStatus(queue(sessionId).inputs, input.id, "failed") as QueuedComposerInput[]);
      failQueue(sessionId, "interrupt", error, input.id);
    } finally {
      interrupts.delete(sessionId);
    }
    return true;
  }

  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    queue,
    turn,
    observe(sessionId: string, context: Context) {
      if (!sessionId) return;
      if (context.timeline && context.timeline.sessionId !== sessionId) return;
      contexts.set(sessionId, context);
      publishTurn(sessionId);
      acknowledge(sessionId);
    },
    receiveTimeline(sessionId: string, timeline: ChatTimelineSnapshot) {
      const context = contexts.get(sessionId);
      if (!context) return;
      if (timeline.sessionId !== sessionId) throw new Error(`Timeline session ${timeline.sessionId} does not match ${sessionId}`);
      contexts.set(sessionId, { ...context, timeline });
      publishTurn(sessionId);
      acknowledge(sessionId);
    },
    nextInputTimestamp() { return new Date(deps.now() + sequence++).toISOString(); },
    enqueue(sessionId: string, input: QueuedComposerInput) {
      const inputs = queue(sessionId).inputs;
      if (inputs.filter((candidate) => candidate.status === "queued" || candidate.status === "paused").length >= MAX_QUEUED_INPUTS) {
        publishQueue(sessionId, inputs, deps.t("queue.limit", { count: MAX_QUEUED_INPUTS }));
        return;
      }
      publishQueue(sessionId, [...inputs, input], "");
    },
    reportQueueLimit(sessionId: string) {
      publishQueue(sessionId, queue(sessionId).inputs, deps.t("queue.limit", { count: MAX_QUEUED_INPUTS }));
    },
    replaceSession(previousSessionId: string, sessionId: string) {
      const previous = queues.get(previousSessionId);
      if (!previous) return;
      queues.delete(previousSessionId);
      queues.set(sessionId, previous);
      notify();
    },
    forgetSession(sessionId: string) {
      clearTimeout(timers.get(sessionId));
      timers.delete(sessionId);
      queues.delete(sessionId);
      turns.delete(sessionId);
      contexts.delete(sessionId);
      interrupts.delete(sessionId);
      notify();
    },
    remove,
    resume(sessionId: string) { return sendNext(sessionId, "manual_resume"); },
    async cancel(sessionId: string) {
      if (isThreadCommandInFlight(turn(sessionId).lifecycle)) return;
      if (!turn(sessionId).canCancel) { deps.reportError(`Cannot cancel: ${turn(sessionId).cancelUnavailableReason}`, sessionId); return; }
      const active = activeTurn(sessionId);
      if (!active) throw new Error("Cannot cancel: the session has no active turn");
      pause(sessionId);
      await dispatchCommand(createThreadAgentCancelCommand({
        sessionId, turnId: active.id, threadId: active.canonicalItems?.find((item) => item.threadId)?.threadId,
        source: { control: "stop-response", surface: "chat" },
      }));
    },
    async interrupt(sessionId: string, inputId: string) {
      publishQueue(sessionId, queue(sessionId).inputs, "");
      const active = activeTurn(sessionId);
      if (!active || active.status === "awaiting_user") {
        publishQueue(sessionId, queue(sessionId).inputs, deps.t("errors.noInterruptibleTurn")); return;
      }
      if (interrupts.has(sessionId) || isThreadCommandInFlight(turn(sessionId).lifecycle)) {
        publishQueue(sessionId, queue(sessionId).inputs, deps.t("errors.interruptPending")); return;
      }
      const input = queue(sessionId).inputs.find((candidate) => candidate.id === inputId
        && candidate.mode === "queued" && (candidate.status === "queued" || candidate.status === "paused"));
      try {
        if (!input) throw new Error(`Queued input ${inputId} is no longer available`);
        const pending: Interrupt = { inputId, cancellationAccepted: false, terminalReceived: false, dispatching: false };
        interrupts.set(sessionId, pending);
        publishQueue(sessionId, queue(sessionId).inputs.map((candidate) => candidate.id === inputId
          ? { ...candidate, mode: "interrupt", status: "queued" } : candidate));
        await deps.dispatch(createThreadAgentCancelCommand({
          sessionId, turnId: active.id, source: { control: "composer-interrupt", surface: "chat" },
        }));
        pending.cancellationAccepted = true;
        await sendInterrupt(sessionId);
      } catch (error) {
        interrupts.delete(sessionId);
        publishQueue(sessionId, updateInterruptStatus(queue(sessionId).inputs, inputId, "failed") as QueuedComposerInput[]);
        failQueue(sessionId, "interrupt", error, inputId);
      }
    },
    async submitForm(sessionId: string, form: AgentUiForm, values?: Record<string, unknown>) {
      if (!sessionId || isThreadCommandInFlight(turn(sessionId).lifecycle)) return;
      const active = activeTurn(sessionId);
      const cancelling = values === undefined;
      if (!active) {
        deps.reportError(deps.t(cancelling ? "runtime.cancelFormTurnUnavailable" : "runtime.submitFormTurnUnavailable"), sessionId); return;
      }
      const formTurnId = correlation(form, "turn_id") || form.turn_id || active.id;
      if (formTurnId !== active.id) {
        deps.reportError(deps.t(cancelling ? "runtime.cancelFormStaleTurn" : "runtime.submitFormStaleTurn", { turnId: formTurnId }), sessionId); return;
      }
      const target = {
        formId: form.form_id, sessionId, turnId: active.id,
        threadId: correlation(form, "thread_id") || active.canonicalItems?.find((item) => item.threadId)?.threadId,
        source: { control: "chat-form", surface: "chat" as const },
      };
      deps.clearError();
      await dispatchCommand(cancelling ? createThreadFormCancelCommand(target) : createThreadFormSubmitCommand({ ...target, values }));
    },
    receiveCommand(sessionId: string, event: ChatEvent) {
      if (event.command && event.type === "command.dispatched") {
        pause(sessionId);
        transition(sessionId, { command: event.command, nowMs: deps.now(), type: "dispatch" });
        acknowledge(sessionId);
      } else if (event.commandId && event.type === "command.accepted") {
        transition(sessionId, { commandId: event.commandId, nowMs: deps.now(), type: "transport_accepted" });
        acknowledge(sessionId);
      } else if (event.commandId && event.type === "error") {
        transition(sessionId, { commandId: event.commandId, error: event.error || deps.t("runtime.commandRejected"), type: "rejected" });
      }
    },
    async receiveSessionEvent(sessionId: string, event: ChatEvent) {
      try {
        const sessions = await deps.refreshSessions();
        const effects = projectChatEventEffects(event);
        if (effects.terminalAgentEvent && await sendInterrupt(sessionId, true)) return;
        if (effects.queuedInputDisposition === "pause") { pause(sessionId); return; }
        if (effects.queuedInputDisposition === "dispatch_next" && canDispatchQueuedInput(sessions.find((session) => session.id === sessionId))) {
          await sendNext(sessionId, "normal_completion");
        }
      } catch (error) { failQueue(sessionId, "session.refresh", error); }
    },
    dispose() { timers.forEach(clearTimeout); timers.clear(); },
  };
}

function correlation(form: AgentUiForm, key: string): string {
  const value = form.correlation[key];
  return typeof value === "string" ? value : "";
}

export type ChatTurnApplication = ReturnType<typeof createChatTurnApplication>;
