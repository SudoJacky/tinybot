import {
  appendUserMessage,
  canonicalSessionKey,
  createNativeChatState,
  activateSession,
  hydrateDelegatedTurnsFromTraceEvents,
  normalizeSessionsPayload,
  setSessions,
  type NativeBackgroundTraceEvent,
  type NativeChatReference,
  type NativeChatState,
} from "./nativeChat";
import {
  createAgentTimelineModel,
  TimelineRevisionGapError,
  type ChatTimelineSnapshot,
} from "./agentTimelineModel";
import { logDesktopNativeDebug, summarizeDebugText } from "../native/desktopNativeChatDebug";
import type { NativeThreadTurnInput, NativeThreadTurnResult } from "../native/desktopNativeThreads";

export interface DesktopChatSessionControllerApi {
  listSessions(): Promise<unknown>;
  listTurns?: (sessionKey: string) => Promise<unknown>;
  getAgentTurnRuntimeState?: (sessionKey: string, turnId: string) => Promise<unknown>;
  listTraceEvents?: (filter: { sessionKey: string }) => Promise<unknown>;
  getDelegateTrace?: (filter: { sessionKey: string; delegateId?: string; traceRef?: string }) => Promise<unknown>;
  getArtifact?: (filter: { sessionKey: string; delegateId?: string; traceRef?: string; artifactId: string }) => Promise<unknown>;
  deleteSession?: (sessionKey: string) => Promise<unknown>;
  patchSession?: (sessionKey: string, body: unknown) => Promise<unknown>;
  submitThreadTurn(input: NativeThreadTurnInput): Promise<NativeThreadTurnResult>;
}

export interface DesktopChatSessionControllerOptions {
  api: DesktopChatSessionControllerApi;
  now?: () => string;
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
  references?: NativeChatReference[];
  clientEventId?: string;
};

export interface DesktopChatSessionController {
  readonly state: NativeChatState;
  loadSessions(): Promise<number>;
  selectSession(sessionKey: string, chatId: string): Promise<void>;
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
  now = () => new Date().toISOString(),
  createClientEventId = defaultClientEventId,
  createTurnId = defaultTurnId,
}: DesktopChatSessionControllerOptions): DesktopChatSessionController {
  const state = createNativeChatState();
  const timelineModel = createAgentTimelineModel();
  const loadedTimelineSessions = new Set<string>();
  const loadingTimelineSessions = new Set<string>();
  const bufferedTimelinePatches = new Map<string, unknown[]>();

  async function loadSessions(): Promise<number> {
    logDesktopNativeDebug("session.load.start", summarizeSessionState());
    const sessions = normalizeSessionsPayload(await api.listSessions());
    setSessions(state, sessions);
    if (!state.activeSessionKey && sessions[0]) {
      await selectSession(sessions[0].key, sessions[0].chatId);
    }
    logDesktopNativeDebug("session.load.complete", {
      ...summarizeSessionState(),
      loadedCount: sessions.length,
    });
    return sessions.length;
  }

  async function selectSession(sessionKey: string, chatId: string): Promise<void> {
    sessionKey = canonicalSessionKey(sessionKey, chatId) || sessionKey;
    logDesktopNativeDebug("session.select.start", {
      ...summarizeSessionState(),
      chatId,
      sessionKey,
    });
    activateSession(state, sessionKey, chatId);
    try {
      await loadTimeline(sessionKey);
      await loadTraceEventsForSession(sessionKey);
      state.error = "";
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
      logDesktopNativeDebug("session.select.messages.failed", {
        ...summarizeSessionState(),
        error: state.error,
        sessionKey,
      });
      throw error;
    }
    logDesktopNativeDebug("session.select.complete", {
      ...summarizeSessionState(),
      chatId,
      messageCount: state.messages.get(sessionKey)?.length ?? 0,
      sessionKey,
    });
  }

  async function loadTraceEventsForSession(sessionKey: string): Promise<void> {
    if (!api.listTraceEvents) {
      return;
    }
    logDesktopNativeDebug("session.trace.load.start", {
      ...summarizeSessionState(),
      sessionKey,
    });
    try {
      const payload = await api.listTraceEvents({ sessionKey });
      const events = normalizeTraceEventsPayload(payload);
      hydrateDelegatedTurnsFromTraceEvents(state, sessionKey, events);
      logDesktopNativeDebug("session.trace.load.complete", {
        ...summarizeSessionState(),
        eventCount: events.length,
        sessionKey,
      });
    } catch (error) {
      logDesktopNativeDebug("session.trace.load.failed", {
        ...summarizeSessionState(),
        error: error instanceof Error ? error.message : String(error),
        sessionKey,
      });
    }
  }

  async function deleteSession(sessionKey: string): Promise<ChatDeleteSessionResult> {
    const deletedSessionKey = sessionKey;
    sessionKey = canonicalSessionKey(sessionKey) || sessionKey;
    const target = state.sessions.find((session) => session.key === sessionKey);
    logDesktopNativeDebug("session.delete.start", {
      ...summarizeSessionState(),
      found: Boolean(target),
      sessionKey,
    });
    if (!target) {
      logDesktopNativeDebug("session.delete.missing", { sessionKey });
      return { status: "missing", deletedSessionKey, nextSessionKey: "" };
    }
    if (!api.deleteSession) {
      logDesktopNativeDebug("session.delete.unavailable", { sessionKey });
      return { status: "unavailable", deletedSessionKey, nextSessionKey: "" };
    }

    await deleteGatewaySession(target);
    state.messages.delete(sessionKey);
    state.respondingSessionKeys.delete(sessionKey);

    const sessions = normalizeSessionsPayload(await api.listSessions());
    setSessions(state, sessions);
    if (state.activeSessionKey === sessionKey) {
      const next = sessions[0];
      if (next) {
        await selectSession(next.key, next.chatId);
      } else {
        state.activeSessionKey = "";
        state.activeChatId = "";
      }
    }
    logDesktopNativeDebug("session.delete.complete", {
      ...summarizeSessionState(),
      deletedSessionKey,
      nextSessionKey: state.activeSessionKey,
    });
    return {
      status: "deleted",
      deletedSessionKey,
      nextSessionKey: state.activeSessionKey,
    };
  }

  async function deleteGatewaySession(target: NativeChatState["sessions"][number]): Promise<void> {
    if (!api.deleteSession) {
      return;
    }
    const threadId = target.threadId || target.key;
    await api.deleteSession(threadId);
    logDesktopNativeDebug("session.delete.native", { threadId });
  }

  async function loadTimeline(sessionKey: string): Promise<ChatTimelineSnapshot> {
    if (loadedTimelineSessions.has(sessionKey)) {
      return timelineModel.snapshot(sessionKey);
    }
    if (!api.listTurns || !api.getAgentTurnRuntimeState) {
      throw new Error("Canonical agent timeline API is unavailable");
    }
    logDesktopNativeDebug("session.agentTurnRuntime.load.start", {
      ...summarizeSessionState(),
      sessionKey,
    });
    loadingTimelineSessions.add(sessionKey);
    try {
      const turnsPayload = await api.listTurns(sessionKey);
      const turnIds = normalizeTurnIdsPayload(turnsPayload);
      const payloads = await Promise.all(turnIds.map((turnId) => api.getAgentTurnRuntimeState?.(sessionKey, turnId)));
      let snapshot = timelineModel.load(sessionKey, payloads.filter((payload) => payload !== null && payload !== undefined));
      for (const patch of bufferedTimelinePatches.get(sessionKey) ?? []) {
        snapshot = timelineModel.applyPatch(sessionKey, patch);
      }
      bufferedTimelinePatches.delete(sessionKey);
      loadedTimelineSessions.add(sessionKey);
      state.chatTurns.turnsBySession.set(sessionKey, snapshot.turns);
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
    } finally {
      loadingTimelineSessions.delete(sessionKey);
    }
  }

  async function applyTimelinePatch(sessionKey: string, payload: unknown): Promise<ChatTimelineSnapshot | null> {
    if (loadingTimelineSessions.has(sessionKey) || !loadedTimelineSessions.has(sessionKey)) {
      const patches = bufferedTimelinePatches.get(sessionKey) ?? [];
      patches.push(payload);
      bufferedTimelinePatches.set(sessionKey, patches);
      return null;
    }
    try {
      const snapshot = timelineModel.applyPatch(sessionKey, payload);
      state.chatTurns.turnsBySession.set(sessionKey, snapshot.turns);
      syncRespondingState(sessionKey, snapshot);
      return snapshot;
    } catch (error) {
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

  function syncRespondingState(sessionKey: string, snapshot: ChatTimelineSnapshot): void {
    const responding = snapshot.turns.some((turn) => (
      turn.status === "pending"
      || turn.status === "running"
      || turn.status === "awaiting_approval"
      || turn.status === "awaiting_user"
    ));
    if (responding) {
      state.respondingSessionKeys.add(sessionKey);
    } else {
      state.respondingSessionKeys.delete(sessionKey);
    }
  }

  async function patchSession(sessionKey: string, body: unknown): Promise<boolean> {
    sessionKey = canonicalSessionKey(sessionKey) || sessionKey;
    const target = state.sessions.find((session) => session.key === sessionKey);
    logDesktopNativeDebug("session.patch.start", {
      ...summarizeSessionState(),
      found: Boolean(target),
      sessionKey,
    });
    if (!target || !api.patchSession) {
      logDesktopNativeDebug("session.patch.unavailable", {
        hasPatchSession: Boolean(api.patchSession),
        sessionKey,
      });
      return false;
    }
    await api.patchSession(target.threadId || target.key, body);
    const sessions = normalizeSessionsPayload(await api.listSessions());
    setSessions(state, sessions);
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
    if (!state.activeSessionKey) {
      throw new Error("Cannot submit a turn without an active Thread");
    }
    const clientEventId = options.clientEventId || createClientEventId();
    const { model, references } = options;
    const turnId = createTurnId();
    const activeSession = state.sessions.find((session) => session.key === state.activeSessionKey);
    const threadId = activeSession?.threadId || state.activeSessionKey;
    appendUserMessage(state, content, now(), references);
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
        sessionId: state.activeSessionKey,
        stream: true,
        ...(model ? { model } : {}),
        metadata: {
          clientEventId,
          ...(references?.length ? { references } : {}),
        },
      },
    };
    const sessionId = state.activeSessionKey;
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
    sessionKey = canonicalSessionKey(sessionKey) || sessionKey;
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
      activeChatId: state.activeChatId,
      activeSessionKey: state.activeSessionKey,
      sessionCount: state.sessions.length,
    };
  }
}

function defaultClientEventId(): string {
  return `client-message-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function defaultTurnId(): string {
  return `turn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeTraceEventsPayload(payload: unknown): NativeBackgroundTraceEvent[] {
  if (Array.isArray(payload)) {
    return payload.filter(isRecord) as NativeBackgroundTraceEvent[];
  }
  if (isRecord(payload) && Array.isArray(payload.events)) {
    return payload.events.filter(isRecord) as NativeBackgroundTraceEvent[];
  }
  return [];
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
