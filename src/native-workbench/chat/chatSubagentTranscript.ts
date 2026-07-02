import type { LiveSubagent, ToolCallStatus } from "./chatUiProjection";

export type SubagentTraceSelection = {
  activityId: string;
  sessionKey: string;
  delegateId?: string;
  traceRef?: string;
};

type TraceEventRecord = {
  eventId: string;
  eventType: string;
  createdAt: string;
  payload: Record<string, unknown>;
};

export function applyLoadedSubagentTrace(subagent: LiveSubagent, payload: unknown): LiveSubagent {
  const trace = traceRecord(payload);
  if (!trace) {
    return subagent;
  }
  const events = traceEvents(trace);
  const finalOutput = stringField(trace, ["finalOutput", "final_output"]);
  const messages = events.flatMap((event, index) => transcriptMessage(event, index));
  if (finalOutput && !messages.some((message) => message.content === finalOutput)) {
    messages.push({
      id: `${subagent.id}:final-output`,
      role: "assistant",
      content: finalOutput,
    });
  }
  const toolSummaries = events.map((event, index) => ({
    id: event.eventId || `${subagent.id}:trace-tool-${index + 1}`,
    name: event.eventType || "delegate.event",
    status: toolStatusFromTraceEvent(event),
    preview: eventPreview(event),
  }));
  return {
    ...subagent,
    latestActivity: finalOutput || messages[messages.length - 1]?.content || subagent.latestActivity,
    capabilities: mergeCapabilities(subagent.capabilities, ["full_transcript", "can_forward"]),
    transcript: {
      id: subagent.transcript.id,
      sessionKey: subagent.transcript.sessionKey,
      capability: "full_transcript",
      messages: messages.length ? messages : subagent.transcript.messages,
      toolSummaries: toolSummaries.length ? toolSummaries : subagent.transcript.toolSummaries,
    },
  };
}

function traceRecord(payload: unknown): Record<string, unknown> | null {
  if (!isRecord(payload)) {
    return null;
  }
  const nested = payload.trace;
  return isRecord(nested) ? nested : payload;
}

function traceEvents(trace: Record<string, unknown>): TraceEventRecord[] {
  const events = Array.isArray(trace.events) ? trace.events : [];
  return events.filter(isRecord).map((event, index) => ({
    eventId: stringField(event, ["eventId", "event_id", "id"]) || `trace-event-${index + 1}`,
    eventType: stringField(event, ["eventType", "event_type", "type", "kind"]) || "delegate.event",
    createdAt: stringField(event, ["createdAt", "created_at", "timestamp"]),
    payload: isRecord(event.payload) ? event.payload : {},
  }));
}

function transcriptMessage(event: TraceEventRecord, index: number): Array<{ id: string; role: string; content: string; timestamp?: string }> {
  const content = eventPreview(event);
  if (!content) {
    return [];
  }
  return [{
    id: `${event.eventId}:message-${index + 1}`,
    role: transcriptRole(event),
    content,
    ...(event.createdAt ? { timestamp: event.createdAt } : {}),
  }];
}

function transcriptRole(event: TraceEventRecord): string {
  const explicit = stringField(event.payload, ["role", "author"]);
  if (explicit) {
    return explicit;
  }
  const eventType = event.eventType.toLowerCase();
  if (eventType.includes("message_queued") || eventType.includes("user")) {
    return "user";
  }
  if (eventType.includes("completed") || eventType.includes("assistant")) {
    return "assistant";
  }
  return "system";
}

function eventPreview(event: TraceEventRecord): string {
  return stringField(event.payload, [
    "content",
    "text",
    "message",
    "summary",
    "output",
    "result",
    "finalOutput",
    "final_output",
    "resultPreview",
    "result_preview",
    "latestActivity",
    "latest_activity",
  ]);
}

function toolStatusFromTraceEvent(event: TraceEventRecord): ToolCallStatus {
  const value = stringField(event.payload, ["status", "state", "phase"]).toLowerCase();
  if (value === "running" || value === "pending" || value === "completed" || value === "failed") {
    return value;
  }
  if (value === "complete" || value === "succeeded") {
    return "completed";
  }
  if (value === "error") {
    return "failed";
  }
  if (value === "awaiting_approval" || value === "approval_required" || value === "blocked") {
    return "waiting_approval";
  }
  const eventType = event.eventType.toLowerCase();
  if (eventType.endsWith(".completed")) {
    return "completed";
  }
  if (eventType.endsWith(".failed")) {
    return "failed";
  }
  if (eventType.includes("approval")) {
    return "waiting_approval";
  }
  if (eventType.endsWith(".running") || eventType.endsWith(".started")) {
    return "running";
  }
  return "unknown";
}

function mergeCapabilities(
  current: LiveSubagent["capabilities"],
  next: LiveSubagent["capabilities"],
): LiveSubagent["capabilities"] {
  return [...new Set([...current.filter((capability) => capability !== "partial_transcript"), ...next])];
}

function stringField(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
