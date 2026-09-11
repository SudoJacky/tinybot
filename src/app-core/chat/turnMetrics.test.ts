import { describe, expect, test } from "vitest";
import { normalizeAgentTurnRuntimeStatePayload } from "./chatTimelinePayload";
import { projectBackendTimeline } from "./chatProjection";
import { turnDurationMs } from "./turnMetrics";

function restoredTurn(samples: Array<{ tokens?: number; request?: number | null; first?: number | null; decode?: number | null; legacy?: boolean }>) {
  const items = samples.map((sample, index) => ({
    schemaVersion: "tinybot.turn_item.v2", sessionId: "session", turnId: "turn",
    itemId: `usage-${index}`, kind: "usage", status: "completed", sequence: index + 1, revision: 1,
    createdAt: String(1000 + index * 50_000),
    data: {
      type: "usage", outputTokens: sample.tokens ?? null, providerPayload: {},
      ...(!sample.legacy ? { modelTiming: { modelCallId: `call-${index}`, timeToRequestMs: sample.request, timeToFirstTokenMs: sample.first ?? null, decodeDurationMs: sample.decode ?? null } } : {}),
    },
  }));
  const payload = JSON.parse(JSON.stringify({
    status: "completed", completedAt: "101000",
    timeline: { schemaVersion: "tinybot.timeline.v2", sessionId: "session", turnId: "turn", snapshotRevision: items.length, items },
  }));
  return projectBackendTimeline("session", [normalizeAgentTurnRuntimeStatePayload(payload)])[0];
}

describe("durable turn metrics", () => {
  test("restores preparation time from the first call, independently of TTFT and later tools", () => {
    expect(restoredTurn([{ request: 125, first: 600 }, { request: 5000, first: 200 }]).metrics)
      .toEqual({ timeToRequestMs: 125, timeToFirstTokenMs: 600 });
    expect(restoredTurn([{ request: 0 }]).metrics).toEqual({ timeToRequestMs: 0 });
    expect(restoredTurn([{ request: null }, { request: 5000 }]).metrics).toBeUndefined();
    expect(restoredTurn([{}, { request: 5000 }]).metrics).toBeUndefined();
  });

  test("restores weighted throughput and first-call latency without counting gaps between calls", () => {
    const turn = restoredTurn([{ tokens: 40, first: 1200, decode: 3000 }, { tokens: 60, first: 200, decode: 2000 }]);
    expect(turn.metrics).toEqual({ timeToFirstTokenMs: 1200, tokensPerSecond: 20 });
    expect(turnDurationMs(turn)).toBe(100_000);
  });

  test("does not replace a missing first-call latency with a later call", () => {
    expect(restoredTurn([{ legacy: true, tokens: 500 }, { tokens: 30, first: 500, decode: 2000 }]).metrics)
      .toEqual({ tokensPerSecond: 15 });
  });

  test("requires matching output counts and positive decode durations for each speed sample", () => {
    expect(restoredTurn([
      { first: 800, decode: 100_000 },
      { tokens: 500, first: 0, decode: 0 },
      { tokens: 60, first: 200, decode: 2000 },
    ]).metrics).toEqual({ timeToFirstTokenMs: 800, tokensPerSecond: 30 });
    expect(restoredTurn([{ tokens: 50, legacy: true }]).metrics).toBeUndefined();
    expect(restoredTurn([{ tokens: 50 }]).metrics).toBeUndefined();
  });

  test("rejects corrupt persisted timing instead of showing a fabricated number", () => {
    for (const request of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => restoredTurn([{ request }])).toThrow(/model timing/);
    }
    expect(() => restoredTurn([{ tokens: 10, first: -5, decode: 100 }])).toThrow(/model timing/);
    expect(() => restoredTurn([{ tokens: -10, first: 5, decode: 100 }])).toThrow(/outputTokens/);
  });
});
