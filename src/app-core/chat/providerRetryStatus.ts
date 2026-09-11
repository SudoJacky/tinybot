export type ProviderRetryStatus = {
  turnId: string;
  modelCallId: string;
  attempt: number;
  maxRetries: number;
  delayMs: number;
  reason: "rate_limit" | "server_error" | "connection_error";
};

export type ProviderRetryUpdate = {
  sessionId: string;
  turnId: string;
  modelCallId: string;
  retry: ProviderRetryStatus | null;
};

/** Retry is transient transport status, never assistant content or a turn error. */
export function projectProviderRetryEvent(value: unknown): ProviderRetryUpdate | null {
  const envelope = record(value);
  if (envelope.eventName && envelope.eventName !== "agent.status") return null;
  const payload = envelope.eventName ? record(envelope.payload) : envelope;
  if (!("retry" in payload)) return null;
  const trace = payload.traceContext ? record(payload.traceContext) : {};
  const sessionId = requiredString(trace.threadId ?? envelope.threadId ?? envelope.sessionId, "sessionId");
  const turnId = requiredString(trace.turnId ?? envelope.turnId, "turnId");
  const modelCallId = requiredString(payload.modelCallId, "modelCallId");
  if (payload.retry === null) return { sessionId, turnId, modelCallId, retry: null };
  const retry = record(payload.retry);
  const attempt = integer(retry.attempt, "attempt", 1);
  const maxRetries = integer(retry.maxRetries, "maxRetries", 1);
  const delayMs = integer(retry.delayMs, "delayMs", 0);
  if (attempt > maxRetries) throw new Error("Provider retry attempt exceeds its retry budget.");
  const reason = retry.reason;
  if (reason !== "rate_limit" && reason !== "server_error" && reason !== "connection_error") {
    throw new Error("Provider retry reason is invalid.");
  }
  return { sessionId, turnId, modelCallId, retry: { turnId, modelCallId, attempt, maxRetries, delayMs, reason } };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Provider status must be an object.");
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Provider retry is missing ${name}.`);
  return value;
}

function integer(value: unknown, name: string, minimum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`Provider retry ${name} is invalid.`);
  }
  return value;
}
