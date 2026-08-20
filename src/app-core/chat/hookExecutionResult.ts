export type HookExecutionResult = {
  decision: string;
  durationMs: number;
  failure?: string;
  hookName: string;
  id: string;
  stage: string;
  toolCallId?: string;
  turnId: string;
};

export type HookExecutionEventProjection = {
  results: HookExecutionResult[];
  sessionId: string;
  turnId: string;
};

export function projectHookExecutionEvent(value: unknown): HookExecutionEventProjection | null {
  const envelope = recordValue(value);
  const eventName = stringValue(envelope.eventName ?? envelope.event_name);
  if (eventName && eventName !== "agent.hook.decision") return null;
  const payload = eventName ? requiredRecord(envelope.payload, "hook decision payload") : envelope;
  const rawRuns = payload.commandRuns ?? payload.command_runs;
  if (!Array.isArray(rawRuns)) {
    throw new Error("Hook decision event commandRuns must be an array.");
  }
  if (!rawRuns.length) return null;

  const sessionId = stringValue(payload.threadId ?? payload.thread_id ?? envelope.sessionId ?? envelope.session_id);
  const turnId = stringValue(payload.turnId ?? payload.turn_id ?? envelope.turnId ?? envelope.turn_id);
  const stage = normalizeStage(stringValue(payload.stage));
  if (!sessionId) throw new Error("Hook decision event is missing threadId.");
  if (!turnId) throw new Error("Hook decision event is missing turnId.");
  if (!stage) throw new Error("Hook decision event is missing stage.");

  const toolCallId = stringValue(payload.toolCallId ?? payload.tool_call_id) || undefined;
  const traceContext = recordValue(envelope.traceContext ?? envelope.trace_context ?? payload.traceContext ?? payload.trace_context);
  const eventIdentity = [
    stringValue(payload.traceId ?? payload.trace_id ?? traceContext.traceId ?? traceContext.trace_id ?? envelope.traceId ?? envelope.trace_id),
    stringValue(payload.requestId ?? payload.request_id),
    stringValue(payload.providerAttemptId ?? payload.provider_attempt_id),
    turnId,
    stage,
    toolCallId ?? "",
  ].filter(Boolean).join(":");
  const results = rawRuns.map((rawRun, index) => {
    const run = requiredRecord(rawRun, `hook decision commandRuns[${index}]`);
    const hookName = stringValue(run.hookName ?? run.hook_name);
    const decision = stringValue(run.decision);
    const durationMs = numberValue(run.durationMs ?? run.duration_ms);
    if (!hookName) throw new Error(`Hook decision commandRuns[${index}] is missing hookName.`);
    if (!decision) throw new Error(`Hook decision commandRuns[${index}] is missing decision.`);
    if (durationMs === undefined || durationMs < 0) {
      throw new Error(`Hook decision commandRuns[${index}] has an invalid durationMs.`);
    }
    const failure = stringValue(run.failure) || undefined;
    return {
      decision,
      durationMs,
      ...(failure ? { failure } : {}),
      hookName,
      id: `${eventIdentity}:${index}:${hookName}`,
      stage,
      ...(toolCallId ? { toolCallId } : {}),
      turnId,
    };
  });
  return { results, sessionId, turnId };
}

export function projectHookExecutionResults(runtimeEvents: readonly unknown[]): HookExecutionResult[] {
  return runtimeEvents.flatMap((event) => projectHookExecutionEvent(event)?.results ?? []);
}

function normalizeStage(value: string): string {
  switch (value) {
    case "user_prompt_submit": return "UserPromptSubmit";
    case "before_tool_use": return "PreToolUse";
    case "after_tool_use": return "PostToolUse";
    case "compaction_complete": return "PostCompact";
    default: return value;
  }
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  return value;
}

function recordValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
