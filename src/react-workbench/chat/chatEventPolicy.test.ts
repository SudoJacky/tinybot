import { describe, expect, it } from "vitest";
import type { ChatTurnStatus } from "../../app-core/chat/chatTurnModel";
import type { ChatTimelineSnapshot } from "../../app-core/chat/agentTimelineModel";
import type { ChatEvent, SessionSummary } from "../services";
import {
  canDispatchQueuedInput,
  projectChatEventEffects,
  projectTimelineSessionStatus,
} from "./chatEventPolicy";

describe("chatEventPolicy", () => {
  it.each([
    {
      event: { type: "attached" },
      expected: {
        backgroundTabActivity: false,
        queuedInputDisposition: "unchanged",
        reloadAgentUiForms: false,
        reloadMessages: true,
        reloadSessions: false,
        terminalAgentEvent: false,
      },
    },
    {
      event: { type: "agent-ui.form" },
      expected: {
        backgroundTabActivity: false,
        queuedInputDisposition: "unchanged",
        reloadAgentUiForms: true,
        reloadMessages: false,
        reloadSessions: false,
        terminalAgentEvent: false,
      },
    },
    {
      event: { type: "agent.event", eventType: "agent.turn.completed" },
      expected: {
        backgroundTabActivity: true,
        queuedInputDisposition: "dispatch_next",
        reloadAgentUiForms: false,
        reloadMessages: false,
        reloadSessions: true,
        terminalAgentEvent: true,
      },
    },
    {
      event: { type: "agent.event", eventType: "agent.turn.failed" },
      expected: {
        backgroundTabActivity: true,
        queuedInputDisposition: "pause",
        reloadAgentUiForms: false,
        reloadMessages: false,
        reloadSessions: true,
        terminalAgentEvent: true,
      },
    },
    {
      event: { type: "interrupted" },
      expected: {
        backgroundTabActivity: false,
        queuedInputDisposition: "pause",
        reloadAgentUiForms: false,
        reloadMessages: false,
        reloadSessions: true,
        terminalAgentEvent: false,
      },
    },
    {
      event: { type: "stream", error: "connection closed" },
      expected: {
        backgroundTabActivity: true,
        queuedInputDisposition: "unchanged",
        reloadAgentUiForms: false,
        reloadMessages: false,
        reloadSessions: false,
        terminalAgentEvent: false,
      },
    },
  ] satisfies Array<{ event: ChatEvent; expected: ReturnType<typeof projectChatEventEffects> }>) (
    "projects $event.type effects",
    ({ event, expected }) => {
      expect(projectChatEventEffects(event)).toEqual(expected);
    },
  );

  it.each([
    ["pending", "running"],
    ["running", "running"],
    ["awaiting_user", "running"],
    ["failed", "failed"],
    ["interrupted", "failed"],
    ["completed", "idle"],
  ] satisfies Array<[ChatTurnStatus, SessionSummary["status"]]>) (
    "projects %s turns to %s sessions",
    (turnStatus, sessionStatus) => {
      expect(projectTimelineSessionStatus(timelineWithStatus(turnStatus))).toBe(sessionStatus);
    },
  );

  it("allows queued input only when the session is no longer busy or failed", () => {
    expect(canDispatchQueuedInput(undefined)).toBe(true);
    expect(canDispatchQueuedInput(sessionWithStatus("idle"))).toBe(true);
    expect(canDispatchQueuedInput(sessionWithStatus("running"))).toBe(false);
    expect(canDispatchQueuedInput(sessionWithStatus("failed"))).toBe(false);
  });
});

function timelineWithStatus(status: ChatTurnStatus): ChatTimelineSnapshot {
  return {
    diagnostics: [],
    schemaVersion: "tinybot.chat_timeline.v1",
    sessionId: "session-1",
    source: "canonical",
    turnRevisions: {},
    turns: [{ status } as ChatTimelineSnapshot["turns"][number]],
  };
}

function sessionWithStatus(status: SessionSummary["status"]): SessionSummary {
  return { id: "session-1", status, title: "Session", updatedAtMs: 0 };
}
