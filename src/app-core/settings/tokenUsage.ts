export type TokenUsageCounts = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
};

export type DailyTokenUsage = TokenUsageCounts & {
  date: string;
};

export type TokenUsageSnapshot = {
  schemaVersion: "tinybot.token_usage.v1";
  totals: TokenUsageCounts;
  days: DailyTokenUsage[];
};
