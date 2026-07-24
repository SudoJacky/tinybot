import {
  backendRuntimeStatesToTurns,
  normalizeAgentTurnRuntimeStatePayload,
  normalizeAgentTimelinePatchPayload,
} from "./chatTurnModel";
import type {
  BackendAgentTurnRuntimeState,
  BackendAgentTimelinePatch,
  BackendAgentTimelineSnapshot,
  BackendAgentTurnItem,
  ChatTurn,
} from "./chatTurnModel";

export type TimelineDiagnostic = {
  code: "lower_item_revision";
  itemId: string;
  message: string;
  receivedRevision: number;
  turnId: string;
  sessionId: string;
};

export type ChatTimelineSnapshot = {
  schemaVersion: "tinybot.chat_timeline.v1";
  sessionId: string;
  source: "canonical";
  turnRevisions: Record<string, number>;
  turns: ChatTurn[];
  diagnostics: TimelineDiagnostic[];
};

export interface AgentTimelineModel {
  load(sessionId: string, runtimeStatePayloads: unknown[]): ChatTimelineSnapshot;
  applyPatch(sessionId: string, patchPayload: unknown): ChatTimelineSnapshot;
  snapshot(sessionId: string): ChatTimelineSnapshot;
}

export class TimelineRevisionGapError extends Error {
  constructor(
    message: string,
    readonly turnId: string,
    readonly expectedRevision: number,
    readonly receivedRevision: number,
  ) {
    super(message);
    this.name = "TimelineRevisionGapError";
  }
}

type SessionTimelineState = {
  diagnostics: TimelineDiagnostic[];
  turns: Map<string, BackendAgentTimelineSnapshot>;
};

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

export function createAgentTimelineModel(): AgentTimelineModel {
  const sessions = new Map<string, SessionTimelineState>();

  return {
    load(sessionId, runtimeStatePayloads) {
      const turns = new Map<string, BackendAgentTimelineSnapshot>();
      for (const payload of runtimeStatePayloads) {
        const runtimeState = normalizeAgentTurnRuntimeStatePayload(payload);
        const timeline = runtimeState.timeline;
        if (timeline.sessionId !== sessionId) {
          throw new Error(`Canonical timeline session mismatch: ${timeline.sessionId}, expected ${sessionId}`);
        }
        if (turns.has(timeline.turnId)) {
          throw new Error(`Canonical timeline contains duplicate turn ${timeline.turnId}`);
        }
        turns.set(timeline.turnId, timeline);
      }
      sessions.set(sessionId, { diagnostics: [], turns });
      return projectSessionSnapshot(sessionId, sessions.get(sessionId)!);
    },

    applyPatch(sessionId, patchPayload) {
      const patch = normalizeAgentTimelinePatchPayload(patchPayload);
      if (patch.sessionId !== sessionId) {
        throw new Error(`Canonical timeline patch session mismatch: ${patch.sessionId}, expected ${sessionId}`);
      }
      const session = sessions.get(sessionId);
      if (!session) {
        throw new Error(`Canonical timeline session ${sessionId} has not been loaded`);
      }
      applyPatchToSession(session, patch);
      return projectSessionSnapshot(sessionId, session);
    },

    snapshot(sessionId) {
      const session = sessions.get(sessionId);
      if (!session) {
        return emptyTimelineSnapshot(sessionId);
      }
      return projectSessionSnapshot(sessionId, session);
    },
  };
}

function applyPatchToSession(session: SessionTimelineState, patch: BackendAgentTimelinePatch): void {
  const turn = session.turns.get(patch.turnId);
  if (!turn) {
    if (patch.snapshotRevision > 1) {
      throw new TimelineRevisionGapError(
        `Canonical timeline patch gap for new turn ${patch.turnId}: expected 0 or 1, received ${patch.snapshotRevision}`,
        patch.turnId,
        0,
        patch.snapshotRevision,
      );
    }
    session.turns.set(patch.turnId, {
      schemaVersion: "tinybot.timeline.v2",
      sessionId: patch.sessionId,
      turnId: patch.turnId,
      snapshotRevision: patch.snapshotRevision,
      items: [patch.item],
    });
    return;
  }

  if (patch.snapshotRevision < turn.snapshotRevision) {
    return;
  }
  if (patch.snapshotRevision === turn.snapshotRevision) {
    const current = turn.items.find((item) => item.itemId === patch.item.itemId);
    if (!current) {
      turn.items = [...turn.items, patch.item].sort(compareCanonicalItems);
      return;
    }
    if (patch.item.revision < current.revision) {
      return;
    }
    if (patch.item.revision === current.revision) {
      if (stableSerialize(current) !== stableSerialize(patch.item)) {
        throw new Error(`Canonical timeline equal-revision conflict for item ${patch.item.itemId} revision ${patch.item.revision}`);
      }
      return;
    }
    if (patch.item.sequence !== current.sequence) {
      throw new Error(`Canonical timeline item ${patch.item.itemId} changed sequence from ${current.sequence} to ${patch.item.sequence}`);
    }
    assertMonotonicStatus(current, patch.item);
    assertMonotonicAssistantPhase(current, patch.item);
    turn.items = turn.items.map((item) => item.itemId === patch.item.itemId ? patch.item : item);
    return;
  }
  if (patch.snapshotRevision !== turn.snapshotRevision + 1) {
    throw new TimelineRevisionGapError(
      `Canonical timeline patch gap for turn ${patch.turnId}: expected ${turn.snapshotRevision + 1}, received ${patch.snapshotRevision}`,
      patch.turnId,
      turn.snapshotRevision + 1,
      patch.snapshotRevision,
    );
  }

  const index = turn.items.findIndex((item) => item.itemId === patch.item.itemId);
  if (index < 0) {
    turn.items = [...turn.items, patch.item].sort(compareCanonicalItems);
    turn.snapshotRevision = patch.snapshotRevision;
    return;
  }

  const current = turn.items[index];
  if (patch.item.sequence !== current.sequence) {
    throw new Error(`Canonical timeline item ${patch.item.itemId} changed sequence from ${current.sequence} to ${patch.item.sequence}`);
  }
  if (patch.item.revision < current.revision) {
    session.diagnostics.push({
      code: "lower_item_revision",
      itemId: patch.item.itemId,
      message: `Ignored item revision ${patch.item.revision}; current revision is ${current.revision}`,
      receivedRevision: patch.item.revision,
      turnId: patch.turnId,
      sessionId: patch.sessionId,
    });
    turn.snapshotRevision = patch.snapshotRevision;
    return;
  }
  if (patch.item.revision === current.revision) {
    throw new Error(`Canonical timeline mutation ${patch.snapshotRevision} did not advance item ${patch.item.itemId} revision ${current.revision}`);
  }
  assertMonotonicStatus(current, patch.item);
  assertMonotonicAssistantPhase(current, patch.item);
  turn.items = turn.items.map((item, itemIndex) => itemIndex === index ? patch.item : item);
  turn.snapshotRevision = patch.snapshotRevision;
}

function assertMonotonicAssistantPhase(current: BackendAgentTurnItem, incoming: BackendAgentTurnItem): void {
  if (current.kind !== "assistant_message" || incoming.kind !== "assistant_message") {
    return;
  }
  const currentPhase = String(current.data.phase);
  const incomingPhase = String(incoming.data.phase);
  if (currentPhase !== incomingPhase && currentPhase !== "unknown") {
    throw new Error(`Canonical assistant item ${current.itemId} cannot transition phase from ${currentPhase} to ${incomingPhase}`);
  }
}

function assertMonotonicStatus(current: BackendAgentTurnItem, incoming: BackendAgentTurnItem): void {
  if (TERMINAL_STATUSES.has(current.status) && incoming.status !== current.status) {
    throw new Error(`Canonical timeline item ${current.itemId} cannot transition from ${current.status} to ${incoming.status}`);
  }
}

function projectSessionSnapshot(sessionId: string, state: SessionTimelineState): ChatTimelineSnapshot {
  const runtimeStates: BackendAgentTurnRuntimeState[] = [...state.turns.values()].map((timeline) => ({
    runtimeEvents: [],
    timeline,
  }));
  return {
    schemaVersion: "tinybot.chat_timeline.v1",
    sessionId,
    source: "canonical",
    turnRevisions: Object.fromEntries([...state.turns].map(([turnId, turn]) => [turnId, turn.snapshotRevision])),
    turns: backendRuntimeStatesToTurns(sessionId, runtimeStates),
    diagnostics: [...state.diagnostics],
  };
}

function emptyTimelineSnapshot(sessionId: string): ChatTimelineSnapshot {
  return {
    schemaVersion: "tinybot.chat_timeline.v1",
    sessionId,
    source: "canonical",
    turnRevisions: {},
    turns: [],
    diagnostics: [],
  };
}

function compareCanonicalItems(left: BackendAgentTurnItem, right: BackendAgentTurnItem): number {
  return left.sequence - right.sequence || left.itemId.localeCompare(right.itemId);
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
