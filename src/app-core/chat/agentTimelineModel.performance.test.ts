import { expect, test } from "vitest";
import { createAgentTimelineModel } from "./agentTimelineModel";

// Deterministic work-count assertion; timings are reported, never used as a flaky gate.
test("streaming patches preserve history and only project the changed turn", () => {
  const sessionId = "performance";
  const turnCount = 250;
  const patchCount = 30;
  const states = Array.from({ length: turnCount }, (_, index) => ({
    runtimeEvents: [],
    timeline: {
      schemaVersion: "tinybot.timeline.v2", sessionId, turnId: `turn-${index}`, snapshotRevision: 1,
      items: [{
        schemaVersion: "tinybot.turn_item.v2", sessionId, turnId: `turn-${index}`,
        itemId: `answer-${index}`, sequence: 1, revision: 1, kind: "assistant_message",
        status: index === turnCount - 1 ? "running" : "completed",
        createdAt: new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString(),
        data: { type: "assistant_message", messageId: `answer-${index}`, modelCallId: `call-${index}`,
          phase: "final_answer", content: "History with a code block.\n```ts\nconst result = 42;\n```\n".repeat(8) },
      }],
    },
  }));
  const model = createAgentTimelineModel();
  let previous = model.load(sessionId, states);
  const original = previous;
  const active = states[turnCount - 1].timeline;
  let changedTurns = 0;
  const start = performance.now();
  for (let index = 0; index < patchCount; index += 1) {
    const next = model.applyPatch(sessionId, {
      schemaVersion: "tinybot.timeline_patch.v2", sessionId, turnId: active.turnId,
      snapshotRevision: 1,
      item: { ...active.items[0], revision: index + 2,
        data: { ...active.items[0].data, content: `Streaming ${index}` } },
    });
    changedTurns += next.turns.filter((turn, offset) => turn !== previous.turns[offset]).length;
    previous = next;
  }
  console.info("[chat-performance] timeline", {
    turnCount, patchCount, changedTurns, patchMs: Math.round((performance.now() - start) * 100) / 100,
  });
  expect(previous.turns[turnCount - 1]?.finalAnswer?.text).toBe("Streaming 29");
  expect(original.turns[turnCount - 1]?.finalAnswer?.text).toContain("History");
  expect(changedTurns).toBe(patchCount);
});
