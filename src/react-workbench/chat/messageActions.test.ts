import { describe, expect, it } from "vitest";
import { canBranchFromMessage, visibleMessageActions, type ReactChatMessage } from "./messageActions";

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
});
