import { describe, expect, test } from "vitest";
import { applyLoadedSubagentTrace } from "./chatSubagentTranscript";
import type { LiveSubagent } from "./chatUiProjection";

describe("chat subagent transcript facade", () => {
  test("upgrades a partial subagent from loaded delegate trace events", () => {
    const subagent = fixtureSubagent();

    const loaded = applyLoadedSubagentTrace(subagent, {
      trace: {
        finalOutput: "Final delegated result.",
        events: [
          {
            eventId: "event-start",
            eventType: "agent.delegate.started",
            createdAt: "2026-07-01T10:01:00Z",
            payload: { message: "Starting delegated work.", status: "running" },
          },
          {
            eventId: "event-message",
            eventType: "agent.delegate.message_queued",
            createdAt: "2026-07-01T10:02:00Z",
            payload: { content: "User guidance for child.", status: "pending" },
          },
          {
            event_id: "event-done",
            event_type: "agent.delegate.completed",
            created_at: "2026-07-01T10:03:00Z",
            payload: { final_output: "Final delegated result." },
          },
        ],
      },
    });

    expect(loaded.transcript.capability).toBe("full_transcript");
    expect(loaded.capabilities).toEqual(["can_forward", "full_transcript"]);
    expect(loaded.latestActivity).toBe("Final delegated result.");
    expect(loaded.transcript.messages).toEqual([
      {
        id: "event-start:message-1",
        role: "system",
        content: "Starting delegated work.",
        timestamp: "2026-07-01T10:01:00Z",
      },
      {
        id: "event-message:message-2",
        role: "user",
        content: "User guidance for child.",
        timestamp: "2026-07-01T10:02:00Z",
      },
      {
        id: "event-done:message-3",
        role: "assistant",
        content: "Final delegated result.",
        timestamp: "2026-07-01T10:03:00Z",
      },
    ]);
    expect(loaded.transcript.toolSummaries).toEqual([
      {
        id: "event-start",
        name: "agent.delegate.started",
        status: "running",
        preview: "Starting delegated work.",
      },
      {
        id: "event-message",
        name: "agent.delegate.message_queued",
        status: "pending",
        preview: "User guidance for child.",
      },
      {
        id: "event-done",
        name: "agent.delegate.completed",
        status: "completed",
        preview: "Final delegated result.",
      },
    ]);
  });

  test("keeps the existing partial transcript when loaded payload has no trace", () => {
    const subagent = fixtureSubagent();

    expect(applyLoadedSubagentTrace(subagent, null)).toEqual(subagent);
  });
});

function fixtureSubagent(): LiveSubagent {
  return {
    id: "delegate-1",
    sessionKey: "websocket:chat-1",
    name: "Researcher",
    task: "Check docs",
    status: "running",
    latestActivity: "Partial activity",
    capabilities: ["partial_transcript", "can_forward"],
    transcript: {
      id: "delegate-1",
      sessionKey: "websocket:chat-1",
      capability: "partial_transcript",
      messages: [{ id: "partial-1", role: "assistant", content: "Partial only." }],
      toolSummaries: [],
    },
  };
}
