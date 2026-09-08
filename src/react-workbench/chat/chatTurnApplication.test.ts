import { afterEach, describe, expect, it, vi } from "vitest";
import type { TFunction } from "i18next";
import type { ChatTimelineSnapshot } from "../../app-core/chat/agentTimelineModel";
import type { ChatTurn } from "../../app-core/chat/chatTurnContracts";
import type { ThreadEffectiveCapabilities } from "../../app-core/chat/threadCapabilities";
import { THREAD_COMMAND_ACK_TIMEOUT_MS } from "../../app-core/chat/threadCommand";
import type { ChatEvent } from "../services";
import { createChatTurnApplication } from "./chatTurnApplication";
import type { QueuedComposerInput } from "./chatSubmission";

const completed: ChatEvent = { type: "agent.event", eventType: "agent.turn.completed" };
const interrupted: ChatEvent = { type: "agent.event", eventType: "agent.turn.interrupted" };
const applications: ReturnType<typeof createChatTurnApplication>[] = [];

afterEach(() => {
  applications.splice(0).forEach((application) => application.dispose());
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function input(id: string): QueuedComposerInput {
  return { id, content: id, createdAt: "2026-09-08T00:00:00Z", mode: "queued", status: "queued", turnInput: { text: id } };
}

function context(sessionId = "s1") {
  const timeline: ChatTimelineSnapshot = {
    schemaVersion: "tinybot.chat_timeline.v1", source: "canonical", sessionId, diagnostics: [], turnRevisions: {},
    turns: [{
      id: `turn-${sessionId}`, sessionKey: sessionId, userMessageId: "user-1",
      userMessage: { id: "user-1", role: "user", text: "hello", timestamp: "2026-09-08T00:00:00Z" },
      status: "running", steps: [], startedAt: "2026-09-08T00:00:00Z", updatedAt: "2026-09-08T00:00:00Z",
    }],
  };
  const capabilities: ThreadEffectiveCapabilities = {
    schemaVersion: "tinybot.effective_capabilities.v2", threadId: sessionId,
    capabilities: { agent: { cancel: { available: true }, retry: { available: false } } },
  };
  return { timeline, capabilities };
}

function setup() {
  const dependencies = {
    dispatch: vi.fn<Parameters<typeof createChatTurnApplication>[0]["dispatch"]>(async () => {}),
    submitTurn: vi.fn(async (_sessionId: string, _input: { text: string }, _control: string) => {}),
    refreshSessions: vi.fn(async () => [{ id: "s1", chatId: "s1", title: "Chat", status: "idle" as const, updatedAtMs: 0 }]),
    reportError: vi.fn(), clearError: vi.fn(), now: () => Date.now(),
    t: ((key: string) => key) as TFunction<"chat">,
  };
  const application = createChatTurnApplication(dependencies);
  applications.push(application);
  application.observe("s1", context());
  return { application, ...dependencies };
}

describe("Chat turn application", () => {
  it.each(["terminal-first", "transport-first"])("interrupts exactly once with %s delivery", async (order) => {
    const { application, dispatch, submitTurn } = setup();
    const cancellation = deferred();
    dispatch.mockReturnValueOnce(cancellation.promise);
    application.enqueue("s1", input("replace"));
    application.enqueue("s1", input("later"));
    const request = application.interrupt("s1", "replace");
    if (order === "terminal-first") {
      await Promise.all([application.receiveSessionEvent("s1", interrupted), application.receiveSessionEvent("s1", interrupted)]);
      expect(submitTurn).not.toHaveBeenCalled();
      cancellation.resolve();
      await request;
    } else {
      cancellation.resolve();
      await request;
      expect(submitTurn).not.toHaveBeenCalled();
      await Promise.all([application.receiveSessionEvent("s1", interrupted), application.receiveSessionEvent("s1", interrupted)]);
    }
    expect(submitTurn).toHaveBeenCalledExactlyOnceWith("s1", { text: "replace" }, "interrupt-new-turn");
    expect(application.queue("s1").inputs.map((item) => item.id)).toEqual(["later"]);
  });

  it("reserves a pending submission and preserves inputs added or removed during its await", async () => {
    const { application, submitTurn } = setup();
    const submission = deferred();
    submitTurn.mockReturnValueOnce(submission.promise);
    application.enqueue("s1", input("first"));
    application.enqueue("s1", input("remove"));
    const sending = application.receiveSessionEvent("s1", completed);
    await vi.waitFor(() => expect(submitTurn).toHaveBeenCalledTimes(1));
    application.enqueue("s1", input("new"));
    application.remove("s1", "remove");
    await application.receiveSessionEvent("s1", completed);
    expect(submitTurn).toHaveBeenCalledTimes(1);
    submission.resolve();
    await sending;
    expect(application.queue("s1").inputs.map((item) => item.id)).toEqual(["new"]);
  });

  it("pauses on cancel, requires manual resume, and resumes only one input", async () => {
    const { application, dispatch, submitTurn } = setup();
    application.enqueue("s1", input("first"));
    application.enqueue("s1", input("second"));
    await application.cancel("s1");
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ kind: "agent.cancel", target: { sessionId: "s1", turnId: "turn-s1" } }));
    expect(application.queue("s1").inputs.map((item) => item.status)).toEqual(["paused", "paused"]);
    await application.receiveSessionEvent("s1", completed);
    expect(submitTurn).not.toHaveBeenCalled();
    await application.resume("s1");
    expect(submitTurn).toHaveBeenCalledExactlyOnceWith("s1", { text: "first" }, "queue-manual_resume");
    expect(application.queue("s1").inputs).toMatchObject([{ id: "second", status: "paused" }]);
  });

  it("keeps a failed submission visible and retryable without automatic retry", async () => {
    const { application, submitTurn } = setup();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    application.enqueue("s1", input("first"));
    submitTurn.mockRejectedValueOnce(new Error("submission unavailable"));
    await application.receiveSessionEvent("s1", completed);
    expect(application.queue("s1")).toMatchObject({ inputs: [{ id: "first", status: "paused" }], message: "submission unavailable" });
    expect(log).toHaveBeenCalledWith("[chat-turn] queue.submit.failed", expect.objectContaining({ sessionId: "s1", inputId: "first" }));
    await application.receiveSessionEvent("s1", completed);
    expect(submitTurn).toHaveBeenCalledTimes(1);
  });

  it("does not send an interrupt after cancellation fails, even when the terminal event arrived", async () => {
    const { application, dispatch, submitTurn } = setup();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const cancellation = deferred();
    dispatch.mockReturnValueOnce(cancellation.promise);
    application.enqueue("s1", input("replacement"));
    const request = application.interrupt("s1", "replacement");
    await application.receiveSessionEvent("s1", interrupted);
    cancellation.reject(new Error("cancel rejected"));
    await request;
    expect(submitTurn).not.toHaveBeenCalled();
    expect(application.queue("s1")).toMatchObject({ inputs: [{ status: "failed" }], message: "errors.interruptFailed" });
  });

  it("rejects capabilities evaluated for an older turn", async () => {
    const { application, dispatch, reportError } = setup();
    const stale = context();
    stale.capabilities.evaluatedTurnId = "old-turn";
    application.observe("s1", stale);
    await application.cancel("s1");
    expect(dispatch).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith("Cannot cancel: runtime.staleCapabilities", "s1");
  });

  it("keeps transport acceptance separate from canonical acknowledgement and completion", async () => {
    const { application, dispatch } = setup();
    await application.cancel("s1");
    const commandId = dispatch.mock.calls[0][0].commandId;
    application.receiveCommand("s1", { type: "command.accepted", commandId });
    expect(application.turn("s1").lifecycle.stage).toBe("waiting_for_canonical");
    const canonical = context();
    canonical.timeline.turns[0].canonicalItems = [{
      data: { detail: { commandId, commandStatus: "acknowledged" } }, itemId: "ack", revision: 1, status: "completed",
    }] as ChatTurn["canonicalItems"];
    application.observe("s2", context("s2"));
    application.receiveTimeline("s1", canonical.timeline);
    expect(application.turn("s1").lifecycle.stage).toBe("acknowledged");
    canonical.timeline.turns[0].canonicalItems!.push({
      data: { commandId }, itemId: "done", revision: 2, status: "cancelled",
    } as NonNullable<ChatTurn["canonicalItems"]>[number]);
    application.receiveTimeline("s1", canonical.timeline);
    expect(application.turn("s1").lifecycle).toMatchObject({ stage: "completed", completion: { itemId: "done", status: "cancelled" } });
    expect(application.turn("s2").lifecycle.stage).toBe("idle");
  });

  it("keeps command confirmation isolated across sessions and releases timers on disposal", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { application } = setup();
    await application.cancel("s1");
    application.observe("s2", context("s2"));
    expect(application.turn("s2").lifecycle.stage).toBe("idle");
    vi.advanceTimersByTime(THREAD_COMMAND_ACK_TIMEOUT_MS);
    expect(application.turn("s1").lifecycle.stage).toBe("timed_out");
    await application.cancel("s2");
    application.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves command and unrelated session snapshot identity when the queue changes", () => {
    const { application } = setup();
    const controls = application.turn("s1");
    const otherQueue = application.queue("s2");
    application.enqueue("s1", input("first"));
    application.remove("s1", "first");
    expect(application.turn("s1")).toBe(controls);
    expect(application.queue("s2")).toBe(otherQueue);
  });
});
