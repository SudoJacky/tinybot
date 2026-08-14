import type { AgentInputReference } from "./agentInputReference";
import type { ReasoningEffort } from "./reasoningEffort";
import {
  createAgentTimelineModel,
  TimelineItemIdentityConflictError,
  TimelineRevisionGapError,
  type ChatTimelineSnapshot,
} from "./agentTimelineModel";
import { normalizeAgentTimelinePatchPayload } from "./chatTurnModel";
import { logDesktopNativeDebug, summarizeDebugText } from "../native/desktopNativeChatDebug";
import type {
  NativeThreadListResult,
  NativeThreadRecord,
  NativeThreadTurnInput,
  NativeThreadTurnResult,
} from "../native/desktopNativeThreads";

export interface DesktopChatSessionControllerApi {
  listThreads(): Promise<NativeThreadListResult>;
  listTurns?: (threadId: string) => Promise<unknown>;
  getAgentTurnRuntimeState?: (threadId: string, turnId: string) => Promise<unknown>;
  getDelegateTrace?: (filter: { sessionKey: string; delegateId?: string; traceRef?: string }) => Promise<unknown>;
  getArtifact?: (filter: { sessionKey: string; delegateId?: string; traceRef?: string; artifactId: string }) => Promise<unknown>;
  deleteThread?: (threadId: string) => Promise<unknown>;
  patchThread?: (threadId: string, body: unknown) => Promise<unknown>;
  submitThreadTurn(input: NativeThreadTurnInput): Promise<NativeThreadTurnResult>;
}

export interface DesktopChatSessionControllerOptions {
  api: DesktopChatSessionControllerApi;
  createClientEventId?: () => string;
  createTurnId?: () => string;
}

export type ChatSubmitResult =
  | { status: "empty" }
  | {
    status: "sent";
    sessionId: string;
    threadId: string;
    turnId: string;
    content: string;
    clientEventId: string;
    completion: Promise<ChatTimelineSnapshot>;
  };

export type ChatDeleteSessionResult =
  | { status: "missing"; deletedSessionKey: string; nextSessionKey: "" }
  | { status: "unavailable"; deletedSessionKey: string; nextSessionKey: "" }
  | { status: "deleted"; deletedSessionKey: string; nextSessionKey: string };

export type ChatSubmitOptions = {
  model?: string;
  provider?: string;
  reasoningEffort?: ReasoningEffort;
  references?: AgentInputReference[];
  selectedSkills?: string[];
  clientEventId?: string;
};

export type DesktopThreadSessionState = {
  threads: NativeThreadRecord[];
  activeThreadId: string;
  respondingThreadIds: Set<string>;
  error: string;
};

export interface DesktopChatSessionController {
  readonly state: DesktopThreadSessionState;
  loadSessions(): Promise<number>;
  selectSession(threadId: string): Promise<void>;
  deleteSession(sessionKey: string): Promise<ChatDeleteSessionResult>;
  patchSession(sessionKey: string, body: unknown): Promise<boolean>;
  submitMessage(content: string, options?: ChatSubmitOptions): Promise<ChatSubmitResult>;
  loadTimeline(sessionKey: string): Promise<ChatTimelineSnapshot>;
  reloadTimeline(sessionKey: string): Promise<ChatTimelineSnapshot>;
  applyTimelinePatch(sessionKey: string, payload: unknown): Promise<ChatTimelineSnapshot | null>;
  loadDelegateTrace(selection: { sessionKey: string; delegateId?: string; traceRef?: string }): Promise<unknown>;
  loadArtifact(selection: { sessionKey: string; delegateId?: string; traceRef?: string; artifactId: string }): Promise<unknown>;
}

export function createDesktopChatSessionController({
  api,
  createClientEventId = defaultClientEventId,
  createTurnId = defaultTurnId,
}: DesktopChatSessionControllerOptions): DesktopChatSessionController {
  const state: DesktopThreadSessionState = {
    threads: [],
    activeThreadId: "",
    respondingThreadIds: new Set(),
    error: "",
  };
  const timelineModel = createAgentTimelineModel();
  const loadedTimelineSessions = new Set<string>();
  const timelineLoads = new Map<string, Promise<ChatTimelineSnapshot>>();
  const bufferedTimelinePatches = new Map<string, unknown[]>();

  async function loadSessions(): Promise<number> {
    logDesktopNativeDebug("session.load.start", summarizeSessionState());
    const { threads } = await api.listThreads();
    state.threads = threads;
    if (!state.activeThreadId && threads[0]) {
      await selectSession(threads[0].threadId);
    }
    logDesktopNativeDebug("session.load.complete", {
      ...summarizeSessionState(),
      loadedCount: threads.length,
    });
    return threads.length;
  }

  async function selectSession(threadId: string): Promise<void> {
    logDesktopNativeDebug("session.select.start", {
      ...summarizeSessionState(),
      threadId,
    });
    state.activeThreadId = threadId;
    try {
      await reloadTimeline(threadId);
      state.error = "";
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
      logDesktopNativeDebug("session.select.messages.failed", {
        ...summarizeSessionState(),
        error: state.error,
        threadId,
      });
      throw error;
    }
    logDesktopNativeDebug("session.select.complete", {
      ...summarizeSessionState(),
      threadId,
    });
  }

  async function deleteSession(sessionKey: string): Promise<ChatDeleteSessionResult> {
    const deletedSessionKey = sessionKey;
    const target = state.threads.find((thread) => thread.threadId === sessionKey);
    logDesktopNativeDebug("session.delete.start", {
      ...summarizeSessionState(),
      found: Boolean(target),
      sessionKey,
    });
    if (!target) {
      logDesktopNativeDebug("session.delete.missing", { sessionKey });
      return { status: "missing", deletedSessionKey, nextSessionKey: "" };
    }
    if (!api.deleteThread) {
      logDesktopNativeDebug("session.delete.unavailable", { sessionKey });
      return { status: "unavailable", deletedSessionKey, nextSessionKey: "" };
    }

    await api.deleteThread(target.threadId);
    logDesktopNativeDebug("session.delete.native", { threadId: target.threadId });
    state.respondingThreadIds.delete(sessionKey);

    const { threads } = await api.listThreads();
    state.threads = threads;
    if (state.activeThreadId === sessionKey) {
      const next = threads[0];
      if (next) {
        await selectSession(next.threadId);
      } else {
        state.activeThreadId = "";
      }
    }
    logDesktopNativeDebug("session.delete.complete", {
      ...summarizeSessionState(),
      deletedSessionKey,
      nextSessionKey: state.activeThreadId,
    });
    return {
      status: "deleted",
      deletedSessionKey,
      nextSessionKey: state.activeThreadId,
    };
  }

  async function loadTimeline(sessionKey: string): Promise<ChatTimelineSnapshot> {
    if (loadedTimelineSessions.has(sessionKey)) {
      return timelineModel.snapshot(sessionKey);
    }
    const existingLoad = timelineLoads.get(sessionKey);
    if (existingLoad) {
      return existingLoad;
    }
    let load: Promise<ChatTimelineSnapshot>;
    load = loadTimelineFromRuntime(sessionKey).finally(() => {
      if (timelineLoads.get(sessionKey) === load) {
        timelineLoads.delete(sessionKey);
      }
    });
    timelineLoads.set(sessionKey, load);
    return load;
  }

  async function loadTimelineFromRuntime(sessionKey: string): Promise<ChatTimelineSnapshot> {
    if (!api.listTurns || !api.getAgentTurnRuntimeState) {
      throw new Error("Canonical agent timeline API is unavailable");
    }
    logDesktopNativeDebug("session.agentTurnRuntime.load.start", {
      ...summarizeSessionState(),
      sessionKey,
    });
    try {
      const turnsPayload = await api.listTurns(sessionKey);
      const turnIds = normalizeTurnIdsPayload(turnsPayload);
      const payloads = await Promise.all(turnIds.map((turnId) => api.getAgentTurnRuntimeState?.(sessionKey, turnId)));
      let snapshot = timelineModel.load(sessionKey, payloads.filter((payload) => payload !== null && payload !== undefined));
      for (const patchPayload of bufferedTimelinePatches.get(sessionKey) ?? []) {
        const patch = normalizeAgentTimelinePatchPayload(patchPayload);
        const loadedRevision = snapshot.turnRevisions[patch.turnId];
        if (loadedRevision !== undefined && patch.snapshotRevision <= loadedRevision) {
          logDesktopNativeDebug("session.agentTurnRuntime.patch.subsumed", {
            loadedRevision,
            patchRevision: patch.snapshotRevision,
            turnId: patch.turnId,
            sessionKey,
          });
          continue;
        }
        snapshot = timelineModel.applyPatch(sessionKey, patch);
      }
      bufferedTimelinePatches.delete(sessionKey);
      loadedTimelineSessions.add(sessionKey);
      syncRespondingState(sessionKey, snapshot);
      logDesktopNativeDebug("session.agentTurnRuntime.load.complete", {
        ...summarizeSessionState(),
        turnCount: turnIds.length,
        turnStateCount: payloads.length,
        sessionKey,
      });
      return snapshot;
    } catch (error) {
      logDesktopNativeDebug("session.agentTurnRuntime.load.failed", {
        ...summarizeSessionState(),
        error: error instanceof Error ? error.message : String(error),
        sessionKey,
      });
      throw error;
    }
  }

  async function applyTimelinePatch(sessionKey: string, payload: unknown): Promise<ChatTimelineSnapshot | null> {
    if (timelineLoads.has(sessionKey) || !loadedTimelineSessions.has(sessionKey)) {
      const patches = bufferedTimelinePatches.get(sessionKey) ?? [];
      patches.push(payload);
      bufferedTimelinePatches.set(sessionKey, patches);
      return null;
    }
    try {
      const snapshot = timelineModel.applyPatch(sessionKey, payload);
      syncRespondingState(sessionKey, snapshot);
      return snapshot;
    } catch (error) {
      if (error instanceof TimelineItemIdentityConflictError) {
        logDesktopNativeDebug("session.agentTurnRuntime.patch.identityConflict", {
          currentSequence: error.currentSequence,
          itemId: error.itemId,
          receivedSequence: error.receivedSequence,
          snapshotRevision: error.snapshotRevision,
          turnId: error.turnId,
          sessionKey,
        });
        loadedTimelineSessions.delete(sessionKey);
        const snapshot = await loadTimeline(sessionKey);
        const durableRevision = snapshot.turnRevisions[error.turnId];
        if (durableRevision === undefined || durableRevision < error.snapshotRevision) {
          throw new Error(
            `Canonical timeline identity recovery for item ${error.itemId} loaded revision ${durableRevision ?? "missing"}, expected at least ${error.snapshotRevision}`,
          );
        }
        return snapshot;
      }
      if (!(error instanceof TimelineRevisionGapError)) {
        throw error;
      }
      logDesktopNativeDebug("session.agentTurnRuntime.patch.gap", {
        expectedRevision: error.expectedRevision,
        receivedRevision: error.receivedRevision,
        turnId: error.turnId,
        sessionKey,
      });
      const buffered = bufferedTimelinePatches.get(sessionKey) ?? [];
      buffered.push(payload);
      bufferedTimelinePatches.set(sessionKey, buffered);
      loadedTimelineSessions.delete(sessionKey);
      return loadTimeline(sessionKey);
    }
  }

  function syncRespondingState(threadId: string, snapshot: ChatTimelineSnapshot): void {
    const responding = snapshot.turns.some((turn) => (
      turn.status === "pending"
      || turn.status === "running"
      || turn.status === "awaiting_user"
    ));
    if (responding) {
      state.respondingThreadIds.add(threadId);
    } else {
      state.respondingThreadIds.delete(threadId);
    }
  }

  async function patchSession(sessionKey: string, body: unknown): Promise<boolean> {
    const target = state.threads.find((thread) => thread.threadId === sessionKey);
    logDesktopNativeDebug("session.patch.start", {
      ...summarizeSessionState(),
      found: Boolean(target),
      sessionKey,
    });
    if (!target || !api.patchThread) {
      logDesktopNativeDebug("session.patch.unavailable", {
        hasPatchSession: Boolean(api.patchThread),
        sessionKey,
      });
      return false;
    }
    await api.patchThread(target.threadId, body);
    state.threads = (await api.listThreads()).threads;
    logDesktopNativeDebug("session.patch.complete", {
      ...summarizeSessionState(),
      sessionKey,
    });
    return true;
  }

  async function submitMessage(content: string, options: ChatSubmitOptions = {}): Promise<ChatSubmitResult> {
    if (!content.trim()) {
      logDesktopNativeDebug("session.message.empty", summarizeSessionState());
      return { status: "empty" };
    }
    if (!state.activeThreadId) {
      throw new Error("Cannot submit a turn without an active Thread");
    }
    const clientEventId = options.clientEventId || createClientEventId();
    const { model, provider, reasoningEffort, references, selectedSkills } = options;
    const turnId = createTurnId();
    const threadId = state.activeThreadId;
    const request: NativeThreadTurnInput = {
      threadId,
      input: {
        role: "user",
        content,
        clientEventId,
        ...(references?.length ? { references } : {}),
      },
      spec: {
        turnId,
        sessionId: threadId,
        stream: true,
        ...(model ? { model } : {}),
        ...(provider ? { provider } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
        metadata: {
          clientEventId,
          ...(references?.length ? { references } : {}),
          ...(selectedSkills?.length ? { selectedSkills } : {}),
        },
      },
    };
    const sessionId = threadId;
    const completion = api.submitThreadTurn(request)
      .then(async (result) => {
        if (result.sessionId !== sessionId || result.turnId !== turnId) {
          throw new Error(
            `Completed Thread turn identity mismatch: ${result.sessionId}/${result.turnId}, expected ${sessionId}/${turnId}`,
          );
        }
        const liveTimeline = timelineModel.snapshot(sessionId);
        const liveTurn = liveTimeline.turns.find((turn) => turn.id === turnId);
        const hasLiveTerminalTurn = liveTurn
          ? ["completed", "failed", "interrupted"].includes(liveTurn.status)
          : false;
        const timeline = hasLiveTerminalTurn
          ? liveTimeline
          : await reloadTimeline(sessionId);
        state.error = "";
        logDesktopNativeDebug("session.message.completed", {
          ...summarizeSessionState(),
          convergenceSource: hasLiveTerminalTurn ? "live_timeline" : "runtime_reload",
          turnId,
          sessionId,
          threadId,
          turnCount: timeline.turns.length,
        });
        return timeline;
      })
      .catch((error) => {
        state.error = error instanceof Error ? error.message : String(error);
        logDesktopNativeDebug("session.message.failed", {
          ...summarizeSessionState(),
          error: state.error,
          turnId,
          threadId,
        });
        throw error;
      });
    logDesktopNativeDebug("session.message.sent", {
      ...summarizeSessionState(),
      content: summarizeDebugText(content),
      model: model || "",
      turnId,
      threadId,
    });
    return {
      status: "sent",
      sessionId,
      threadId,
      turnId,
      content,
      clientEventId,
      completion,
    };
  }

  async function reloadTimeline(sessionKey: string): Promise<ChatTimelineSnapshot> {
    loadedTimelineSessions.delete(sessionKey);
    return loadTimeline(sessionKey);
  }

  async function loadDelegateTrace(selection: { sessionKey: string; delegateId?: string; traceRef?: string }): Promise<unknown> {
    if (!api.getDelegateTrace) {
      throw new Error("Delegate trace API is unavailable.");
    }
    logDesktopNativeDebug("session.delegateTrace.load.start", {
      delegateId: selection.delegateId ?? "",
      sessionKey: selection.sessionKey,
      traceRef: selection.traceRef ?? "",
    });
    const trace = await api.getDelegateTrace(selection);
    logDesktopNativeDebug("session.delegateTrace.load.complete", {
      delegateId: selection.delegateId ?? "",
      hasTrace: Boolean(trace),
      sessionKey: selection.sessionKey,
      traceRef: selection.traceRef ?? "",
    });
    return trace;
  }

  async function loadArtifact(selection: { sessionKey: string; delegateId?: string; traceRef?: string; artifactId: string }): Promise<unknown> {
    if (!api.getArtifact) {
      throw new Error("Artifact API is unavailable.");
    }
    logDesktopNativeDebug("session.artifact.load.start", {
      artifactId: selection.artifactId,
      delegateId: selection.delegateId ?? "",
      sessionKey: selection.sessionKey,
      traceRef: selection.traceRef ?? "",
    });
    const artifact = await api.getArtifact(selection);
    logDesktopNativeDebug("session.artifact.load.complete", {
      artifactId: selection.artifactId,
      delegateId: selection.delegateId ?? "",
      hasArtifact: Boolean(artifact),
      sessionKey: selection.sessionKey,
      traceRef: selection.traceRef ?? "",
    });
    return artifact;
  }

  return {
    state,
    loadSessions,
    selectSession,
    deleteSession,
    patchSession,
    submitMessage,
    loadTimeline,
    reloadTimeline,
    applyTimelinePatch,
    loadDelegateTrace,
    loadArtifact,
  };

  function summarizeSessionState(): Record<string, unknown> {
    return {
      activeThreadId: state.activeThreadId,
      threadCount: state.threads.length,
    };
  }
}

function defaultClientEventId(): string {
  return `client-message-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function defaultTurnId(): string {
  return `turn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeTurnIdsPayload(payload: unknown): string[] {
  if (!isRecord(payload) || !Array.isArray(payload.turns)) {
    return [];
  }
  return payload.turns
    .filter(isRecord)
    .map((turn) => stringValue(turn.turnId ?? turn.turn_id))
    .filter(Boolean);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
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
