import { expect, it } from "vitest";
import type { ChatTimelineSnapshot } from "../../app-core/chat/agentTimelineModel";
import type { ChatStep } from "../../app-core/chat/chatTurnContracts";
import { projectTeamActivity } from "./teamActivityProjection";

function timeline(threadId: string, text: string): ChatTimelineSnapshot {
  return {
    schemaVersion: "tinybot.chat_timeline.v1", sessionId: threadId, source: "canonical", turnRevisions: {}, diagnostics: [],
    turns: [{ id: "turn", sessionKey: threadId, status: "running", startedAt: "", updatedAt: "", userMessageId: "user",
      userMessage: { id: "user", role: "user", text: "private instructions", timestamp: "" },
      steps: [{ id: "step", kind: "message", title: "Update", summary: text, sequence: 1, status: "running", agentContext: { id: "main", title: "Agent", type: "main" } }],
    }],
  };
}
it("retains recorded reasoning and tool details for the selected turn", () => {
  const snapshot = timeline("worker", "Public progress");
  snapshot.turns[0].steps.push({ ...snapshot.turns[0].steps[0], id: "reasoning", kind: "reasoning", summary: "Recorded reasoning" });
  snapshot.turns.push({ ...snapshot.turns[0], id: "other" });
  expect(projectTeamActivity(snapshot, "turn").map((item) => item.text)).toEqual(["Public progress", "Recorded reasoning"]);
  const tool = { ...snapshot.turns[0].steps[0], id: "tool", kind: "tool_call", toolCall: { id: "call", name: "read_file", argsJson: { path: "report.txt" }, resultPreview: "File contents", durationMs: 300 } } satisfies ChatStep;
  snapshot.turns[0].steps.push(tool);
  expect(projectTeamActivity(snapshot, "turn")[2].toolCall).toEqual(tool.toolCall);
  expect(JSON.stringify(projectTeamActivity(snapshot, "turn"))).not.toContain("private instructions");
  expect(projectTeamActivity(snapshot, "missing")).toEqual([]);
});

it("retains full public messages and older activity for reading on demand", () => {
  const text = "Verified detail. ".repeat(100);
  const snapshot = timeline("worker", text);
  snapshot.turns[0].steps = Array.from({ length: 60 }, (_, index) => ({
    ...snapshot.turns[0].steps[0], id: String(index), sequence: index,
  }));
  const activity = projectTeamActivity(snapshot, "turn");
  expect(activity).toHaveLength(60);
  expect(activity[0].text).toBe(text);
});
