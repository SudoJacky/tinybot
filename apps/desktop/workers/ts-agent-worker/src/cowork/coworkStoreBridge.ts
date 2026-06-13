import { isJsonObject, type JsonObject } from "../protocol/messages.ts";
import type { NativeRpcClient } from "../tools/nativeToolProxy.ts";
import { nativeCoworkSession, normalizeCoworkSession, normalizeCoworkStore } from "./coworkSerde.ts";
import type { CoworkEvent, CoworkSession } from "./coworkTypes.ts";

export class NativeCoworkStoreBridge {
  private readonly rpcClient: NativeRpcClient;

  constructor(rpcClient: NativeRpcClient) {
    this.rpcClient = rpcClient;
  }

  async listSnapshots(traceId: string): Promise<CoworkSession[]> {
    const result = await this.rpcClient.request(traceId, "cowork_store.list_snapshots", {});
    const payload = asObject(result);
    if (Array.isArray(payload?.sessions)) {
      return normalizeCoworkStore(payload).sessions;
    }
    if (Array.isArray(payload?.snapshots)) {
      return normalizeCoworkStore({ version: payload.version, sessions: payload.snapshots }).sessions;
    }
    return [];
  }

  async readSnapshot(sessionId: string, traceId: string): Promise<CoworkSession | null> {
    const result = await this.rpcClient.request(traceId, "cowork_store.read_snapshot", {
      session_id: sessionId,
    });
    const payload = asObject(result);
    const rawSession = payload && "session" in payload
      ? payload.session
      : payload && "snapshot" in payload
        ? payload.snapshot
        : result;
    return isJsonObject(rawSession) ? normalizeCoworkSession(rawSession) : null;
  }

  async writeSnapshot(session: CoworkSession, traceId: string): Promise<CoworkSession> {
    const result = await this.rpcClient.request(traceId, "cowork_store.write_snapshot", {
      session: nativeCoworkSession(session),
    });
    const payload = asObject(result);
    const rawSession = payload && "session" in payload
      ? payload.session
      : payload && "snapshot" in payload
        ? payload.snapshot
        : undefined;
    return isJsonObject(rawSession) ? normalizeCoworkSession(rawSession) : session;
  }

  async appendEvent(sessionId: string, event: CoworkEvent, traceId: string): Promise<string> {
    const result = await this.rpcClient.request(traceId, "cowork_store.append_event", {
      session_id: sessionId,
      event,
    });
    const payload = asObject(result);
    return typeof payload?.event_id === "string" ? payload.event_id : "";
  }

  async readEvents(sessionId: string, traceId: string): Promise<CoworkEvent[]> {
    const events = await this.readEventLogRecords(sessionId, traceId);
    return events.map(normalizeCoworkEvent).filter((event): event is CoworkEvent => event !== null);
  }

  async readTraceSpans(sessionId: string, traceId: string): Promise<JsonObject[]> {
    const events = await this.readEventLogRecords(sessionId, traceId);
    return events.map(normalizeCoworkTraceSpan).filter((span): span is JsonObject => span !== null);
  }

  async readAgentSteps(sessionId: string, traceId: string): Promise<JsonObject[]> {
    const events = await this.readEventLogRecords(sessionId, traceId);
    return events.map(normalizeCoworkAgentStep).filter((step): step is JsonObject => step !== null);
  }

  async readToolObservations(sessionId: string, traceId: string): Promise<JsonObject[]> {
    const events = await this.readEventLogRecords(sessionId, traceId);
    return events.map(normalizeCoworkToolObservation).filter((observation): observation is JsonObject => observation !== null);
  }

  async readBrowserObservations(sessionId: string, traceId: string): Promise<JsonObject[]> {
    const events = await this.readEventLogRecords(sessionId, traceId);
    return events.map(normalizeCoworkBrowserObservation).filter((observation): observation is JsonObject => observation !== null);
  }

  async readObservationDetails(sessionId: string, traceId: string): Promise<JsonObject[]> {
    const events = await this.readEventLogRecords(sessionId, traceId);
    return events.flatMap(normalizeCoworkObservationDetails);
  }

  async readSensitiveArtifacts(sessionId: string, traceId: string): Promise<JsonObject[]> {
    const events = await this.readEventLogRecords(sessionId, traceId);
    return events.flatMap(normalizeCoworkSensitiveArtifacts);
  }

  private async readEventLogRecords(sessionId: string, traceId: string): Promise<unknown[]> {
    const result = await this.rpcClient.request(traceId, "cowork_store.read_events", {
      session_id: sessionId,
    });
    const payload = asObject(result);
    return Array.isArray(payload?.events) ? payload.events : [];
  }

  async ensureSessionWorkspace(sessionId: string, traceId: string): Promise<string> {
    const result = await this.rpcClient.request(traceId, "cowork_store.ensure_session_workspace", {
      session_id: sessionId,
    });
    const payload = asObject(result);
    return typeof payload?.workspace_dir === "string" ? payload.workspace_dir : "";
  }

  async deleteSession(sessionId: string, traceId: string): Promise<boolean> {
    const result = await this.rpcClient.request(traceId, "cowork_store.delete_session", {
      session_id: sessionId,
    });
    const payload = asObject(result);
    return payload?.deleted === true;
  }
}

function asObject(value: unknown): JsonObject | undefined {
  return isJsonObject(value) ? value : undefined;
}

function normalizeCoworkEvent(value: unknown): CoworkEvent | null {
  if (!isJsonObject(value) || typeof value.type !== "string") {
    return null;
  }
  if (value.category === "trace") {
    return null;
  }
  if (value.category === "observation") {
    return null;
  }
  if (value.schema !== "cowork.event_log.v1" && typeof value.id === "string" && typeof value.message === "string") {
    return { ...value } as CoworkEvent;
  }
  const payload = isJsonObject(value.payload) ? { ...value.payload } : {};
  const data = isJsonObject(value.data) ? { ...value.data } : payload;
  const message = typeof value.message === "string"
    ? value.message
    : typeof payload.message === "string"
      ? payload.message
      : typeof payload.summary === "string"
        ? payload.summary
        : value.type;
  return {
    id: typeof value.id === "string" && value.id
      ? value.id
      : fallbackEventId(value.type, value.created_at),
    type: value.type,
    message,
    actor_id: typeof value.actor_id === "string" ? value.actor_id : null,
    data,
    created_at: typeof value.created_at === "string" ? value.created_at : "",
  };
}

function normalizeCoworkAgentStep(value: unknown): JsonObject | null {
  if (!isJsonObject(value)) {
    return null;
  }
  if (value.category !== "observation" || !String(value.type ?? "").startsWith("agent_step.")) {
    return null;
  }
  const payload = isJsonObject(value.payload) ? value.payload : {};
  const step = isJsonObject(payload.agent_step) ? payload.agent_step : payload;
  const stepId = typeof step.id === "string" && step.id ? step.id : typeof value.id === "string" ? value.id : "";
  if (!stepId) {
    return null;
  }
  return {
    ...step,
    id: stepId,
    session_id: typeof step.session_id === "string" && step.session_id
      ? step.session_id
      : typeof value.session_id === "string" ? value.session_id : "",
  };
}

function normalizeCoworkToolObservation(value: unknown): JsonObject | null {
  if (!isJsonObject(value)) {
    return null;
  }
  if (value.category !== "observation" || value.type !== "tool_observation.recorded") {
    return null;
  }
  const payload = isJsonObject(value.payload) ? value.payload : {};
  const observation = isJsonObject(payload.tool_observation) ? payload.tool_observation : payload;
  const observationId = typeof observation.id === "string" && observation.id
    ? observation.id
    : typeof value.id === "string" ? value.id : "";
  if (!observationId) {
    return null;
  }
  return {
    ...observation,
    id: observationId,
  };
}

function normalizeCoworkBrowserObservation(value: unknown): JsonObject | null {
  if (!isJsonObject(value)) {
    return null;
  }
  if (value.category !== "observation" || value.type !== "browser_observation.recorded") {
    return null;
  }
  const payload = isJsonObject(value.payload) ? value.payload : {};
  const observation = isJsonObject(payload.browser_observation) ? payload.browser_observation : payload;
  const observationId = typeof observation.id === "string" && observation.id
    ? observation.id
    : typeof value.id === "string" ? value.id : "";
  if (!observationId) {
    return null;
  }
  return {
    ...observation,
    id: observationId,
  };
}

function normalizeCoworkObservationDetails(value: unknown): JsonObject[] {
  return observationPayloadObjects(value, [
    "observation_detail",
    "full_observation_detail",
    "observationDetail",
    "fullObservationDetail",
  ], [
    "observation_details",
    "full_observation_details",
    "observationDetails",
    "fullObservationDetails",
  ]);
}

function normalizeCoworkSensitiveArtifacts(value: unknown): JsonObject[] {
  return observationPayloadObjects(value, [
    "sensitive_artifact",
    "sensitiveArtifact",
  ], [
    "sensitive_artifacts",
    "sensitiveArtifacts",
  ]);
}

function observationPayloadObjects(value: unknown, singularKeys: string[], collectionKeys: string[]): JsonObject[] {
  if (!isJsonObject(value) || value.category !== "observation") {
    return [];
  }
  const payload = isJsonObject(value.payload) ? value.payload : {};
  const objects: JsonObject[] = [];
  for (const key of singularKeys) {
    const item = payload[key];
    if (isJsonObject(item) && typeof item.id === "string" && item.id) {
      objects.push({ ...item });
    }
  }
  for (const key of collectionKeys) {
    const collection = payload[key];
    const items = Array.isArray(collection)
      ? collection
      : isJsonObject(collection) ? Object.values(collection) : [];
    for (const item of items) {
      if (isJsonObject(item) && typeof item.id === "string" && item.id) {
        objects.push({ ...item });
      }
    }
  }
  return objects;
}

function normalizeCoworkTraceSpan(value: unknown): JsonObject | null {
  if (!isJsonObject(value)) {
    return null;
  }
  if (value.category !== "trace" && value.type !== "trace.span_recorded") {
    return null;
  }
  const payload = isJsonObject(value.payload) ? value.payload : {};
  const span = isJsonObject(payload.span) ? payload.span : payload;
  const spanId = typeof span.id === "string" && span.id ? span.id : typeof value.id === "string" ? value.id : "";
  if (!spanId) {
    return null;
  }
  return {
    ...span,
    id: spanId,
    session_id: typeof span.session_id === "string" && span.session_id
      ? span.session_id
      : typeof value.session_id === "string" ? value.session_id : "",
  };
}

function fallbackEventId(type: string, createdAt: unknown): string {
  const suffix = typeof createdAt === "string" && createdAt ? createdAt : "unknown";
  return `event:${type}:${suffix}`;
}
