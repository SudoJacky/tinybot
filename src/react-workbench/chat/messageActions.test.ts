import { describe, expect, it } from "vitest";
import { canBranchFromMessage, canCopyMessage, visibleMessageActions, type ReactChatMessage } from "./messageActions";

const baseMessage: ReactChatMessage = {
  id: "m1",
  role: "assistant",
  createdAtMs: Date.UTC(2026, 6, 4, 12, 0, 0),
  text: "Ready.",
  status: "complete",
};

describe("message action visibility", () => {
  it("never shows branch on user messages", () => {
    const message = { ...baseMessage, role: "user" as const };
    expect(canBranchFromMessage(message, { sessionRunning: false })).toBe(false);
    expect(canCopyMessage(message, { sessionRunning: true })).toBe(true);
    expect(visibleMessageActions(message, { sessionRunning: false })).toEqual(["copy"]);
  });

  it("shows branch only for completed assistant messages without tool calls while idle", () => {
    expect(canBranchFromMessage(baseMessage, { sessionRunning: false })).toBe(true);
    expect(visibleMessageActions(baseMessage, { sessionRunning: false })).toEqual(["copy", "branch"]);
  });

  it("hides branch while the session is running or the assistant message has tool calls", () => {
    expect(canBranchFromMessage(baseMessage, { sessionRunning: true })).toBe(false);
    expect(canBranchFromMessage({ ...baseMessage, toolCalls: [{ id: "t1", name: "shell", status: "complete" }] }, { sessionRunning: false })).toBe(false);
  });

  it("hides assistant copy and branch actions while the turn is still running", () => {
    expect(canCopyMessage(baseMessage, { sessionRunning: true })).toBe(false);
    expect(visibleMessageActions(baseMessage, { sessionRunning: true })).toEqual([]);
  });

  it("uses turn status instead of session status when the message has turn metadata", () => {
    const completedTurnMessage = { ...baseMessage, turnId: "turn-1", turnStatus: "completed" };
    const runningTurnMessage = { ...baseMessage, turnId: "turn-2", turnStatus: "running" };

    expect(visibleMessageActions(completedTurnMessage, { sessionRunning: true })).toEqual(["copy", "branch"]);
    expect(visibleMessageActions(runningTurnMessage, { sessionRunning: false })).toEqual([]);
  });

  it("hides copy and branch actions when a message has thinking but no body text", () => {
    const reasoningOnlyMessage = {
      ...baseMessage,
      text: "  ",
      reasoningText: "I am planning the response.",
    };

    expect(canCopyMessage(reasoningOnlyMessage, { sessionRunning: false })).toBe(false);
    expect(canBranchFromMessage(reasoningOnlyMessage, { sessionRunning: false })).toBe(false);
    expect(visibleMessageActions(reasoningOnlyMessage, { sessionRunning: false })).toEqual([]);
  });
});
