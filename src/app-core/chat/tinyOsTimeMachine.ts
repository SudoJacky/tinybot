import type { BackendAgentTurnItem } from "./chatTurnModel";
import {
  projectTinyOsKernel,
  type TinyOsKernelProjectionOptions,
  type TinyOsKernelSnapshot,
  type TinyOsSimulationCursor,
} from "./tinyOsKernelModel";

export const TINYOS_REPLAY_PROJECTOR_VERSION = 1;
export const TINYOS_REPLAY_TARGET_MS = 250;

export type TinyOsTimeMachineBoundary = {
  eventIndex: number;
  groupId: string;
  itemId: string;
  kind: BackendAgentTurnItem["kind"];
  revision: number;
  turnId: string;
  sequence: number;
  status: string;
  title: string;
  wallClockTime?: string;
};

export type TinyOsTimeMachineGroup = {
  boundaryIndexes: number[];
  firstEventIndex: number;
  id: string;
  label: string;
  lastEventIndex: number;
  turnId: string;
};

export type TinyOsTimeMachineIndex = {
  boundaries: TinyOsTimeMachineBoundary[];
  eventCount: number;
  groups: TinyOsTimeMachineGroup[];
  projectorVersion: number;
};

export type TinyOsReplayCheckpoint = {
  eventIndex: number;
  projectorVersion: number;
  snapshot: TinyOsKernelSnapshot;
};

export type TinyOsReplayResult = {
  checkpointStatus: "discarded_incompatible" | "rebuilt" | "restored";
  snapshot: TinyOsKernelSnapshot;
};

export type TinyOsReplayBenchmark = {
  checkpointRecommended: boolean;
  eventCount: number;
  maxDurationMs: number;
  sampleEventIndexes: number[];
  targetMs: number;
};

export function createTinyOsTimeMachineIndex(
  items: readonly BackendAgentTurnItem[],
): TinyOsTimeMachineIndex {
  const boundaries = items.map((item, eventIndex): TinyOsTimeMachineBoundary => {
    const wallClockTime = reliableTimestamp(item.updatedAt || item.createdAt);
    return {
      eventIndex,
      groupId: item.turnId,
      itemId: item.itemId,
      kind: item.kind,
      revision: item.revision,
      sequence: item.sequence,
      status: item.status,
      title: item.title?.trim() || humanizeKind(item.kind),
      turnId: item.turnId,
      ...(wallClockTime ? { wallClockTime } : {}),
    };
  });
  const groupsById = new Map<string, TinyOsTimeMachineGroup>();
  for (const boundary of boundaries) {
    const current = groupsById.get(boundary.groupId);
    if (current) {
      current.boundaryIndexes.push(boundary.eventIndex);
      current.lastEventIndex = boundary.eventIndex;
      continue;
    }
    groupsById.set(boundary.groupId, {
      boundaryIndexes: [boundary.eventIndex],
      firstEventIndex: boundary.eventIndex,
      id: boundary.groupId,
      label: `Turn ${shortIdentity(boundary.turnId)}`,
      lastEventIndex: boundary.eventIndex,
      turnId: boundary.turnId,
    });
  }
  return {
    boundaries,
    eventCount: boundaries.length,
    groups: [...groupsById.values()],
    projectorVersion: TINYOS_REPLAY_PROJECTOR_VERSION,
  };
}

export function tinyOsSimulationCursorAt(
  index: TinyOsTimeMachineIndex,
  eventIndex: number,
): TinyOsSimulationCursor {
  const boundary = index.boundaries[eventIndex];
  if (!boundary) throw new Error(`TinyOS history event index is unavailable: ${eventIndex}`);
  return {
    boundary: {
      itemId: boundary.itemId,
      sequence: boundary.sequence,
      turnId: boundary.turnId,
    },
    eventCount: index.eventCount,
    eventIndex,
    mode: "history",
    ...(boundary.wallClockTime ? { wallClockTime: boundary.wallClockTime } : {}),
  };
}

export function reconstructTinyOsKernelAt(
  items: readonly BackendAgentTurnItem[],
  cursor: TinyOsSimulationCursor,
  options: TinyOsKernelProjectionOptions & { checkpoint?: unknown } = {},
): TinyOsReplayResult {
  const checkpoint = compatibleCheckpoint(options.checkpoint, cursor);
  if (checkpoint) return { checkpointStatus: "restored", snapshot: checkpoint.snapshot };
  const boundary = cursor.boundary;
  if (!boundary || cursor.mode !== "history") {
    return { checkpointStatus: options.checkpoint ? "discarded_incompatible" : "rebuilt", snapshot: projectTinyOsKernel(items, { mode: "live" }, options) };
  }
  return {
    checkpointStatus: options.checkpoint ? "discarded_incompatible" : "rebuilt",
    snapshot: projectTinyOsKernel(items, {
      eventIndex: cursor.eventIndex,
      itemId: boundary.itemId,
      mode: "history",
      turnId: boundary.turnId,
    }, options),
  };
}

export function benchmarkTinyOsReplay(
  items: readonly BackendAgentTurnItem[],
  sampleEventIndexes = defaultBenchmarkIndexes(items.length),
  now: () => number = () => performance.now(),
): TinyOsReplayBenchmark {
  const index = createTinyOsTimeMachineIndex(items);
  let maxDurationMs = 0;
  for (const eventIndex of sampleEventIndexes) {
    const cursor = tinyOsSimulationCursorAt(index, eventIndex);
    const startedAt = now();
    reconstructTinyOsKernelAt(items, cursor);
    maxDurationMs = Math.max(maxDurationMs, now() - startedAt);
  }
  return {
    checkpointRecommended: maxDurationMs > TINYOS_REPLAY_TARGET_MS,
    eventCount: items.length,
    maxDurationMs,
    sampleEventIndexes: [...sampleEventIndexes],
    targetMs: TINYOS_REPLAY_TARGET_MS,
  };
}

function compatibleCheckpoint(
  value: unknown,
  cursor: TinyOsSimulationCursor,
): TinyOsReplayCheckpoint | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const checkpoint = value as Partial<TinyOsReplayCheckpoint>;
  return checkpoint.projectorVersion === TINYOS_REPLAY_PROJECTOR_VERSION
    && checkpoint.eventIndex === cursor.eventIndex
    && checkpoint.snapshot?.cursor.eventIndex === cursor.eventIndex
    ? checkpoint as TinyOsReplayCheckpoint
    : undefined;
}

function defaultBenchmarkIndexes(eventCount: number): number[] {
  if (eventCount <= 0) return [];
  return [...new Set([0, Math.floor((eventCount - 1) / 2), eventCount - 1])];
}

function reliableTimestamp(value: string): string {
  return value && Number.isFinite(Date.parse(value)) ? value : "";
}

function humanizeKind(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (character: string) => character.toUpperCase());
}

function shortIdentity(value: string): string {
  return value.length <= 12 ? value : value.slice(0, 12);
}
