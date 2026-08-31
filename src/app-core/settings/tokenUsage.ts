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

export type DailyModelTokenUsage = TokenUsageCounts & {
  date: string;
  providerId: string;
  modelId: string;
};

export type TokenUsageSnapshot = {
  schemaVersion: "tinybot.token_usage.v2";
  totals: TokenUsageCounts;
  days: DailyTokenUsage[];
  modelDays: DailyModelTokenUsage[];
};
