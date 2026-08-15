import { describe, expect, it } from "vitest";
import type { ChatTurn, CompactionState, TokenUsage } from "../../app-core/chat/chatTurnModel";
import { projectLatestContextUsage } from "./chatContextUsage";

describe("chatContextUsage", () => {
  it("returns the latest provider usage unchanged when no compaction follows it", () => {
    const usage: TokenUsage = {
      contextWindowTokens: 128_000,
      contextWindowUsedTokens: 5_000,
      percent: 3.90625,
    };

    expect(projectLatestContextUsage([turn({ usage })])).toBe(usage);
  });

  it("rebuilds usage from the newest compaction and earlier provider window metadata", () => {
    const earlierUsage: TokenUsage = {
      cachedTokens: 800,
      contextWindowStrategy: "compact",
      contextWindowTokens: 128_000,
      contextWindowUsedTokens: 12_000,
      percent: 9.375,
    };

    expect(projectLatestContextUsage([
      turn({ usage: earlierUsage }),
      turn({ compaction: { droppedItemCount: 12, estimatedTokensAfter: 4_200, strategy: "compact" } }),
    ])).toEqual({
      ...earlierUsage,
      contextWindowRemainingTokens: 123_800,
      contextWindowUsedTokens: 4_200,
      percent: 3.28125,
    });
  });

  it("uses configured defaults when persisted history has compaction but no usage", () => {
    const usage = projectLatestContextUsage([
      turn({ compaction: { droppedItemCount: 0, estimatedTokensAfter: 32_066 } }),
    ], {
      contextWindowStrategy: "compact",
      contextWindowTokens: 128_000,
    });

    expect(usage).toMatchObject({
      contextWindowRemainingTokens: 95_934,
      contextWindowStrategy: "compact",
      contextWindowTokens: 128_000,
      contextWindowUsedTokens: 32_066,
    });
    expect(usage?.percent).toBeCloseTo(25.0515625);
  });

  it("prefers provider usage emitted in the same turn as a compaction", () => {
    const usage: TokenUsage = {
      contextWindowTokens: 128_000,
      contextWindowUsedTokens: 5_000,
      percent: 3.90625,
    };

    expect(projectLatestContextUsage([
      turn({
        compaction: { droppedItemCount: 12, estimatedTokensAfter: 4_200 },
        usage,
      }),
    ])).toBe(usage);
  });

  it("caps compacted usage at the context window size", () => {
    expect(projectLatestContextUsage([
      turn({
        compaction: {
          contextWindowTokens: 8_000,
          droppedItemCount: 2,
          estimatedTokensAfter: 9_000,
        },
      }),
    ])).toEqual({
      contextWindowRemainingTokens: 0,
      contextWindowTokens: 8_000,
      contextWindowUsedTokens: 8_000,
      percent: 100,
    });
  });

  it("returns undefined when neither usage nor compaction is available", () => {
    expect(projectLatestContextUsage([turn({})])).toBeUndefined();
  });
});

function turn({
  compaction,
  usage,
}: {
  compaction?: CompactionState;
  usage?: TokenUsage;
}): ChatTurn {
  return {
    id: "turn-1",
    sessionKey: "session-1",
    startedAt: "2026-08-15T00:00:00.000Z",
    status: "completed",
    steps: compaction
      ? [{ compaction, kind: "compaction" } as ChatTurn["steps"][number]]
      : [],
    updatedAt: "2026-08-15T00:00:01.000Z",
    usage,
    userMessage: {
      id: "message-1",
      role: "user",
      text: "Continue",
      timestamp: "2026-08-15T00:00:00.000Z",
    },
    userMessageId: "message-1",
  };
}
