import type {
  AssistantMessagePhase,
  BackendAgentTimelinePatch,
  BackendAgentTimelineSnapshot,
  BackendAgentTurnItem,
  BackendAgentTurnRuntimeState,
  BackendAgentTurnStatus,
  CanonicalTurnItemData,
  CanonicalTurnItemKind,
} from "./chatTurnContracts";
import { sanitizeTextPreview } from "./chatPreview";

const CANONICAL_ITEM_KINDS = new Set<CanonicalTurnItemKind>([
  "user_message",
  "assistant_message",
  "reasoning",
  "tool_call",
  "form",
  "subagent_lifecycle",
  "subagent_message",
  "plan_progress",
  "context_compaction",
  "usage",
  "file_reference",
  "error",
  "system_notice",
]);

export function normalizeAgentTurnRuntimeStatePayload(payload: unknown): BackendAgentTurnRuntimeState {
  const value = payloadRecord(payload);
  const timeline = normalizeAgentTimelineSnapshotPayload(value.timeline);
  const status = normalizeBackendAgentTurnStatus(value.status);
  const completedAt = payloadString(value.completedAt ?? value.completed_at) || undefined;
  const stopReason = payloadString(value.stopReason ?? value.stop_reason) || undefined;
  return {
    runtimeEvents: Array.isArray(value.runtimeEvents)
      ? value.runtimeEvents
      : Array.isArray(value.runtime_events)
        ? value.runtime_events
        : [],
    ...(status ? { status } : {}),
    ...(completedAt ? { completedAt } : {}),
    ...(stopReason ? { stopReason } : {}),
    timeline,
  };
}

export function normalizeAgentTimelineSnapshotPayload(payload: unknown): BackendAgentTimelineSnapshot {
  const timeline = payloadRecord(payload);
  if (payloadString(timeline.schemaVersion) !== "tinybot.timeline.v2") {
    throw new Error(`Unsupported canonical timeline schema: ${payloadString(timeline.schemaVersion) || "missing"}`);
  }
  const sessionId = requiredCanonicalString(timeline, "sessionId");
  const turnId = requiredCanonicalString(timeline, "turnId");
  const snapshotRevision = requiredCanonicalNumber(timeline, "snapshotRevision");
  if (!Array.isArray(timeline.items)) {
    throw new Error(`Canonical timeline ${turnId} is missing items`);
  }
  const seenItemIds = new Set<string>();
  const items = timeline.items.map((raw, index) => {
    if (!isPayloadRecord(raw)) {
      throw new Error(`Canonical timeline ${turnId} item ${index} is not an object`);
    }
    const item = normalizeCanonicalTurnItem(raw, sessionId, turnId);
    if (seenItemIds.has(item.itemId)) {
      throw new Error(`Canonical timeline ${turnId} contains duplicate item ${item.itemId}`);
    }
    seenItemIds.add(item.itemId);
    return item;
  });
  return {
    schemaVersion: "tinybot.timeline.v2",
    sessionId,
    turnId,
    snapshotRevision,
    items,
  };
}

export function normalizeAgentTimelinePatchPayload(payload: unknown): BackendAgentTimelinePatch {
  const value = payloadRecord(payload);
  if (payloadString(value.schemaVersion) !== "tinybot.timeline_patch.v2") {
    throw new Error(`Unsupported canonical timeline patch schema: ${payloadString(value.schemaVersion) || "missing"}`);
  }
  const sessionId = requiredCanonicalString(value, "sessionId");
  const turnId = requiredCanonicalString(value, "turnId");
  if (!isPayloadRecord(value.item)) {
    throw new Error(`Canonical timeline patch ${sessionId}/${turnId} is missing item`);
  }
  return {
    schemaVersion: "tinybot.timeline_patch.v2",
    sessionId,
    turnId,
    snapshotRevision: requiredCanonicalNumber(value, "snapshotRevision"),
    item: normalizeCanonicalTurnItem(value.item, sessionId, turnId),
  };
}

function normalizeBackendAgentTurnStatus(value: unknown): BackendAgentTurnStatus | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error("Canonical turn runtime status must be a string");
  }
  switch (value) {
    case "running":
    case "waiting":
    case "completed":
    case "failed":
    case "cancelled":
    case "interrupted":
      return value;
    default:
      throw new Error(`Unsupported canonical turn runtime status: ${value}`);
  }
}

function normalizeCanonicalTurnItem(
  raw: Record<string, unknown>,
  sessionId: string,
  turnId: string,
): BackendAgentTurnItem {
  if (payloadString(raw.schemaVersion) !== "tinybot.turn_item.v2") {
    throw new Error(`Unsupported canonical item schema for ${payloadString(raw.itemId) || "unknown item"}`);
  }
  const itemId = requiredCanonicalString(raw, "itemId");
  const itemSessionId = requiredCanonicalString(raw, "sessionId");
  const itemTurnId = requiredCanonicalString(raw, "turnId");
  if (itemSessionId !== sessionId || itemTurnId !== turnId) {
    throw new Error(`Canonical item ${itemId} identity does not match timeline ${sessionId}/${turnId}`);
  }
  const kind = payloadString(raw.kind) as CanonicalTurnItemKind;
  if (!CANONICAL_ITEM_KINDS.has(kind)) {
    throw new Error(`Canonical item ${itemId} has unsupported kind ${kind || "missing"}`);
  }
  const data = payloadRecord(raw.data);
  if (payloadString(data.type) !== kind) {
    throw new Error(`Canonical item ${itemId} kind/data mismatch: ${kind}/${payloadString(data.type) || "missing"}`);
  }
  if (kind === "assistant_message") {
    requiredCanonicalString(data, "modelCallId");
    assistantMessagePhase(data.phase, itemId);
  }
  if (kind === "reasoning") {
    requiredCanonicalString(data, "modelCallId");
  }
  return {
    schemaVersion: "tinybot.turn_item.v2",
    itemId,
    sessionId: itemSessionId,
    ...(payloadString(raw.threadId) ? { threadId: payloadString(raw.threadId) } : {}),
    turnId: itemTurnId,
    ...(payloadString(raw.parentItemId) ? { parentItemId: payloadString(raw.parentItemId) } : {}),
    sequence: requiredCanonicalNumber(raw, "sequence"),
    revision: requiredCanonicalNumber(raw, "revision"),
    kind,
    status: requiredCanonicalString(raw, "status"),
    createdAt: requiredCanonicalString(raw, "createdAt"),
    ...(payloadString(raw.updatedAt) ? { updatedAt: payloadString(raw.updatedAt) } : {}),
    ...(payloadString(raw.title) ? { title: payloadString(raw.title) } : {}),
    ...(payloadString(raw.summary) ? { summary: sanitizeTextPreview(payloadString(raw.summary)) } : {}),
    data: data as CanonicalTurnItemData,
  };
}

function assistantMessagePhase(value: unknown, itemId: string): AssistantMessagePhase {
  const phase = payloadString(value);
  if (phase === "unknown" || phase === "commentary" || phase === "final_answer") {
    return phase;
  }
  throw new Error(`Canonical assistant item ${itemId} has invalid phase ${phase || "missing"}`);
}

function requiredCanonicalString(value: Record<string, unknown>, key: string): string {
  const result = payloadString(value[key]);
  if (!result) {
    throw new Error(`Canonical timeline field ${key} is required`);
  }
  return result;
}

function requiredCanonicalNumber(value: Record<string, unknown>, key: string): number {
  const result = payloadNumber(value[key]);
  if (result === undefined || !Number.isInteger(result) || result < 0) {
    throw new Error(`Canonical timeline field ${key} must be a non-negative integer`);
  }
  return result;
}

function payloadRecord(value: unknown): Record<string, unknown> {
  return isPayloadRecord(value) ? value : {};
}

function isPayloadRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function payloadString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function payloadNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}
