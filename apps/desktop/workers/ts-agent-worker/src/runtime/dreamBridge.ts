import type { JsonObject } from "../protocol/messages.ts";
import type { NativeRpcClient } from "../tools/nativeToolProxy.ts";
import type { DreamCommandBridge } from "./agentWorker.ts";
import type { DreamCommandRequest, DreamCommandResult, DreamLogCommandRequest, DreamRestoreCommandRequest } from "../command/commandTypes.ts";
import type { AgentMessage } from "../agent/agentRunSpec.ts";
import type { ModelProvider } from "../model/provider.ts";

export type DreamBatchKind = "conversation_evidence" | "legacy_history";

export type DreamProviderNote = {
  action?: "save" | "supersede" | "reject";
  content: string;
  noteType: string;
  scope?: string;
  priority?: number;
  confidence?: number;
  tags?: string[];
  metadata?: JsonObject;
  targetNoteId?: string;
  evidenceIds?: string[];
};

export type DreamApplyBatchRequest = DreamCommandRequest & {
  kind: DreamBatchKind;
  cursorStart: number;
  cursorEnd: number;
  evidenceIds?: string[];
  notes: DreamProviderNote[];
};

export class NativeDreamBridge implements DreamCommandBridge {
  private readonly rpcClient: NativeRpcClient;

  constructor(rpcClient: NativeRpcClient) {
    this.rpcClient = rpcClient;
  }

  async runDream(request: DreamCommandRequest): Promise<DreamCommandResult> {
    return dreamResult(await this.rpcClient.request(request.traceId, "memory.dream_run", {
      ...sessionParams(request.sessionId),
    }));
  }

  async getDreamLog(request: DreamLogCommandRequest): Promise<DreamCommandResult> {
    return dreamResult(await this.rpcClient.request(request.traceId, "memory.dream_log", {
      ...sessionParams(request.sessionId),
      ...(request.sha ? { sha: request.sha } : {}),
    }));
  }

  async restoreDream(request: DreamRestoreCommandRequest): Promise<DreamCommandResult> {
    return dreamResult(await this.rpcClient.request(request.traceId, "memory.dream_restore", {
      ...sessionParams(request.sessionId),
      ...(request.sha ? { sha: request.sha } : {}),
    }));
  }

  async getPendingDreamBatch(request: DreamCommandRequest): Promise<JsonObject> {
    return jsonObjectResult(await this.rpcClient.request(request.traceId, "memory.dream_pending", {
      ...sessionParams(request.sessionId),
    }));
  }

  async applyDreamBatch(request: DreamApplyBatchRequest): Promise<JsonObject> {
    return jsonObjectResult(await this.rpcClient.request(request.traceId, "memory.dream_apply", {
      ...sessionParams(request.sessionId),
      kind: request.kind,
      cursor_start: request.cursorStart,
      cursor_end: request.cursorEnd,
      ...(request.evidenceIds && request.evidenceIds.length > 0 ? { evidence_ids: request.evidenceIds } : {}),
      notes: request.notes.map(dreamProviderNoteParams),
    }));
  }
}

export type ProviderBackedDreamBridgeOptions = {
  nativeBridge: NativeDreamBridge;
  provider: ModelProvider;
  model: string;
};

type DreamBatch = {
  kind: DreamBatchKind | "none";
  records: unknown[];
  cursorStart: number;
  cursorEnd: number;
  evidenceIds: string[];
  memoryContext: DreamMemoryContext;
};

type DreamMemoryContext = {
  currentNotes: string;
  currentMemory: string;
  currentSoul: string;
  currentUser: string;
};

type ParsedDreamOperations = {
  notes: DreamProviderNote[];
  skippedOperations: number;
};

export class ProviderBackedDreamBridge implements DreamCommandBridge {
  private readonly nativeBridge: NativeDreamBridge;
  private readonly provider: ModelProvider;
  private readonly model: string;

  constructor(options: ProviderBackedDreamBridgeOptions) {
    this.nativeBridge = options.nativeBridge;
    this.provider = options.provider;
    this.model = options.model;
  }

  async runDream(request: DreamCommandRequest): Promise<DreamCommandResult> {
    const nativeResult = await this.nativeBridge.runDream(request);
    if (nativeResult.metadata?.deferred !== true) {
      return nativeResult;
    }

    const batch = dreamBatch(await this.nativeBridge.getPendingDreamBatch(request));
    if (batch.kind !== "conversation_evidence" && batch.kind !== "legacy_history") {
      return nativeResult;
    }

    const response = await this.provider.complete(dreamProviderMessages(batch), { model: this.model });
    const parsed = parseDreamOperations(response.content);
    if (!parsed) {
      return {
        content: "Dream provider extraction failed; cursor unchanged.",
        metadata: {
          changed: false,
          provider_backed: true,
          deferred: true,
          error: "invalid_provider_json",
        },
      };
    }

    const applyResult = await this.nativeBridge.applyDreamBatch({
      traceId: request.traceId,
      sessionId: request.sessionId,
      kind: batch.kind,
      cursorStart: batch.cursorStart,
      cursorEnd: batch.cursorEnd,
      evidenceIds: batch.evidenceIds,
      notes: parsed.notes,
    });
    const appliedNotes = numberValue(applyResult.applied_notes) ?? 0;
    return {
      content: `Dream applied ${appliedNotes} provider memory note operation(s) from ${batch.records.length} ${dreamBatchLabel(batch.kind)}.`,
      metadata: {
        changed: applyResult.changed === true,
        provider_backed: true,
        applied_notes: appliedNotes,
        skipped_operations: parsed.skippedOperations,
        ...cursorMetadata(batch.kind, applyResult),
      },
    };
  }

  getDreamLog(request: DreamLogCommandRequest): Promise<DreamCommandResult> {
    return this.nativeBridge.getDreamLog(request);
  }

  restoreDream(request: DreamRestoreCommandRequest): Promise<DreamCommandResult> {
    return this.nativeBridge.restoreDream(request);
  }
}

function sessionParams(sessionId: string | undefined): JsonObject {
  return sessionId ? { session_id: sessionId } : {};
}

function dreamResult(value: unknown): DreamCommandResult {
  if (!isJsonObject(value)) {
    return { content: "Dream command returned an invalid response." };
  }
  return {
    content: typeof value.content === "string" ? value.content : "",
    metadata: isJsonObject(value.metadata) ? value.metadata : undefined,
  };
}

function jsonObjectResult(value: unknown): JsonObject {
  return isJsonObject(value) ? value : {};
}

function dreamProviderNoteParams(note: DreamProviderNote): JsonObject {
  return {
    ...(note.action ? { action: note.action } : {}),
    content: note.content,
    note_type: note.noteType,
    ...(note.scope ? { scope: note.scope } : {}),
    ...(note.priority !== undefined ? { priority: note.priority } : {}),
    ...(note.confidence !== undefined ? { confidence: note.confidence } : {}),
    ...(note.tags && note.tags.length > 0 ? { tags: note.tags } : {}),
    ...(note.metadata ? { metadata: note.metadata } : {}),
    ...(note.targetNoteId ? { target_note_id: note.targetNoteId } : {}),
    ...(note.evidenceIds && note.evidenceIds.length > 0 ? { evidence_ids: note.evidenceIds } : {}),
  };
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const DREAM_SYSTEM_PROMPT = [
  "Compare Conversation Evidence or legacy conversation history against current Memory Notes and Memory Views.",
  "Output ONLY a JSON array of Memory Operations. No markdown, no prose.",
  "",
  "Each operation must contain action, scope, type, content, priority, confidence, evidence_ids, metadata, tags, and optional target_note_id.",
  "Supported actions: save, supersede, reject, skip.",
  "Only capture durable, reusable memory. Skip duplicates, ephemera, raw execution tactics, and temporary troubleshooting.",
].join("\n");

function dreamProviderMessages(batch: DreamBatch): AgentMessage[] {
  const primaryContext = batch.kind === "conversation_evidence"
    ? `## Conversation Evidence\n${formatDreamRecords(batch.records)}`
    : `## Conversation History\n${formatDreamRecords(batch.records)}`;
  return [
    { role: "system", content: DREAM_SYSTEM_PROMPT },
    {
      role: "user",
      content: `${primaryContext}\n\n${formatDreamMemoryContext(batch.memoryContext)}`,
    },
  ];
}

function formatDreamMemoryContext(context: DreamMemoryContext): string {
  return [
    `## Current Memory Notes\n${context.currentNotes || "(no Memory Notes)"}`,
    `## Current MEMORY.md\n${context.currentMemory || "(empty)"}`,
    `## Current SOUL.md\n${context.currentSoul || "(empty)"}`,
    `## Current USER.md\n${context.currentUser || "(empty)"}`,
  ].join("\n\n");
}

function formatDreamRecords(records: unknown[]): string {
  return records.map((record) => {
    const object = isJsonObject(record) ? record : {};
    const id = stringValue(object.id) ?? `cursor_${numberValue(object.cursor) ?? "unknown"}`;
    const cursor = numberValue(object.cursor) ?? 0;
    const role = stringValue(object.role)?.toUpperCase();
    const content = stringValue(object.content) ?? "";
    const index = numberValue(object.message_index);
    const timestamp = stringValue(object.timestamp);
    const details = [
      `[${id}] cursor=${cursor}`,
      index !== undefined ? `index=${index}` : undefined,
      timestamp ? `timestamp=${timestamp}` : undefined,
      role ? `${role}:` : undefined,
    ].filter((part): part is string => part !== undefined);
    return `${details.join(" ")} ${content}`.trim();
  }).join("\n");
}

function parseDreamOperations(content: string): ParsedDreamOperations | null {
  const parsed = parseJsonPayload(content);
  const items = Array.isArray(parsed)
    ? parsed
    : isJsonObject(parsed) && Array.isArray(parsed.operations)
      ? parsed.operations
      : isJsonObject(parsed)
        ? [parsed]
      : null;
  if (!items) {
    return null;
  }
  const notes: DreamProviderNote[] = [];
  let skippedOperations = 0;
  for (const item of items) {
    if (!isJsonObject(item)) {
      continue;
    }
    const action = dreamAction(item.action);
    if (action === "invalid") {
      continue;
    }
    if (action === "skip") {
      skippedOperations += 1;
      continue;
    }
    const note = dreamNoteFromOperation(item, action);
    if (note) {
      notes.push(note);
    }
  }
  return { notes, skippedOperations };
}

function parseJsonPayload(content: string): unknown {
  let raw = content.trim();
  if (raw.startsWith("```")) {
    const match = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (match) {
      raw = match[1]?.trim() ?? "";
    }
  }
  if (!raw || (raw[0] !== "[" && raw[0] !== "{")) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function dreamNoteFromOperation(value: JsonObject, action: "save" | "supersede" | "reject"): DreamProviderNote | null {
  const targetNoteId = stringValue(value.target_note_id) ?? stringValue(value.note_id);
  if (action === "reject") {
    return {
      action,
      content: "",
      noteType: "project",
      targetNoteId,
      metadata: objectValue(value.metadata),
    };
  }
  const content = stringValue(value.content);
  if (!content) {
    return null;
  }
  return {
    action,
    content,
    noteType: stringValue(value.type) ?? stringValue(value.note_type) ?? "project",
    scope: stringValue(value.scope),
    priority: numberValue(value.priority),
    confidence: numberValue(value.confidence) ?? 0.65,
    tags: stringListValue(value.tags, ["dream"]),
    metadata: objectValue(value.metadata),
    targetNoteId,
    evidenceIds: stringListValue(value.evidence_ids),
  };
}

function dreamAction(value: unknown): "save" | "supersede" | "reject" | "skip" | "invalid" {
  const action = typeof value === "string" && value.trim() ? value.trim().toLowerCase() : "save";
  if (action === "save" || action === "supersede" || action === "reject" || action === "skip") {
    return action;
  }
  return "invalid";
}

function dreamBatch(value: JsonObject): DreamBatch {
  return {
    kind: dreamBatchKind(value.kind),
    records: Array.isArray(value.records) ? value.records : [],
    cursorStart: numberValue(value.cursor_start) ?? 0,
    cursorEnd: numberValue(value.cursor_end) ?? 0,
    evidenceIds: stringListValue(value.evidence_ids),
    memoryContext: dreamMemoryContext(value.memory_context),
  };
}

function dreamMemoryContext(value: unknown): DreamMemoryContext {
  const object = isJsonObject(value) ? value : {};
  return {
    currentNotes: stringValue(object.current_notes) ?? "(no Memory Notes)",
    currentMemory: stringValueAllowEmpty(object.current_memory) ?? "(empty)",
    currentSoul: stringValueAllowEmpty(object.current_soul) ?? "(empty)",
    currentUser: stringValueAllowEmpty(object.current_user) ?? "(empty)",
  };
}

function dreamBatchKind(value: unknown): DreamBatchKind | "none" {
  return value === "conversation_evidence" || value === "legacy_history" ? value : "none";
}

function dreamBatchLabel(kind: DreamBatchKind): string {
  return kind === "conversation_evidence" ? "conversation evidence record(s)" : "legacy history record(s)";
}

function cursorMetadata(kind: DreamBatchKind, value: JsonObject): JsonObject {
  return kind === "conversation_evidence"
    ? { last_evidence_cursor: numberValue(value.last_evidence_cursor) }
    : { last_dream_cursor: numberValue(value.last_dream_cursor) };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function stringValueAllowEmpty(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function objectValue(value: unknown): JsonObject | undefined {
  return isJsonObject(value) ? value : undefined;
}

function stringListValue(value: unknown, fallback: string[] = []): string[] {
  if (!Array.isArray(value)) {
    return [...fallback];
  }
  const items = value
    .map((item) => stringValue(item))
    .filter((item): item is string => item !== undefined);
  return items.length > 0 ? items : [...fallback];
}
