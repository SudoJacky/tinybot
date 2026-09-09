import { subscribeChatEvents } from "./chatEventSource";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentUiForm } from "../../app-core/agent-ui/agentUiEvents";
import type { ChatTimelineSnapshot } from "../../app-core/chat/agentTimelineModel";
import type { HookExecutionResult } from "../../app-core/chat/hookExecutionResult";
import type { ChatEvent, ChatStore } from "../services";
import type { ReactChatMessage } from "./messageActions";
import { projectChatEventEffects } from "./chatEventPolicy";
import { createChatTimelineSource, type ChatTimelineSource } from "./chatTimelineSource";

export type ChatSessionRuntimeStatus = "idle" | "loading" | "ready" | "failed";

export type ChatSessionRuntimeState = {
  agentUiForms: AgentUiForm[];
  error: string;
  hookResults: HookExecutionResult[];
  sessionId: string;
  status: ChatSessionRuntimeStatus;
};

export type ChatSessionRuntimeEffect =
  | { event: ChatEvent; sessionId: string; type: "command_received" }
  | { message: ReactChatMessage; sessionId: string; type: "message_received" }
  | { event: ChatEvent; sessionId: string; type: "session_refresh_requested" }
  | { sessionId: string; timeline: ChatTimelineSnapshot; type: "timeline_applied" };

export type ChatSessionRuntimeActions = {
  clearError(): void;
  reload(): Promise<void>;
  reportError(error: unknown): void;
};

export type UseChatSessionRuntimeInput = {
  chatStore: Pick<ChatStore, "listAgentUiForms" | "load" | "subscribe">;
  onEffect?: (effect: ChatSessionRuntimeEffect) => void;
  sessionId: string;
};

export function useChatSessionRuntime({
  chatStore,
  onEffect,
  sessionId,
}: UseChatSessionRuntimeInput): {
  actions: ChatSessionRuntimeActions;
  state: ChatSessionRuntimeState;
  timelineSource: ChatTimelineSource;
} {
  const timelineSource = useMemo(() => createChatTimelineSource(sessionId), [sessionId]);
  const [state, setState] = useState<ChatSessionRuntimeState>(() => initialState(sessionId));
  const activeSessionIdRef = useRef(sessionId);
  const onEffectRef = useRef(onEffect);
  const reloadRef = useRef<(() => Promise<void>) | null>(null);
  activeSessionIdRef.current = sessionId;
  onEffectRef.current = onEffect;

  const reportError = useCallback((error: unknown) => {
    const message = errorMessage(error);
    setState((current) => ({ ...current, error: message, status: "failed" }));
  }, []);
  const clearError = useCallback(() => {
    setState((current) => ({
      ...current,
      error: "",
      status: current.sessionId ? (timelineSource.getSnapshot() ? "ready" : "loading") : "idle",
    }));
  }, [timelineSource]);
  const reload = useCallback(async () => {
    await reloadRef.current?.();
  }, []);

  useEffect(() => {
    timelineSource.publish(null);
    if (!sessionId) {
      reloadRef.current = null;
      setState(initialState(""));
      return;
    }

    let cancelled = false;
    let loadSequence = 0;
    let formsLoadSequence = 0;
    let timelineEpoch = 0;
    let pendingStreamingTimeline: ChatTimelineSnapshot | null = null;
    let streamingFrame: number | null = null;
    setState(initialState(sessionId, "loading"));

    const fail = (operation: string, error: unknown) => {
      if (cancelled) return;
      const message = errorMessage(error);
      console.error(`[chat-session-runtime] ${operation}.failed`, { error: message, sessionId });
      setState((current) => (
        current.sessionId === sessionId
          ? { ...current, error: message, status: "failed" }
          : current
      ));
    };
    const applyTimeline = (timeline: ChatTimelineSnapshot, notifyEffect: boolean) => {
      if (cancelled) return;
      if (timeline.sessionId !== sessionId) {
        fail(
          "timeline.apply",
          new Error(`Timeline session ${timeline.sessionId} does not match active session ${sessionId}.`),
        );
        return;
      }
      timelineEpoch += 1;
      timelineSource.publish(timeline);
      setState((current) => {
        if (current.sessionId !== sessionId) return current;
        const error = notifyEffect ? "" : current.error;
        const hookResults = mergeHookResults(current.hookResults, timeline.hookResults ?? []);
        const status = !notifyEffect && current.error ? "failed" : "ready";
        return current.error === error && current.hookResults === hookResults && current.status === status
          ? current : { ...current, error, hookResults, status };
      });
      if (notifyEffect) {
        onEffectRef.current?.({ sessionId, timeline, type: "timeline_applied" });
      }
    };
    const loadTimeline = async () => {
      const sequence = ++loadSequence;
      const startingEpoch = timelineEpoch;
      try {
        const timeline = await chatStore.load(sessionId);
        if (!cancelled && sequence === loadSequence && startingEpoch === timelineEpoch) {
          applyTimeline(timeline, false);
        }
      } catch (error) {
        if (sequence === loadSequence) fail("timeline.load", error);
      }
    };
    const loadAgentUiForms = async () => {
      const sequence = ++formsLoadSequence;
      try {
        const agentUiForms = await chatStore.listAgentUiForms(sessionId);
        if (!cancelled && sequence === formsLoadSequence) {
          setState((current) => (
            current.sessionId === sessionId ? { ...current, agentUiForms } : current
          ));
        }
      } catch (error) {
        if (sequence === formsLoadSequence) fail("agent-ui-forms.load", error);
      }
    };
    const reloadSession = async () => {
      if (cancelled || activeSessionIdRef.current !== sessionId) return;
      setState((current) => (
        current.sessionId === sessionId
          ? { ...current, error: "", status: "loading" }
          : current
      ));
      await Promise.all([loadTimeline(), loadAgentUiForms()]);
    };
    const scheduleStreamingTimeline = (timeline: ChatTimelineSnapshot) => {
      pendingStreamingTimeline = timeline;
      if (streamingFrame !== null) return;
      streamingFrame = window.requestAnimationFrame(() => {
        streamingFrame = null;
        const pending = pendingStreamingTimeline;
        pendingStreamingTimeline = null;
        if (pending) applyTimeline(pending, true);
      });
    };

    reloadRef.current = reloadSession;
    void reloadSession();
    const unsubscribe = subscribeChatEvents(chatStore, sessionId, (event) => {
      const effects = projectChatEventEffects(event);
      if (event.browserSnapshot) return;
      if (event.hookResults) {
        setState((current) => (
          current.sessionId === sessionId
            ? { ...current, hookResults: mergeHookResults(current.hookResults, event.hookResults ?? []) }
            : current
        ));
        return;
      }
      if (isCommandRuntimeEvent(event)) {
        if (event.commandId && event.type === "command.canonical-updated") {
          void loadTimeline();
          return;
        }
        onEffectRef.current?.({ event, sessionId, type: "command_received" });
        return;
      }
      if (event.timeline) {
        if (shouldFrameBatchTimeline(event.timeline)) {
          scheduleStreamingTimeline(event.timeline);
        } else {
          if (streamingFrame !== null) {
            window.cancelAnimationFrame(streamingFrame);
            streamingFrame = null;
            pendingStreamingTimeline = null;
          }
          applyTimeline(event.timeline, true);
        }
        return;
      }
      if (event.error) {
        fail("event", event.error);
        return;
      }
      if (event.message) {
        onEffectRef.current?.({ message: event.message, sessionId, type: "message_received" });
        return;
      }
      if (effects.reloadSessions) {
        onEffectRef.current?.({ event, sessionId, type: "session_refresh_requested" });
      }
      if (effects.reloadMessages) void loadTimeline();
      if (effects.reloadAgentUiForms) void loadAgentUiForms();
    });

    return () => {
      cancelled = true;
      loadSequence += 1;
      formsLoadSequence += 1;
      if (streamingFrame !== null) window.cancelAnimationFrame(streamingFrame);
      if (reloadRef.current === reloadSession) reloadRef.current = null;
      unsubscribe();
    };
  }, [chatStore, sessionId, timelineSource]);

  const actions = useMemo<ChatSessionRuntimeActions>(() => ({
    clearError,
    reload,
    reportError,
  }), [
    clearError,
    reload,
    reportError,
  ]);

  return { actions, state, timelineSource };
}

function initialState(
  sessionId: string,
  status: ChatSessionRuntimeStatus = sessionId ? "loading" : "idle",
): ChatSessionRuntimeState {
  return {
    agentUiForms: [],
    error: "",
    hookResults: [],
    sessionId,
    status,
  };
}

function mergeHookResults(
  current: HookExecutionResult[],
  incoming: readonly HookExecutionResult[],
): HookExecutionResult[] {
  if (!incoming.length || incoming.every((result) => current.includes(result))) return current;
  const merged = new Map(current.map((result) => [result.id, result]));
  for (const result of incoming) merged.set(result.id, result);
  return [...merged.values()];
}

function shouldFrameBatchTimeline(timeline: ChatTimelineSnapshot): boolean {
  return timeline.turns[timeline.turns.length - 1]?.status === "running";
}

function isCommandRuntimeEvent(event: ChatEvent): boolean {
  return Boolean(
    (event.command && event.type === "command.dispatched")
      || (event.commandId && event.type === "command.accepted")
      || (event.commandId && event.type === "command.canonical-updated")
      || (event.commandId && event.type === "error"),
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
