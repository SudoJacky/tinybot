import type { JsonObject } from "../protocol/messages.ts";
import type { NativeRpcClient } from "../tools/nativeToolProxy.ts";
import type { DreamCommandBridge } from "./agentWorker.ts";
import type { DreamCommandRequest, DreamCommandResult, DreamLogCommandRequest, DreamRestoreCommandRequest } from "../command/commandTypes.ts";

export type DreamBatchKind = "conversation_evidence" | "legacy_history";

export type DreamProviderNote = {
  content: string;
  noteType: string;
  scope?: string;
  priority?: number;
  confidence?: number;
  tags?: string[];
  metadata?: JsonObject;
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
    content: note.content,
    note_type: note.noteType,
    ...(note.scope ? { scope: note.scope } : {}),
    ...(note.priority !== undefined ? { priority: note.priority } : {}),
    ...(note.confidence !== undefined ? { confidence: note.confidence } : {}),
    ...(note.tags && note.tags.length > 0 ? { tags: note.tags } : {}),
    ...(note.metadata ? { metadata: note.metadata } : {}),
  };
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
