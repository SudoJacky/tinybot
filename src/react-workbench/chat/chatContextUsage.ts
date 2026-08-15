import type { ChatTurn, TokenUsage } from "../../app-core/chat/chatTurnModel";

export type ContextUsageDefaults = {
  contextWindowStrategy?: string;
  contextWindowTokens?: number;
};

export function projectLatestContextUsage(
  turns: readonly ChatTurn[],
  defaults: ContextUsageDefaults = {},
): TokenUsage | undefined {
  let latestCompactedTokens: number | undefined;
  let latestCompactionStrategy: string | undefined;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (turn.usage) {
      if (latestCompactedTokens === undefined || turn.usage.contextWindowTokens === undefined) {
        return turn.usage;
      }
      return usageAfterCompaction(
        latestCompactedTokens,
        turn.usage.contextWindowTokens,
        latestCompactionStrategy,
        turn.usage,
      );
    }
    const compaction = [...turn.steps]
      .reverse()
      .find((step) => step.kind === "compaction" && step.compaction?.estimatedTokensAfter !== undefined)
      ?.compaction;
    latestCompactedTokens ??= compaction?.estimatedTokensAfter;
    latestCompactionStrategy ??= compaction?.strategy;
    if (latestCompactedTokens !== undefined && compaction?.contextWindowTokens !== undefined) {
      return usageAfterCompaction(
        latestCompactedTokens,
        compaction.contextWindowTokens,
        latestCompactionStrategy,
      );
    }
  }
  if (latestCompactedTokens !== undefined && defaults.contextWindowTokens !== undefined) {
    return usageAfterCompaction(
      latestCompactedTokens,
      defaults.contextWindowTokens,
      latestCompactionStrategy ?? defaults.contextWindowStrategy,
    );
  }
  return undefined;
}

function usageAfterCompaction(
  estimatedTokensAfter: number,
  contextWindowTokens: number,
  contextWindowStrategy?: string,
  previousUsage: TokenUsage = {},
): TokenUsage {
  const contextWindowUsedTokens = Math.min(estimatedTokensAfter, contextWindowTokens);
  return {
    ...previousUsage,
    contextWindowRemainingTokens: Math.max(0, contextWindowTokens - contextWindowUsedTokens),
    ...(contextWindowStrategy ? { contextWindowStrategy } : {}),
    contextWindowTokens,
    contextWindowUsedTokens,
    percent: contextWindowTokens > 0 ? (contextWindowUsedTokens / contextWindowTokens) * 100 : 0,
  };
}
