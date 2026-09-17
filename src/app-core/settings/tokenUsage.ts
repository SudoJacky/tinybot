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
  schemaVersion: "tinybot.token_usage.v3";
  totals: TokenUsageCounts;
  days: DailyTokenUsage[];
  modelDays: DailyModelTokenUsage[];
  groups: UsageGroup[];
};

export type UsagePurpose = "unclassified" | "conversation" | "team_task" | "team_planning" | "subagent" | "automation" | "compaction" | "title" | "memory_extraction" | "memory_consolidation" | "graph_routing" | "graph_execution";
export type UsageOrigin = {
  purpose: UsagePurpose;
  teamRunId: string | null;
  taskId: string | null;
  attemptId: string | null;
  threadId: string | null;
  turnId: string | null;
};

export type UsageGroup = Pick<UsageOrigin, "teamRunId" | "taskId" | "attemptId"> & {
  purpose: UsagePurpose | "legacy";
  date: string;
  providerId: string;
  modelId: string;
  calls: number;
  reportedCalls: number;
  failedCalls: number;
  pendingCalls: number;
  retryCalls: number;
  usage: TokenUsageCounts | null;
};

export type UsageInvocation = {
  sequence: number;
  id: string;
  requestId: string;
  attempt: number;
  date: string;
  startedAt: string;
  finishedAt: string | null;
  providerId: string;
  modelId: string;
  origin: UsageOrigin;
  status: "pending" | "completed" | "failed" | "cancelled" | "interrupted" | "retry";
  usage: TokenUsageCounts | null;
};

export type UsageDetails = { groups: UsageGroup[]; invocations: UsageInvocation[]; nextCursor: number | null };
export type UsageDetailsLoader = (input?: { teamRunId?: string; before?: number }) => Promise<UsageDetails>;
