import type { BackendAgentTurnItem, ChatTurn, TurnMetrics } from "./chatTurnContracts";

/** Fold durable model samples; tools and gaps between invocations never enter the denominator. */
export function deriveTurnMetrics(items: readonly BackendAgentTurnItem[]): TurnMetrics | undefined {
  const usages = items.filter((item) => item.data.type === "usage").sort((a, b) => a.sequence - b.sequence);
  const first = usages[0]?.data;
  const metrics: TurnMetrics = {};
  if (first?.type === "usage" && first.modelTiming?.timeToFirstTokenMs != null) {
    metrics.timeToFirstTokenMs = first.modelTiming.timeToFirstTokenMs;
  }
  let outputTokens = 0;
  let decodeMs = 0;
  for (const { data } of usages) {
    if (data.type !== "usage") continue;
    const duration = data.modelTiming?.decodeDurationMs;
    if (duration != null && duration > 0 && data.outputTokens != null) {
      outputTokens += data.outputTokens;
      decodeMs += duration;
    }
  }
  if (decodeMs > 0) metrics.tokensPerSecond = outputTokens / (decodeMs / 1_000);
  return Object.keys(metrics).length ? metrics : undefined;
}

export function turnDurationMs(turn: ChatTurn): number | undefined {
  if (!turn.completedAt) return undefined;
  const timestamp = (value: string) => /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  const duration = timestamp(turn.completedAt) - timestamp(turn.startedAt);
  return Number.isFinite(duration) && duration >= 0 ? duration : undefined;
}
