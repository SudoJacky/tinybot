import { describe, expect, it } from "vitest";

import type { BackendAgentTurnItem } from "./chatTurnModel";
import {
  benchmarkTinyOsReplay,
  createTinyOsTimeMachineIndex,
  reconstructTinyOsKernelAt,
  tinyOsSimulationCursorAt,
  TINYOS_REPLAY_PROJECTOR_VERSION,
  TINYOS_REPLAY_TARGET_MS,
} from "./tinyOsTimeMachine";

function item(index: number, overrides: Partial<BackendAgentTurnItem> = {}): BackendAgentTurnItem {
  return {
    schemaVersion: "tinybot.turn_item.v2",
    createdAt: `2026-07-14T00:00:${String(index).padStart(2, "0")}Z`,
    data: {
      args: {},
      name: "workspace.read_file",
      result: {},
      status: "completed",
      timing: {},
      toolCallId: `call-${index}`,
      type: "tool_call",
    },
    itemId: `item-${index}`,
    kind: "tool_call",
    revision: 1,
    sequence: index,
    sessionId: "session-1",
    status: "completed",
    title: `Event ${index}`,
    turnId: index < 2 ? "turn-1" : "turn-2",
    ...overrides,
  };
}

describe("TinyOS Time Machine", () => {
  it("indexes every canonical boundary and groups it without inventing timestamps", () => {
    const index = createTinyOsTimeMachineIndex([
      item(0),
      item(1, { createdAt: "not-a-timestamp" }),
      item(2),
    ]);

    expect(index).toMatchObject({ eventCount: 3, projectorVersion: TINYOS_REPLAY_PROJECTOR_VERSION });
    expect(index.groups.map((group) => group.boundaryIndexes)).toEqual([[0, 1], [2]]);
    expect(index.boundaries[0].wallClockTime).toBe("2026-07-14T00:00:00Z");
    expect(index.boundaries[1]).not.toHaveProperty("wallClockTime");
    expect(tinyOsSimulationCursorAt(index, 1)).toMatchObject({
      boundary: { itemId: "item-1", turnId: "turn-1" },
      eventCount: 3,
      eventIndex: 1,
      mode: "history",
    });
    expect(() => tinyOsSimulationCursorAt(index, 3)).toThrow(/event index is unavailable/i);
  });

  it("reconstructs deterministically at an exact revision boundary", () => {
    const firstRevision = item(0, { itemId: "same-item", revision: 1, status: "running" });
    const secondRevision = item(1, { itemId: "same-item", revision: 2, status: "completed" });
    const items = [firstRevision, secondRevision];
    const index = createTinyOsTimeMachineIndex(items);
    const first = reconstructTinyOsKernelAt(items, tinyOsSimulationCursorAt(index, 0));
    const second = reconstructTinyOsKernelAt(items, tinyOsSimulationCursorAt(index, 1));
    const reloaded = reconstructTinyOsKernelAt(
      JSON.parse(JSON.stringify(items)) as BackendAgentTurnItem[],
      tinyOsSimulationCursorAt(index, 1),
    );

    expect(first.snapshot.processes.find(({ kind }) => kind === "tool_operation")?.state).toBe("running");
    expect(second.snapshot.processes.find(({ kind }) => kind === "tool_operation")?.state).toBe("completed");
    expect(reloaded.snapshot).toEqual(second.snapshot);
  });

  it("discards an incompatible disposable checkpoint and rebuilds from canonical events", () => {
    const items = [item(0), item(1)];
    const index = createTinyOsTimeMachineIndex(items);
    const cursor = tinyOsSimulationCursorAt(index, 1);
    const rebuilt = reconstructTinyOsKernelAt(items, cursor, {
      checkpoint: {
        eventIndex: 1,
        projectorVersion: TINYOS_REPLAY_PROJECTOR_VERSION + 1,
        snapshot: { truth: "stale" },
      },
    });

    expect(rebuilt.checkpointStatus).toBe("discarded_incompatible");
    expect(rebuilt.snapshot.cursor.eventIndex).toBe(1);
    expect(rebuilt.snapshot.truth).toBe("derived");
  });

  it("benchmarks large replay before recommending checkpoints", () => {
    const items = Array.from({ length: 2_000 }, (_, index) => item(index % 60, {
      itemId: `benchmark-${index}`,
      sequence: index,
      turnId: `turn-${Math.floor(index / 25)}`,
    }));
    const benchmark = benchmarkTinyOsReplay(items);

    expect(benchmark.sampleEventIndexes).toEqual([0, 999, 1_999]);
    expect(benchmark.maxDurationMs).toBeLessThan(TINYOS_REPLAY_TARGET_MS);
    expect(benchmark.checkpointRecommended).toBe(false);
  });
});
