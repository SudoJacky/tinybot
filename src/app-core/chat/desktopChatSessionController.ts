import {
  appendUserMessage,
  applyChatEvent,
  canonicalSessionKey,
  createNativeChatState,
  activateSession,
  hydrateDelegatedRunsFromTraceEvents,
  normalizeSessionsPayload,
  setSessions,
  sessionKeyForChat,
  sessionKeyForChatState,
  type NativeBackgroundTraceEvent,
  type NativeChatReference,
  type NativeChatState,
} from "./nativeChat";
import {
  createAgentTimelineModel,
  TimelineRevisionGapError,
  type ChatTimelineSnapshot,
} from "./agentTimelineModel";
import { createGatewaySocketMessage, type NormalizedGatewayEvent } from "../gateway/gatewayWebSocketClient";
import { logDesktopNativeDebug, summarizeDebugText } from "../native/desktopNativeChatDebug";
import type { TinyOsCommand } from "./tinyOsCommandGateway";

export interface DesktopChatSessionControllerApi {
  listSessions(): Promise<unknown>;
  loadMessages(sessionKey: string): Promise<unknown>;
  listAgentRuns?: (sessionKey: string) => Promise<unknown>;
  getAgentRunRuntimeState?: (sessionKey: string, runId: string) => Promise<unknown>;
  listTraceEvents?: (filter: { sessionKey: string }) => Promise<unknown>;
  getDelegateTrace?: (filter: { sessionKey: string; delegateId?: string; traceRef?: string }) => Promise<unknown>;
  getArtifact?: (filter: { sessionKey: string; delegateId?: string; traceRef?: string; artifactId: string }) => Promise<unknown>;
  deleteSession?: (sessionKey: string) => Promise<unknown>;
  patchSession?: (sessionKey: string, body: unknown) => Promise<unknown>;
}

export interface DesktopChatSessionControllerOptions {
  api: DesktopChatSessionControllerApi;
  sendSocketMessage(message: unknown): void;
  now?: () => string;
  createClientEventId?: () => string;
}

export type ChatSubmitResult =
  | { status: "empty" }
  | { status: "creating"; pendingContent: string; clientEventId: string }
  | { status: "sent"; chatId: string; content: string; clientEventId: string };

export type ChatGatewayEventResult = {
  pendingMessageSent: boolean;
  loadedMessagesForChatId: string;
  reloadedSessions: boolean;
};

export type ChatDeleteSessionResult =
  | { status: "missing"; deletedSessionKey: string; nextSessionKey: "" }
  | { status: "unavailable"; deletedSessionKey: string; nextSessionKey: "" }
  | { status: "deleted"; deletedSessionKey: string; nextSessionKey: string };

export interface DesktopChatSessionController {
  readonly state: NativeChatState;
  loadSessions(): Promise<number>;
  selectSession(sessionKey: string, chatId: string): Promise<void>;
  startNewChat(): void;
  deleteSession(sessionKey: string): Promise<ChatDeleteSessionResult>;
  patchSession(sessionKey: string, body: unknown): Promise<boolean>;
  submitMessage(content: string, usePersistentRag?: boolean, model?: string, references?: NativeChatReference[]): ChatSubmitResult;
  dispatchCommand(command: TinyOsCommand): boolean;
  handleGatewayEvent(event: NormalizedGatewayEvent): Promise<ChatGatewayEventResult>;
  loadMessagesForChat(chatId: string): Promise<boolean>;
  loadTimeline(sessionKey: string): Promise<ChatTimelineSnapshot>;
  applyTimelinePatch(sessionKey: string, payload: unknown): Promise<ChatTimelineSnapshot | null>;
  loadDelegateTrace(selection: { sessionKey: string; delegateId?: string; traceRef?: string }): Promise<unknown>;
  loadArtifact(selection: { sessionKey: string; delegateId?: string; traceRef?: string; artifactId: string }): Promise<unknown>;
}

export function createDesktopChatSessionController({
  api,
  sendSocketMessage,
  now = () => new Date().toISOString(),
  createClientEventId = defaultClientEventId,
}: DesktopChatSessionControllerOptions): DesktopChatSessionController {
  const state = createNativeChatState();
  const timelineModel = createAgentTimelineModel();
  const loadedTimelineSessions = new Set<string>();
  const loadingTimelineSessions = new Set<string>();
  const bufferedTimelinePatches = new Map<string, unknown[]>();
  let pendingMessage: { clientEventId: string; content: string; model?: string; references?: NativeChatReference[]; usePersistentRag: boolean } | null = null;

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
    sendSocketMessage(createGatewaySocketMessage.attach(chatId));
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
      hydrateDelegatedRunsFromTraceEvents(state, sessionKey, events);
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

  function startNewChat(): void {
    logDesktopNativeDebug("session.new.request", summarizeSessionState());
    sendSocketMessage(createGatewaySocketMessage.newChat());
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
    try {
      await api.deleteSession(target.key);
      logDesktopNativeDebug("session.delete.gateway", {
        key: target.key,
        mode: "primary",
      });
      return;
    } catch (error) {
      const fallbackKey = sessionKeyForChat(target.chatId);
      if (!fallbackKey || fallbackKey === target.key) {
        logDesktopNativeDebug("session.delete.failed", {
          error: error instanceof Error ? error.message : String(error),
          key: target.key,
        });
        throw error;
      }
      logDesktopNativeDebug("session.delete.retry", {
        fallbackKey,
        key: target.key,
      });
      await api.deleteSession(fallbackKey);
      logDesktopNativeDebug("session.delete.gateway", {
        key: fallbackKey,
        mode: "fallback",
      });
    }
  }

  async function loadTimeline(sessionKey: string): Promise<ChatTimelineSnapshot> {
    if (loadedTimelineSessions.has(sessionKey)) {
      return timelineModel.snapshot(sessionKey);
    }
    if (!api.listAgentRuns || !api.getAgentRunRuntimeState) {
      throw new Error("Canonical agent timeline API is unavailable");
    }
    logDesktopNativeDebug("session.agentRunRuntime.load.start", {
      ...summarizeSessionState(),
      sessionKey,
    });
    loadingTimelineSessions.add(sessionKey);
    try {
      const runsPayload = await api.listAgentRuns(sessionKey);
      const runIds = normalizeAgentRunIdsPayload(runsPayload);
      const payloads = await Promise.all(runIds.map((runId) => api.getAgentRunRuntimeState?.(sessionKey, runId)));
      let snapshot = timelineModel.load(sessionKey, payloads.filter((payload) => payload !== null && payload !== undefined));
      for (const patch of bufferedTimelinePatches.get(sessionKey) ?? []) {
        snapshot = timelineModel.applyPatch(sessionKey, patch);
      }
      bufferedTimelinePatches.delete(sessionKey);
      loadedTimelineSessions.add(sessionKey);
      state.chatRuns.turnsBySession.set(sessionKey, snapshot.turns);
      syncRespondingState(sessionKey, snapshot);
      logDesktopNativeDebug("session.agentRunRuntime.load.complete", {
        ...summarizeSessionState(),
        runCount: runIds.length,
        runtimeStateCount: payloads.length,
        sessionKey,
      });
      return snapshot;
    } catch (error) {
      logDesktopNativeDebug("session.agentRunRuntime.load.failed", {
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
      state.chatRuns.turnsBySession.set(sessionKey, snapshot.turns);
      syncRespondingState(sessionKey, snapshot);
      return snapshot;
    } catch (error) {
      if (!(error instanceof TimelineRevisionGapError)) {
        throw error;
      }
      logDesktopNativeDebug("session.agentRunRuntime.patch.gap", {
        expectedRevision: error.expectedRevision,
        receivedRevision: error.receivedRevision,
        runId: error.runId,
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
    await api.patchSession(sessionKey, body);
    const sessions = normalizeSessionsPayload(await api.listSessions());
    setSessions(state, sessions);
    logDesktopNativeDebug("session.patch.complete", {
      ...summarizeSessionState(),
      sessionKey,
    });
    return true;
  }

  function submitMessage(content: string, usePersistentRag = true, model?: string, references?: NativeChatReference[]): ChatSubmitResult {
    const trimmed = content.trim();
    if (!trimmed) {
      logDesktopNativeDebug("session.message.empty", summarizeSessionState());
      return { status: "empty" };
    }
    const clientEventId = createClientEventId();

    if (!state.activeChatId) {
      pendingMessage = { clientEventId, content: trimmed, model, references, usePersistentRag };
      startNewChat();
      logDesktopNativeDebug("session.message.queued", {
        ...summarizeSessionState(),
        content: summarizeDebugText(trimmed),
        model: model || "",
        usePersistentRag,
      });
      return { status: "creating", pendingContent: trimmed, clientEventId };
    }

    sendActiveChatMessage(trimmed, usePersistentRag, model, clientEventId, references);
    logDesktopNativeDebug("session.message.sent", {
      ...summarizeSessionState(),
      content: summarizeDebugText(trimmed),
      model: model || "",
      usePersistentRag,
    });
    return { status: "sent", chatId: state.activeChatId, content: trimmed, clientEventId };
  }

  function dispatchCommand(command: TinyOsCommand): boolean {
    if (!state.activeChatId || state.activeSessionKey !== command.target.sessionId) {
      logDesktopNativeDebug("session.interrupt.skipped", summarizeSessionState());
      return false;
    }
    sendSocketMessage(createGatewaySocketMessage.interrupt(state.activeChatId, command));
    logDesktopNativeDebug("session.interrupt.request", {
      ...summarizeSessionState(),
      commandId: command.commandId,
      runId: command.target.runId,
      sourceControl: command.source.control,
      sourceSurface: command.source.surface,
    });
    return true;
  }

  async function handleGatewayEvent(event: NormalizedGatewayEvent): Promise<ChatGatewayEventResult> {
    const result: ChatGatewayEventResult = {
      pendingMessageSent: false,
      loadedMessagesForChatId: "",
      reloadedSessions: false,
    };

    // Raw Agent and usage events are trace/transport signals only. Canonical
    // timeline snapshots and patches are the sole writers of Chat turns.
    if (event.kind !== "agent.event" && event.kind !== "usage") {
      applyChatEvent(state, event);
    }

    if (event.kind === "chat.created") {
      await loadSessions();
      if (!state.sessions.some((session) => session.chatId === event.chatId)) {
        activateSession(state, sessionKeyForChat(event.chatId), event.chatId);
      }
      result.reloadedSessions = true;
      if (pendingMessage) {
        const { clientEventId, content, model, references, usePersistentRag } = pendingMessage;
        pendingMessage = null;
        sendActiveChatMessage(content, usePersistentRag, model, clientEventId, references);
        logDesktopNativeDebug("session.message.queued.sent", {
          ...summarizeSessionState(),
          content: summarizeDebugText(content),
          model: model || "",
          usePersistentRag,
        });
        result.pendingMessageSent = true;
      }
    }

    if (event.kind === "attached") {
      const loaded = await loadMessagesForChat(event.chatId);
      result.loadedMessagesForChatId = loaded ? event.chatId : "";
    }

    return result;
  }

  async function loadMessagesForChat(chatId: string): Promise<boolean> {
    const sessionKey = sessionKeyForChatState(state, chatId);
    if (!sessionKey) {
      return false;
    }
    loadedTimelineSessions.delete(sessionKey);
    await loadTimeline(sessionKey);
    await loadTraceEventsForSession(sessionKey);
    logDesktopNativeDebug("session.messages.loaded", {
      chatId,
      turnCount: state.chatRuns.turnsBySession.get(sessionKey)?.length ?? 0,
      sessionKey,
    });
    return true;
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

  function sendActiveChatMessage(
    content: string,
    usePersistentRag = true,
    model?: string,
    clientEventId?: string,
    references?: NativeChatReference[],
  ): void {
    appendUserMessage(state, content, now(), references);
    sendSocketMessage(createGatewaySocketMessage.message(
      state.activeChatId,
      content,
      usePersistentRag,
      model,
      clientEventId,
      references,
    ));
  }

  return {
    state,
    loadSessions,
    selectSession,
    startNewChat,
    deleteSession,
    patchSession,
    submitMessage,
    dispatchCommand,
    handleGatewayEvent,
    loadMessagesForChat,
    loadTimeline,
    applyTimelinePatch,
    loadDelegateTrace,
    loadArtifact,
  };

  function summarizeSessionState(): Record<string, unknown> {
    return {
      activeChatId: state.activeChatId,
      activeSessionKey: state.activeSessionKey,
      pendingMessage: Boolean(pendingMessage),
      sessionCount: state.sessions.length,
    };
  }
}

function defaultClientEventId(): string {
  return `client-message-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
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

function normalizeAgentRunIdsPayload(payload: unknown): string[] {
  if (!isRecord(payload) || !Array.isArray(payload.runs)) {
    return [];
  }
  return payload.runs
    .filter(isRecord)
    .map((run) => stringValue(run.runId ?? run.run_id))
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
