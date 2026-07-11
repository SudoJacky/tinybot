import {
  backendRuntimeStatesToTurns,
  normalizeAgentRunRuntimeStatePayload,
  normalizeAgentTimelinePatchPayload,
} from "./chatRunModel";
import type {
  BackendAgentRunRuntimeState,
  BackendAgentTimelinePatch,
  BackendAgentTimelineSnapshot,
  BackendAgentTurnItem,
  ChatTurn,
} from "./chatRunModel";

export type TimelineDiagnostic = {
  code: "lower_item_revision";
  itemId: string;
  message: string;
  receivedRevision: number;
  runId: string;
  sessionId: string;
};

export type ChatTimelineSnapshot = {
  schemaVersion: "tinybot.chat_timeline.v1";
  sessionId: string;
  source: "canonical";
  runRevisions: Record<string, number>;
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
    readonly runId: string,
    readonly expectedRevision: number,
    readonly receivedRevision: number,
  ) {
    super(message);
    this.name = "TimelineRevisionGapError";
  }
}

type SessionTimelineState = {
  diagnostics: TimelineDiagnostic[];
  runs: Map<string, BackendAgentTimelineSnapshot>;
};

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

export function createAgentTimelineModel(): AgentTimelineModel {
  const sessions = new Map<string, SessionTimelineState>();

  return {
    load(sessionId, runtimeStatePayloads) {
      const runs = new Map<string, BackendAgentTimelineSnapshot>();
      for (const payload of runtimeStatePayloads) {
        const runtimeState = normalizeAgentRunRuntimeStatePayload(payload);
        const timeline = runtimeState.timeline;
        if (timeline.sessionId !== sessionId) {
          throw new Error(`Canonical timeline session mismatch: ${timeline.sessionId}, expected ${sessionId}`);
        }
        if (runs.has(timeline.runId)) {
          throw new Error(`Canonical timeline contains duplicate run ${timeline.runId}`);
        }
        runs.set(timeline.runId, timeline);
      }
      sessions.set(sessionId, { diagnostics: [], runs });
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
  const run = session.runs.get(patch.runId);
  if (!run) {
    if (patch.snapshotRevision !== 1) {
      throw new TimelineRevisionGapError(
        `Canonical timeline patch gap for new run ${patch.runId}: expected 1, received ${patch.snapshotRevision}`,
        patch.runId,
        1,
        patch.snapshotRevision,
      );
    }
    session.runs.set(patch.runId, {
      schemaVersion: "tinybot.timeline.v1",
      sessionId: patch.sessionId,
      runId: patch.runId,
      snapshotRevision: 1,
      items: [patch.item],
    });
    return;
  }

  if (patch.snapshotRevision <= run.snapshotRevision) {
    const current = run.items.find((item) => item.itemId === patch.item.itemId);
    if (patch.snapshotRevision === run.snapshotRevision && current && patch.item.revision === current.revision) {
      if (stableSerialize(current) !== stableSerialize(patch.item)) {
        throw new Error(`Canonical timeline equal-revision conflict for item ${patch.item.itemId} revision ${patch.item.revision}`);
      }
    }
    return;
  }
  if (patch.snapshotRevision !== run.snapshotRevision + 1) {
    throw new TimelineRevisionGapError(
      `Canonical timeline patch gap for run ${patch.runId}: expected ${run.snapshotRevision + 1}, received ${patch.snapshotRevision}`,
      patch.runId,
      run.snapshotRevision + 1,
      patch.snapshotRevision,
    );
  }

  const index = run.items.findIndex((item) => item.itemId === patch.item.itemId);
  if (index < 0) {
    run.items = [...run.items, patch.item].sort(compareCanonicalItems);
    run.snapshotRevision = patch.snapshotRevision;
    return;
  }

  const current = run.items[index];
  if (patch.item.sequence !== current.sequence) {
    throw new Error(`Canonical timeline item ${patch.item.itemId} changed sequence from ${current.sequence} to ${patch.item.sequence}`);
  }
  if (patch.item.revision < current.revision) {
    session.diagnostics.push({
      code: "lower_item_revision",
      itemId: patch.item.itemId,
      message: `Ignored item revision ${patch.item.revision}; current revision is ${current.revision}`,
      receivedRevision: patch.item.revision,
      runId: patch.runId,
      sessionId: patch.sessionId,
    });
    run.snapshotRevision = patch.snapshotRevision;
    return;
  }
  if (patch.item.revision === current.revision) {
    throw new Error(`Canonical timeline mutation ${patch.snapshotRevision} did not advance item ${patch.item.itemId} revision ${current.revision}`);
  }
  assertMonotonicStatus(current, patch.item);
  run.items = run.items.map((item, itemIndex) => itemIndex === index ? patch.item : item);
  run.snapshotRevision = patch.snapshotRevision;
}

function assertMonotonicStatus(current: BackendAgentTurnItem, incoming: BackendAgentTurnItem): void {
  if (TERMINAL_STATUSES.has(current.status) && incoming.status !== current.status) {
    throw new Error(`Canonical timeline item ${current.itemId} cannot transition from ${current.status} to ${incoming.status}`);
  }
}

function projectSessionSnapshot(sessionId: string, state: SessionTimelineState): ChatTimelineSnapshot {
  const runtimeStates: BackendAgentRunRuntimeState[] = [...state.runs.values()].map((timeline) => ({
    runtimeEvents: [],
    timeline,
  }));
  return {
    schemaVersion: "tinybot.chat_timeline.v1",
    sessionId,
    source: "canonical",
    runRevisions: Object.fromEntries([...state.runs].map(([runId, run]) => [runId, run.snapshotRevision])),
    turns: backendRuntimeStatesToTurns(sessionId, runtimeStates),
    diagnostics: [...state.diagnostics],
  };
}

function emptyTimelineSnapshot(sessionId: string): ChatTimelineSnapshot {
  return {
    schemaVersion: "tinybot.chat_timeline.v1",
    sessionId,
    source: "canonical",
    runRevisions: {},
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
