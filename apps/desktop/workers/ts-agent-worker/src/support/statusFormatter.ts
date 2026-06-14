export type StatusUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  cached_tokens?: number;
};

export function buildStatusContent(input: {
  version: string;
  model: string;
  startTimeMs: number;
  nowMs?: number;
  lastUsage: StatusUsage;
  contextWindowTokens: number;
  sessionMessageCount: number;
  contextTokensEstimate: number;
}): string {
  const nowMs = input.nowMs ?? Date.now();
  const uptimeSeconds = Math.max(0, Math.floor((nowMs - input.startTimeMs) / 1000));
  const uptime = uptimeSeconds >= 3600
    ? `${Math.floor(uptimeSeconds / 3600)}h ${Math.floor((uptimeSeconds % 3600) / 60)}m`
    : `${Math.floor(uptimeSeconds / 60)}m ${uptimeSeconds % 60}s`;
  const lastIn = input.lastUsage.prompt_tokens ?? 0;
  const lastOut = input.lastUsage.completion_tokens ?? 0;
  const cached = input.lastUsage.cached_tokens ?? 0;
  const contextTotal = Math.max(input.contextWindowTokens, 0);
  const contextPercent = contextTotal > 0 ? Math.floor((input.contextTokensEstimate / contextTotal) * 100) : 0;
  const contextUsed = input.contextTokensEstimate >= 1000
    ? `${Math.floor(input.contextTokensEstimate / 1000)}k`
    : String(input.contextTokensEstimate);
  const contextTotalText = contextTotal > 0 ? `${Math.floor(contextTotal / 1024)}k` : "n/a";
  let tokenLine = `Tokens: ${lastIn} in / ${lastOut} out`;
  if (cached && lastIn) {
    tokenLine += ` (${Math.floor((cached * 100) / lastIn)}% cached)`;
  }
  return [
    `tinybot v${input.version}`,
    `Model: ${input.model}`,
    tokenLine,
    `Context: ${contextUsed}/${contextTotalText} (${contextPercent}%)`,
    `Session: ${input.sessionMessageCount} messages`,
    `Uptime: ${uptime}`,
  ].join("\n");
}
