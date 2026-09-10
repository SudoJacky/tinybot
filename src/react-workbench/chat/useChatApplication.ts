import { useEffect, useEffectEvent, useState } from "react";
import type { TFunction } from "i18next";
import type { ChatTimelineSnapshot } from "../../app-core/chat/agentTimelineModel";
import { unavailableThreadEffectiveCapabilities } from "../../app-core/chat/threadCapabilities";
import type { ChatEvent, ChatStore, SessionSummary, SettingsStore, WorkspaceStore } from "../services";
import { subscribeChatEvents } from "./chatEventSource";
import { projectChatEventEffects } from "./chatEventPolicy";
import type { ChatSessionApplication, ChatSessionChange } from "./chatSessionApplication";
import type { DraftSession } from "./sessionTabWorkspace";
import { useChatSessionRuntime, type ChatSessionRuntimeEffect } from "./useChatSessionRuntime";
import { useChatSubmission } from "./useChatSubmission";
import { useChatTurnApplication } from "./useChatTurnApplication";
import { useChatTimelineSummary } from "./useChatTimelineSummary";
import type { ContextUsageDefaults } from "./chatContextUsage";

type Options = {
  chatStore: ChatStore;
  sessions: ChatSessionApplication;
  settingsStore?: SettingsStore;
  artifactReviews?: WorkspaceStore["artifactReviews"];
  sessionId: string;
  session?: SessionSummary;
  openSessionIds: readonly string[];
  drafts: Readonly<Record<string, DraftSession>>;
  model: { model?: string; modelProvider?: string };
  contextUsageDefaults: ContextUsageDefaults;
  now(): number;
  t: TFunction<"chat">;
  onDraftConsumed(sessionId: string): void;
  onBackgroundActivity(sessionId: string): void;
};

/** Coordinates Chat workflows; the page supplies selection and receives UI notifications. */
export function useChatApplication(options: Options) {
  const { chatStore, sessions, sessionId, session, openSessionIds, drafts, t } = options;
  const persistedSessionId = session?.id ?? "";
  const runtime = useChatSessionRuntime({ chatStore, sessionId: persistedSessionId, onEffect: receiveRuntimeEffect });
  const submission = useChatSubmission({
    chatStore, settingsStore: options.settingsStore, artifactReviews: options.artifactReviews,
    sessionId, now: options.now, t, reload: runtime.actions.reload,
    refreshSessions: sessions.refresh,
    materializeDraft: async () => {
      if (!sessions.snapshot().loaded || (sessionId && !drafts[sessionId])) return null;
      return sessions.materializeDraft(sessionId, drafts[sessionId], options.model);
    },
    previewSession: sessions.preview, consumeDraft: options.onDraftConsumed,
  });
  const [capabilities, setCapabilities] = useState(() => (
    unavailableThreadEffectiveCapabilities("", "loading", t("runtime.loadingCapabilities"))
  ));
  const timelineSummary = useChatTimelineSummary(runtime.timelineSource, options.contextUsageDefaults);
  const { application: turns, ...turnState } = useChatTurnApplication({
    dispatch: chatStore.dispatch, submitTurn: submission.submitTurn, refreshSessions: sessions.refresh,
    reportError: runtime.actions.reportError, clearError: runtime.actions.clearError,
    now: options.now, t,
  }, persistedSessionId, { timelineSource: runtime.timelineSource, capabilities });

  useEffect(() => {
    if (!persistedSessionId) {
      setCapabilities(unavailableThreadEffectiveCapabilities("", "no_session", t("runtime.noSessionSelected")));
      return;
    }
    let cancelled = false;
    setCapabilities(unavailableThreadEffectiveCapabilities(persistedSessionId, "loading", t("runtime.loadingCapabilities")));
    void chatStore.loadEffectiveCapabilities(persistedSessionId).then((value) => {
      if (!cancelled) setCapabilities(value);
    }).catch((error) => {
      if (!cancelled) setCapabilities(unavailableThreadEffectiveCapabilities(
        persistedSessionId, "capability_query_failed", error instanceof Error ? error.message : String(error),
      ));
    });
    return () => { cancelled = true; };
  }, [timelineSummary.activeTurnId, timelineSummary.activeTurnStatus, timelineSummary.formResolutionKey, persistedSessionId, chatStore, t]);

  function receiveTimeline(targetSessionId: string, snapshot: ChatTimelineSnapshot) {
    sessions.receiveTimeline(targetSessionId, snapshot);
    submission.receiveTimeline(targetSessionId, snapshot);
    if (targetSessionId !== persistedSessionId) turns.receiveTimeline(targetSessionId, snapshot);
  }

  function receiveRuntimeEffect(effect: ChatSessionRuntimeEffect) {
    if (effect.type === "timeline_applied") receiveTimeline(effect.sessionId, effect.timeline);
    else if (effect.type === "message_received") submission.receiveMessage(effect.sessionId, effect.message);
    else if (effect.type === "session_refresh_requested") void turns.receiveSessionEvent(effect.sessionId, effect.event);
    else turns.receiveCommand(effect.sessionId, effect.event);
  }

  const receiveSessionChange = useEffectEvent((event: ChatSessionChange) => {
    if (event.type === "replaced") {
      submission.replaceSession(event.previousSessionId, event.sessionId);
      turns.replaceSession(event.previousSessionId, event.sessionId);
    } else if (event.type === "removed") {
      submission.forgetSession(event.session.id);
      turns.forgetSession(event.session.id);
    }
  });
  useEffect(() => sessions.onChange(receiveSessionChange), [sessions]);

  const receiveBackgroundTimeline = useEffectEvent((targetSessionId: string, snapshot: ChatTimelineSnapshot) => {
    receiveTimeline(targetSessionId, snapshot);
    options.onBackgroundActivity(targetSessionId);
  });
  const receiveBackgroundEvent = useEffectEvent((targetSessionId: string, event: ChatEvent) => {
    const effects = projectChatEventEffects(event);
    turns.receiveCommand(targetSessionId, event);
    if (event.message) submission.receiveMessage(targetSessionId, event.message);
    if (effects.backgroundTabActivity) options.onBackgroundActivity(targetSessionId);
    if (effects.reloadSessions) void turns.receiveSessionEvent(targetSessionId, event);
  });
  useEffect(() => {
    const unsubscribes = openSessionIds.filter((id) => id !== sessionId && !(id in drafts)).map((id) => {
      let cancelled = false;
      let timelineEpoch = 0;
      let loadSequence = 0;
      const unsubscribe = subscribeChatEvents(chatStore, id, (event) => {
        if (event.browserSnapshot) return;
        if (event.timeline) {
          timelineEpoch += 1;
          receiveBackgroundTimeline(id, event.timeline);
        }
        receiveBackgroundEvent(id, event);
        // Canonical acknowledgements must still arrive after switching away from a command's tab.
        if (event.commandId && event.type === "command.canonical-updated") {
          const epoch = timelineEpoch;
          const sequence = ++loadSequence;
          void chatStore.load(id).then((snapshot) => {
            if (!cancelled && epoch === timelineEpoch && sequence === loadSequence) receiveBackgroundTimeline(id, snapshot);
          }).catch((error) => {
            if (cancelled || sequence !== loadSequence) return;
            console.error("[chat-application] background.timeline.load.failed", { sessionId: id, error });
            receiveBackgroundEvent(id, { type: "error", error: error instanceof Error ? error.message : String(error) });
          });
        }
      });
      return () => { cancelled = true; unsubscribe(); };
    });
    return () => unsubscribes.forEach((unsubscribe) => unsubscribe());
  }, [chatStore, drafts, openSessionIds, sessionId]);

  return {
    state: {
      ...runtime.state, ...turnState,
      timelineSummary,
      optimisticMessages: submission.optimisticMessages,
      compactingSessionId: submission.compactingSessionId,
      artifactReviewEpoch: submission.artifactReviewEpoch,
    },
    turns,
    timelineSource: runtime.timelineSource,
    actions: {
      ...runtime.actions,
      send: (input: Parameters<typeof submission.send>[0]) => submission.send(input, session, turns),
      saveDefaultModel: submission.saveDefaultModel,
      async fork(targetSessionId: string, messageId: string) {
        sessions.accept(await submission.fork(targetSessionId, messageId));
      },
      async completeBrowserHandoff(targetSessionId: string) {
        await submission.submitTurn(targetSessionId, { text: t("browserHandoffContinue") }, "browser-handoff-complete");
        await sessions.refresh(session);
      },
    },
  };
}
