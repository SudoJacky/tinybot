import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentUiForm } from "../../app-core/agent-ui/agentUiEvents";
import type { ChatTimelineSnapshot } from "../../app-core/chat/agentTimelineModel";
import type {
  TinyOsNativeBrowserSession,
  TinyOsNativeSnapshot,
} from "../../app-core/chat/tinyOsNativeSnapshot";
import type { ChatEvent, ChatStore } from "../services";
import type { ReactChatMessage } from "./messageActions";
import { projectChatEventEffects } from "./chatEventPolicy";

export type ChatSessionRuntimeStatus = "idle" | "loading" | "ready" | "failed";

export type ChatSessionRuntimeState = {
  agentUiForms: AgentUiForm[];
  browserError: string;
  browserSnapshot?: TinyOsNativeSnapshot<TinyOsNativeBrowserSession>;
  error: string;
  sessionId: string;
  status: ChatSessionRuntimeStatus;
  timeline: ChatTimelineSnapshot | null;
};

export type ChatSessionRuntimeEffect =
  | { event: ChatEvent; sessionId: string; type: "command_received" }
  | { message: ReactChatMessage; sessionId: string; type: "message_received" }
  | { event: ChatEvent; sessionId: string; type: "session_refresh_requested" }
  | { sessionId: string; timeline: ChatTimelineSnapshot; type: "timeline_applied" };

export type ChatSessionRuntimeActions = {
  acceptBrowserSnapshot(snapshot: TinyOsNativeSnapshot<TinyOsNativeBrowserSession>): void;
  clearBrowserError(): void;
  clearBrowserSnapshot(browserSessionId?: string): void;
  clearError(): void;
  reload(): Promise<void>;
  reportBrowserError(error: unknown): void;
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
} {
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
      status: current.sessionId ? (current.timeline ? "ready" : "loading") : "idle",
    }));
  }, []);
  const reportBrowserError = useCallback((error: unknown) => {
    setState((current) => ({ ...current, browserError: errorMessage(error) }));
  }, []);
  const clearBrowserError = useCallback(() => {
    setState((current) => ({ ...current, browserError: "" }));
  }, []);
  const acceptBrowserSnapshot = useCallback((snapshot: TinyOsNativeSnapshot<TinyOsNativeBrowserSession>) => {
    const activeSessionId = activeSessionIdRef.current;
    if (activeSessionId && snapshot.data.sessionId !== activeSessionId) {
      throw new Error(
        `Browser snapshot session ${snapshot.data.sessionId} does not match active session ${activeSessionId}.`,
      );
    }
    setState((current) => ({ ...current, browserError: "", browserSnapshot: snapshot }));
  }, []);
  const clearBrowserSnapshot = useCallback((browserSessionId?: string) => {
    setState((current) => {
      if (browserSessionId && current.browserSnapshot?.data.browserSessionId !== browserSessionId) {
        return current;
      }
      return { ...current, browserError: "", browserSnapshot: undefined };
    });
  }, []);
  const reload = useCallback(async () => {
    await reloadRef.current?.();
  }, []);

  useEffect(() => {
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
      setState((current) => (
        current.sessionId === sessionId
          ? {
              ...current,
              error: notifyEffect ? "" : current.error,
              status: !notifyEffect && current.error ? "failed" : "ready",
              timeline,
            }
          : current
      ));
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
    const unsubscribe = chatStore.subscribe(sessionId, (event) => {
      const effects = projectChatEventEffects(event);
      if (event.browserSnapshot) {
        try {
          acceptBrowserSnapshot(event.browserSnapshot);
        } catch (error) {
          fail("browser-snapshot.apply", error);
        }
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
  }, [acceptBrowserSnapshot, chatStore, sessionId]);

  const actions = useMemo<ChatSessionRuntimeActions>(() => ({
    acceptBrowserSnapshot,
    clearBrowserError,
    clearBrowserSnapshot,
    clearError,
    reload,
    reportBrowserError,
    reportError,
  }), [
    acceptBrowserSnapshot,
    clearBrowserError,
    clearBrowserSnapshot,
    clearError,
    reload,
    reportBrowserError,
    reportError,
  ]);

  return { actions, state };
}

function initialState(
  sessionId: string,
  status: ChatSessionRuntimeStatus = sessionId ? "loading" : "idle",
): ChatSessionRuntimeState {
  return {
    agentUiForms: [],
    browserError: "",
    error: "",
    sessionId,
    status,
    timeline: null,
  };
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
