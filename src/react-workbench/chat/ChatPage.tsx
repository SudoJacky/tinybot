import { SidecarResources, initialSidecarLayout, type SidecarResourcesHandle, type SidecarLayout } from "../sidecar/SidecarResources";
import { useChatSubmission } from "./useChatSubmission";
import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useMemo, useReducer, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { elementTransitions, useExitPresence } from "../lib/useExitPresence";
import type { TFunction } from "i18next";
import {
  Check,
  ChevronDown,
  FolderOpen,
  Loader2,
  MoreHorizontal,
  PanelRightClose,
  PanelRightOpen,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import "./ChatPage.css";
import { ChatQueueNotice, ChatQueuedInputs } from "./ChatQueuedInputs";
import { useChatTurnApplication } from "./useChatTurnApplication";
import {
  ClaudeStyleAiInput,
  type ComposerContextReference,
  type ComposerFileReference,
  type ComposerSendOptions,
  type ComposerSessionMentionOption,
  type ComposerSkillOption,
  type ComposerSlashCommand,
  type ComposerToolOption,
  type ModelOption,
  type PastedContent,
} from "../../components/ui/claude-style-ai-input";
import { formatRelativeUpdatedTime } from "../lib/relativeTime";
import type { ChatEvent, ChatModelOption, ChatStore, ProjectGroupStore, SessionStore, SessionSummary, SettingsStore, SkillSummary, ToolSummary, ToolsStore, WorkspaceRegistryStore, WorkspaceStore } from "../services";
import {
  clearDefaultChatModel,
  readDefaultChatModelPreference,
} from "../../app-core/chat/chatModelPreference";
import {
  readCurrentChatReasoningEffort,
  writeCurrentChatReasoningEffort,
} from "../../app-core/chat/reasoningEffort";
import { pickDesktopChatFiles } from "../../app-core/native/desktopNativeFilePicker";
import { reduceSessionDeleteState } from "../sessions/sessionDeleteState";
import type { ToolCallSummary } from "./messageActions";
import type { AgentUiForm } from "../../app-core/agent-ui/agentUiEvents";
import { AgentUiFormCard } from "./AgentUiFormCard";
import {
  projectChatEventEffects,
  projectTimelineSessionStatus,
} from "./chatEventPolicy";
import {
  projectLatestContextUsage,
  type ContextUsageDefaults,
} from "./chatContextUsage";
import { SessionTabStrip, type SessionTabItem } from "./SessionTabStrip";
import {
  INITIAL_SESSION_TAB_WORKSPACE,
  readPersistedSessionTabWorkspace,
  reduceSessionTabWorkspace,
  sessionTabDraft,
  writePersistedSessionTabWorkspace,
  type DraftSession,
  type DraftSessionCreateInput,
} from "./sessionTabWorkspace";
import {
  groupSessionsByWorkspace,
} from "./sessionWorkspaces";
import {
  applyLoadedDelegatedAgentTrace,
} from "../../app-core/chat/chatProjection";
import type {
  ArtifactRef,
  DelegatedAgentState,
} from "../../app-core/chat/chatTurnContracts";
import {
  type SpreadsheetCellChangeRequest,
} from "../../app-core/chat/officeArtifact";
import type { AgentInputReference } from "../../app-core/chat/agentInputReference";
import { logRendererEvent } from "../../app-core/native/rendererLogger";
import type { ChatTimelineSnapshot } from "../../app-core/chat/agentTimelineModel";
import {
  isThreadCommandInFlight,
  type ThreadCommandLifecycle,
  type ThreadCommand,
} from "../../app-core/chat/threadCommand";
import {
  unavailableThreadEffectiveCapabilities,
  type ThreadEffectiveCapabilities,
} from "../../app-core/chat/threadCapabilities";
import {
  useChatSessionRuntime,
  type ChatSessionRuntimeEffect,
} from "./useChatSessionRuntime";
import {
  MAX_COMPOSER_SESSION_REFERENCES,
  type SpreadsheetComposerAnnotation,
} from "./chatSubmission";
import { ChatTimeline } from "./ChatTimeline";
import { captureConversationView, restoreConversationView, type ConversationViewState } from "./conversationViewport";
import { EmptyChatStart } from "./EmptyChatStart";
import { FloatingPlanStatus } from "./FloatingPlanStatus";
import type { AssistantFileLink } from "./assistantFileLinks";
import {
  ChatSessionWorkspace,
  type ProjectSessionContext,
} from "./ChatSessionWorkspace";
import {
  displaySessionTitle,
  isDefaultSessionTitle,
} from "./sessionTitle";
import { projectTinybotMascotMood, type TinybotMascotMood } from "./TinybotMascot";

export type ChatPageProps = {
  chatStore: ChatStore;
  sessionStore: SessionStore;
  projectGroupStore?: ProjectGroupStore;
  workspaceRegistryStore?: WorkspaceRegistryStore;
  settingsStore?: SettingsStore;
  toolsStore?: Partial<Pick<ToolsStore, "installPluginMigration" | "loadCatalog">>;
  workspaceStore?: Pick<WorkspaceStore, "readThreadFile" | "readThreadFileBytes" | "artifactReviews">;
  createSessionSignal?: number;
  activateSessionRequest?: { sessionId: string; signal: number } | null;
  sessionSidebarCollapsed?: boolean;
  onSessionSidebarCollapsedChange?: (collapsed: boolean) => void;
  onActiveWorkspaceChange?: (workingDirectory?: string) => void;
  onStopGenerationTargetChange?: (sessionId: string) => void;
  onMascotMoodChange?: (mood: TinybotMascotMood) => void;
  onStartupSessionHydrated?: () => void;
  startInNewSession?: boolean;
  now?: () => number;
};

const unavailableWorkspaceRegistryStore: WorkspaceRegistryStore = {
  list: async () => [],
  register: async () => {
    throw new Error("Workspace registry is unavailable in this runtime");
  },
  rename: async () => {
    throw new Error("Workspace registry is unavailable in this runtime");
  },
  forget: async () => {
    throw new Error("Workspace registry is unavailable in this runtime");
  },
};

type DrawerState =
  | { kind: "tool"; title: string; toolCall: ToolCallSummary }
  | { kind: "subagent"; title: string; delegate: DelegatedAgentState; loading: boolean; error?: string }
  | null;

function resolveComposerModel(
  models: readonly ModelOption[],
  sessionModel = "",
  sessionProvider = "",
): string {
  const sessionOption = findComposerModel(models, sessionModel, sessionProvider);
  if (sessionOption) {
    return sessionOption.id;
  }
  const stored = readDefaultChatModelPreference();
  const storedOption = findComposerModel(models, stored?.modelId ?? "", stored?.providerId ?? "");
  if (storedOption) {
    return storedOption.id;
  }
  if (stored) {
    clearDefaultChatModel();
  }
  return models[0]?.id || "";
}

function findComposerModel(
  models: readonly ModelOption[],
  modelId: string,
  providerId = "",
): ModelOption | undefined {
  if (!modelId) return undefined;
  const actualModelId = (model: ModelOption) => model.modelId || model.id;
  return (providerId
    ? models.find((model) => actualModelId(model) === modelId && model.providerId === providerId)
    : undefined)
    ?? models.find((model) => actualModelId(model) === modelId);
}

function composerSessionModelInput(
  models: readonly ModelOption[],
  selectionId: string,
): { model?: string; modelProvider?: string } {
  const selected = models.find((model) => model.id === selectionId);
  if (!selected) return {};
  return {
    model: selected.modelId || selected.id,
    ...(selected.providerId ? { modelProvider: selected.providerId } : {}),
  };
}

function composerSlashCommands(t: TFunction<"chat">): readonly ComposerSlashCommand[] {
  return [{
    command: "/compact",
    description: t("commands.compact.description"),
    label: t("commands.compact.label"),
    prompt: "/compact",
    submitOnSelect: true,
  }];
}

function buildComposerSkillOptions(
  skills: readonly SkillSummary[],
  t: TFunction<"chat">,
): readonly ComposerSkillOption[] {
  return skills.map((skill) => ({
    description: skill.description,
    id: skill.source === "workspace" ? skill.name : skill.id,
    label: skill.name
      .split(/[-_.]+/u)
      .filter(Boolean)
      .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
      .join(" "),
    sourceLabel: skill.source === "workspace"
      ? t("composer.skill.workspace")
      : skill.source.replace(/^plugin:/u, ""),
  }));
}

function buildComposerToolOptions(tools: readonly ToolSummary[]): ComposerToolOption[] {
  return tools.map((tool) => {
    const allowed = tool.allowed ?? tool.enabled ?? true;
    const defaultSelected = tool.defaultSelected ?? allowed;
    return {
      available: tool.available,
      allowed,
      defaultSelected,
      description: tool.description,
      disabled: !tool.available || !allowed,
      id: tool.id,
      name: tool.displayName || tool.name,
      selected: tool.selected ?? defaultSelected,
    };
  });
}

const SESSION_DELETE_DISSOLVE_MS = 180;

function latestTurnPlan(timeline: ChatTimelineSnapshot | null | undefined) {
  const turns = timeline?.turns ?? [];
  for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const turn = turns[turnIndex];
    const step = [...turn.steps].reverse().find((candidate) => candidate.kind === "plan" && candidate.plan);
    if (!step?.plan) continue;
    return {
      identityKey: `${turn.id}:${step.id}`,
      plan: step.plan,
      revisionKey: JSON.stringify({ plan: step.plan, status: step.status }),
    };
  }
  return undefined;
}

export function ChatPage({
  activateSessionRequest = null,
  chatStore,
  createSessionSignal = 0,
  now = Date.now,
  onActiveWorkspaceChange,
  onMascotMoodChange,
  onSessionSidebarCollapsedChange,
  onStartupSessionHydrated,
  onStopGenerationTargetChange,
  sessionSidebarCollapsed,
  sessionStore,
  startInNewSession = false,
  projectGroupStore,
  workspaceRegistryStore = unavailableWorkspaceRegistryStore,
  settingsStore,
  toolsStore,
  workspaceStore,
}: ChatPageProps) {
  const { i18n, t } = useTranslation("chat");
  const slashCommands = useMemo(() => composerSlashCommands(t), [t]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [startInNewSessionOnMount] = useState(startInNewSession);
  const [sessionTabs, dispatchSessionTabs] = useReducer(
    reduceSessionTabWorkspace,
    INITIAL_SESSION_TAB_WORKSPACE,
  );
  const [threadCapabilities, setThreadCapabilities] = useState<ThreadEffectiveCapabilities>(() => (
    unavailableThreadEffectiveCapabilities("", "loading", t("runtime.loadingCapabilities"))
  ));
  const [composerModels, setComposerModels] = useState<ModelOption[]>([]);
  const [composerModel, setComposerModel] = useState("");
  const [composerReasoningEffort, setComposerReasoningEffort] = useState(readCurrentChatReasoningEffort);
  const [composerSkills, setComposerSkills] = useState<SkillSummary[]>([]);
  const [composerTools, setComposerTools] = useState<ToolSummary[]>([]);
  const [contextUsageDefaults, setContextUsageDefaults] = useState<ContextUsageDefaults>({});
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  const [sessionWorkspaceError, setSessionWorkspaceError] = useState("");
  const [sessionCreatePending, setSessionCreatePending] = useState(false);
  const [localSessionSidebarCollapsed, setLocalSessionSidebarCollapsed] = useState(false);
  const [drawer, setDrawer] = useState<DrawerState>(null);
  const [drawerSessionId, setDrawerSessionId] = useState("");
  const drawerElementRef = useRef<HTMLElement>(null);
  const drawerTriggerRef = useRef<HTMLElement | null>(null);
  const sidecarToggleRef = useRef<HTMLButtonElement>(null);
  const sidecarResources = useRef<SidecarResourcesHandle>(null);
  const [sidecar, setSidecar] = useState<SidecarLayout>(initialSidecarLayout);
  const [composerFocusRequestId, setComposerFocusRequestId] = useState(0);
  const [composerSessionMentionIds, setComposerSessionMentionIds] = useState<string[]>([]);
  const [composerSelectedSkillIds, setComposerSelectedSkillIds] = useState<string[]>([]);
  const [composerArtifactReferences, setComposerArtifactReferences] = useState<(AgentInputReference & { id: string })[]>([]);
  const [composerSpreadsheetAnnotations, setComposerSpreadsheetAnnotations] = useState<SpreadsheetComposerAnnotation[]>([]);
  const [installingMigrationJobId, setInstallingMigrationJobId] = useState("");
  const [migrationInstallError, setMigrationInstallError] = useState("");
  const [showBackToLatest, setShowBackToLatest] = useState(false);
  const [dissolvingSessionIds, setDissolvingSessionIds] = useState<Set<string>>(() => new Set());
  const [deleteState, dispatchDelete] = useReducer(reduceSessionDeleteState, { confirmingSessionId: "" });
  const sessionsRef = useRef<SessionSummary[]>([]);
  const deleteDissolveTimers = useRef<number[]>([]);
  const lastCreateSessionSignal = useRef(createSessionSignal);
  const lastActivateSessionSignal = useRef<number | null>(null);
  const draftSessionCreatePromise = useRef<Promise<SessionSummary> | null>(null);
  const draftSessionSequence = useRef(0);
  const sessionTabsRef = useRef(sessionTabs);
  const sessionsLoadedRef = useRef(sessionsLoaded);
  const optimisticSessionTitlesRef = useRef<Map<string, string>>(new Map());
  const conversationRef = useRef<HTMLDivElement | null>(null);
  const conversationEndRef = useRef<HTMLDivElement | null>(null);
  const conversationViewBySessionRef = useRef<Map<string, ConversationViewState>>(new Map());
  const pendingConversationRestoreRef = useRef("");
  const hasActivatedSessionRef = useRef(false);
  const stickToLatestRef = useRef(true);
  sessionTabsRef.current = sessionTabs;
  sessionsLoadedRef.current = sessionsLoaded;
  const activeSessionId = sessionTabs.activeSessionId;
  const currentDrawer = drawerSessionId === activeSessionId ? drawer : null;
  const readDrawerTransitions = useCallback(() => elementTransitions(drawerElementRef.current, ["opacity", "transform"]), []);
  const presentDrawer = useExitPresence(currentDrawer, activeSessionId, readDrawerTransitions);
  useLayoutEffect(() => { setDrawer(null); }, [activeSessionId]);
  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId),
    [activeSessionId, sessions],
  );
  const draftSessions = useMemo<SessionSummary[]>(() => (
    Object.values(sessionTabs.draftSessionsById).map(projectDraftSessionSummary)
  ), [sessionTabs.draftSessionsById]);
  const activeDraftSession = useMemo(
    () => draftSessions.find((session) => session.id === activeSessionId),
    [activeSessionId, draftSessions],
  );
  const activeDraft = sessionTabs.draftSessionsById[activeSessionId];
  const displayedSessions = useMemo(
    () => [...draftSessions, ...sessions],
    [draftSessions, sessions],
  );
  const activeDisplaySession = activeSession ?? activeDraftSession;
  useEffect(() => {
    const workingDirectory = activeDisplaySession?.pluginMigration
      ? undefined
      : activeDisplaySession?.workingDirectory?.trim() || undefined;
    onActiveWorkspaceChange?.(workingDirectory);
  }, [activeDisplaySession?.pluginMigration, activeDisplaySession?.workingDirectory, onActiveWorkspaceChange]);
  const activePersistedSessionId = activeSession?.id ?? "";
  const sessionRuntime = useChatSessionRuntime({
    chatStore,
    onEffect: handleChatSessionRuntimeEffect,
    sessionId: activePersistedSessionId,
  });
  const {
    agentUiForms,
    error: timelineError,
    hookResults,
    timeline,
  } = sessionRuntime.state;
  const {
    clearError: clearTimelineError,
    reload: reloadSessionRuntime,
    reportError: reportTimelineError,
  } = sessionRuntime.actions;
  const composerDraft = sessionTabDraft(sessionTabs, activeSessionId);
  const submission = useChatSubmission({
    chatStore, settingsStore, artifactReviews: workspaceStore?.artifactReviews,
    sessionId: activeSessionId, now, t, reload: reloadSessionRuntime,
    refreshSessions: handleSessionStoreRefresh, materializeDraft: createSessionForDraft,
    previewSession(session) {
      optimisticSessionTitlesRef.current.set(session.id, session.title);
      setSessions((current) => current.map((candidate) => candidate.id === session.id ? session : candidate));
    },
    consumeDraft(sessionId) { dispatchSessionTabs({ type: "draft.changed", sessionId, value: "" }); },
  });
  const { optimisticMessages, compactingSessionId, artifactReviewEpoch } = submission;

  const resolvedSessionSidebarCollapsed = sessionSidebarCollapsed ?? localSessionSidebarCollapsed;
  const composerSkillOptions = useMemo(
    () => buildComposerSkillOptions(composerSkills, t),
    [composerSkills, t],
  );
  const composerToolOptions = useMemo(
    () => buildComposerToolOptions(composerTools),
    [composerTools],
  );
  const composerArtifactContextReferences = useMemo<ComposerContextReference[]>(() => (
    [...composerArtifactReferences.map((reference): ComposerContextReference => ({
      id: reference.id, kind: "file", label: reference.title, detail: reference.detail,
      body: reference.sourcePath !== reference.title ? reference.sourcePath : undefined,
    })), ...composerSpreadsheetAnnotations.map((annotation): ComposerContextReference => ({
      annotation: {
        label: t("composer.spreadsheetAnnotation.count", { count: 1 }),
        text: annotation.request.instruction,
      },
      body: annotation.request.value || t("details.officeCellEmpty"),
      detail: t("composer.spreadsheetAnnotation.range", {
        range: `${annotation.request.sheet}!${annotation.request.address}`,
      }),
      id: annotation.id,
      kind: "file",
      label: annotation.fileTitle,
    }))]
  ), [composerArtifactReferences, composerSpreadsheetAnnotations, t]);
  useEffect(() => {
    if (!toolsStore?.loadCatalog) {
      setComposerSkills([]);
      setComposerTools([]);
      return;
    }
    let cancelled = false;
    const workingDirectory = activeDisplaySession?.pluginMigration
      ? undefined
      : activeDisplaySession?.workingDirectory?.trim() || undefined;
    setComposerSkills([]);
    setComposerTools([]);
    void toolsStore.loadCatalog({ workingDirectory }).then((catalog) => {
      if (!cancelled) {
        setComposerSkills(catalog.skills);
        setComposerTools(catalog.tools.filter((tool) => (
          tool.source !== "agent_graph" || Boolean(workingDirectory)
        )));
      }
    }).catch((error) => {
      if (cancelled) return;
      console.error("[chat] composer.catalog.load.failed", {
        error: error instanceof Error ? error.message : String(error),
        workingDirectory,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [activeDisplaySession?.pluginMigration, activeDisplaySession?.workingDirectory, toolsStore]);
  useEffect(() => {
    setMigrationInstallError("");
  }, [activeSessionId]);
  const openSessionTabs = useMemo<SessionTabItem[]>(() => (
    sessionTabs.openSessionIds.flatMap((sessionId) => {
      const session = displayedSessions.find((candidate) => candidate.id === sessionId);
      return session ? [{
        id: session.id,
        status: session.status,
        title: displaySessionTitle(session.title, t),
        unread: sessionTabs.unreadSessionIds.includes(session.id),
      }] : [];
    })
  ), [displayedSessions, sessionTabs.openSessionIds, sessionTabs.unreadSessionIds, t]);
  const allSessionWorkspaces = useMemo(() => groupSessionsByWorkspace(sessions).map((workspace) => ({
    ...workspace,
    label: workspace.label ?? t("shell.generalSessions"),
  })), [sessions, t]);
  const composerSessionMentionOptions = useMemo<ComposerSessionMentionOption[]>(() => {
    if (!activeSession || activeSession.pluginMigration) return [];
    const currentWorkspace = allSessionWorkspaces.find((workspace) => (
      workspace.sessions.some((session) => session.id === activeSession.id)
    ));
    return (currentWorkspace?.sessions ?? [])
      .filter((session) => session.id !== activeSession.id && !session.pluginMigration)
      .sort((left, right) => right.updatedAtMs - left.updatedAtMs)
      .map((session) => ({
        detail: `${t("composer.sessionMention.conversation")} · ${formatRelativeUpdatedTime(session.updatedAtMs, now(), i18n.language, t("search.noDate"))}`,
        id: session.id,
        label: displaySessionTitle(session.title, t),
      }));
  }, [activeSession, allSessionWorkspaces, i18n.language, now, t]);
  const draftNewSession = sessionsLoaded && !activeSession && (
    Boolean(activeDraftSession) || !activeSessionId
  );
  const timelineLoaded = Boolean(activeSession) && timeline?.sessionId === activeSession?.id;
  const emptyActiveSession = draftNewSession || (timelineLoaded && timeline?.turns.length === 0 && optimisticMessages.length === 0);
  const sessionRunning = activeSession?.status === "running";
  const activeTurn = useMemo(() => timelineLoaded
    ? [...(timeline?.turns ?? [])].reverse().find((turn) => (
      turn.status === "pending"
      || turn.status === "running"
      || turn.status === "awaiting_user"
    ))
    : undefined, [timeline, timelineLoaded]);
  const sessionResponding = timelineLoaded
    ? Boolean(activeTurn) || (sessionRunning && optimisticMessages.length > 0)
    : sessionRunning && !emptyActiveSession;
  const latestTurnStatus = timelineLoaded
    ? timeline?.turns[timeline.turns.length - 1]?.status
    : undefined;
  const showPluginMigrationResult = activeSession?.pluginMigration?.status === "installed"
    || (
      activeSession?.pluginMigration?.status === "pending"
      && latestTurnStatus === "completed"
    );
  const {
    application: chatApplication,
    lifecycle: commandLifecycle,
    canCancel: canCancelTurn,
    cancelUnavailableReason,
  } = useChatTurnApplication({
    dispatch: chatStore.dispatch,
    submitTurn: submission.submitTurn,
    refreshSessions: handleSessionStoreRefresh,
    reportError: reportTimelineError,
    clearError: clearTimelineError,
    now,
    t,
  }, activePersistedSessionId, { timeline, capabilities: threadCapabilities });
  const compactingActiveSession = Boolean(activeSession && compactingSessionId === activeSession.id);
  const showCommandLifecycleStatus = commandLifecycle.stage !== "idle"
    && commandLifecycle.command.kind !== "agent.cancel";
  const submittingFormId = commandLifecycle.stage !== "idle"
    && (commandLifecycle.command.kind === "form.submit" || commandLifecycle.command.kind === "form.cancel")
    && isThreadCommandInFlight(commandLifecycle)
    ? commandLifecycle.command.form.formId
    : "";
  const activeContextUsage = useMemo(
    () => projectLatestContextUsage(timeline?.turns ?? [], contextUsageDefaults),
    [contextUsageDefaults, timeline],
  );
  const latestFailedTurnId = useMemo(() => (
    [...(timeline?.turns ?? [])].reverse().find((turn) => turn.status === "failed" || turn.status === "interrupted")?.id ?? ""
  ), [timeline]);
  const floatingPlan = useMemo(
    () => activeSession && timelineLoaded ? latestTurnPlan(timeline) : undefined,
    [activeSession, timeline, timelineLoaded],
  );
  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    if (!activePersistedSessionId) {
      setThreadCapabilities(unavailableThreadEffectiveCapabilities("", "no_session", t("runtime.noSessionSelected")));
      return;
    }
    let cancelled = false;
    setThreadCapabilities(unavailableThreadEffectiveCapabilities(
      activePersistedSessionId,
      "loading",
      t("runtime.loadingCapabilities"),
    ));
    void chatStore.loadEffectiveCapabilities(activePersistedSessionId).then((capabilities) => {
      if (!cancelled) setThreadCapabilities(capabilities);
    }).catch((error) => {
      if (!cancelled) {
        setThreadCapabilities(unavailableThreadEffectiveCapabilities(
          activePersistedSessionId,
          "capability_query_failed",
          error instanceof Error ? error.message : String(error),
        ));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [activeTurn?.id, activeTurn?.status, activePersistedSessionId, chatStore, t]);

  useEffect(() => {
    setComposerSessionMentionIds([]);
    setComposerSelectedSkillIds([]);
    setComposerSpreadsheetAnnotations([]);
    setComposerArtifactReferences([]);
  }, [activeSessionId]);

  useEffect(() => {
    return () => {
      deleteDissolveTimers.current.forEach((timer) => window.clearTimeout(timer));
      deleteDissolveTimers.current = [];
    };
  }, []);

  const notifyStartupSessionHydrated = useEffectEvent(() => {
    onStartupSessionHydrated?.();
  });
  useEffect(() => {
    let cancelled = false;
    void sessionStore.list().then((nextSessions) => {
      if (cancelled) {
        return;
      }
      sessionsRef.current = nextSessions;
      setSessions(nextSessions);
      setSessionsLoaded(true);
      dispatchSessionTabs({
        type: "hydrate",
        availableSessionIds: nextSessions.map((session) => session.id),
        persisted: startInNewSessionOnMount
          ? { activeSessionId: "", draftsBySession: {}, openSessionIds: [] }
          : readPersistedSessionTabWorkspace(window.localStorage),
      });
      notifyStartupSessionHydrated();
    });
    return () => {
      cancelled = true;
    };
  }, [sessionStore, startInNewSessionOnMount]);

  useEffect(() => {
    if (!sessionsLoaded) {
      return;
    }
    const timer = window.setTimeout(() => {
      writePersistedSessionTabWorkspace(window.localStorage, sessionTabs);
    }, 180);
    return () => window.clearTimeout(timer);
  }, [sessionTabs, sessionsLoaded]);

  useEffect(() => () => {
    if (sessionsLoadedRef.current) {
      writePersistedSessionTabWorkspace(window.localStorage, sessionTabsRef.current);
    }
  }, []);

  const createSessionFromSignal = useEffectEvent(() => {
    void handleCreateSession();
  });
  useEffect(() => {
    if (createSessionSignal === lastCreateSessionSignal.current) {
      return;
    }
    lastCreateSessionSignal.current = createSessionSignal;
    createSessionFromSignal();
  }, [createSessionSignal]);

  const activateRequestedSession = useEffectEvent(async (sessionId: string) => {
    const nextSessions = sessionStore.refresh
      ? await sessionStore.refresh()
      : await sessionStore.list();
    const target = nextSessions.find((session) => session.id === sessionId);
    if (!target) throw new Error(`Cannot activate unknown Thread ${sessionId}`);
    sessionsRef.current = nextSessions;
    setSessions(nextSessions);
    dispatchDelete({ type: "session-selected", sessionId });
    dispatchSessionTabs({ type: "open", sessionId });
  });
  useEffect(() => {
    if (!sessionsLoaded
      || !activateSessionRequest
      || activateSessionRequest.signal === lastActivateSessionSignal.current) {
      return;
    }
    lastActivateSessionSignal.current = activateSessionRequest.signal;
    void activateRequestedSession(activateSessionRequest.sessionId).catch((error) => {
      reportTimelineError(error);
      console.error("[chat] external-session-activation.failed", {
        error: error instanceof Error ? error.message : String(error),
        sessionId: activateSessionRequest.sessionId,
      });
    });
  }, [activateSessionRequest, reportTimelineError, sessionsLoaded]);

  const handleBackgroundChatEvent = useEffectEvent((sessionId: string, event: ChatEvent) => {
    const effects = projectChatEventEffects(event);
    chatApplication.receiveCommand(sessionId, event);
    if (event.timeline) {
      chatApplication.receiveTimeline(sessionId, event.timeline);
      updateSessionStatusFromTimeline(sessionId, event.timeline);
      dispatchSessionTabs({ type: "activity", sessionId });
    }
    if (effects.backgroundTabActivity) {
      dispatchSessionTabs({ type: "activity", sessionId });
    }
    if (effects.reloadSessions) {
      void chatApplication.receiveSessionEvent(sessionId, event);
    }
  });
  useEffect(() => {
    const unsubscribes = sessionTabs.openSessionIds
      .filter((sessionId) => (
        sessionId !== activeSessionId && !(sessionId in sessionTabs.draftSessionsById)
      ))
      .map((sessionId) => chatStore.subscribe(sessionId, (event) => {
        handleBackgroundChatEvent(sessionId, event);
      }));
    return () => unsubscribes.forEach((unsubscribe) => unsubscribe());
  }, [activeSessionId, chatStore, sessionTabs.draftSessionsById, sessionTabs.openSessionIds]);

  useEffect(() => {
    if (!settingsStore?.loadChatModels) {
      setComposerModels([]);
      setComposerModel("");
      return;
    }
    let cancelled = false;
    void settingsStore.loadChatModels().then((models) => {
      if (cancelled) {
        return;
      }
      const nextModels = models.map((model) => toComposerModelOption(model, t));
      setComposerModels(nextModels);
      setComposerModel(resolveComposerModel(nextModels));
    }).catch(() => {
      if (!cancelled) {
        setComposerModels([]);
        setComposerModel("");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [settingsStore, t]);

  useEffect(() => {
    if (!composerModels.length) return;
    const model = resolveComposerModel(
      composerModels,
      activeSession?.model,
      activeSession?.modelProvider,
    );
    setComposerModel(model);
  }, [activeSession?.id, activeSession?.model, activeSession?.modelProvider, composerModels]);

  useEffect(() => {
    if (!settingsStore?.loadAgentDefaultsSettings) {
      setContextUsageDefaults({});
      return;
    }
    let cancelled = false;
    void settingsStore.loadAgentDefaultsSettings().then((settings) => {
      const contextWindowTokens = settings.fallbackContextWindowTokens;
      if (!Number.isSafeInteger(contextWindowTokens) || contextWindowTokens <= 0) {
        throw new Error(`Invalid context window token fallback: ${contextWindowTokens}`);
      }
      if (!cancelled) {
        setContextUsageDefaults({
          contextWindowStrategy: settings.values.contextWindowStrategy.trim() || undefined,
          contextWindowTokens,
        });
      }
    }).catch((error) => {
      console.error("[chat] context.defaults.load.failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      if (!cancelled) {
        setContextUsageDefaults({});
      }
    });
    return () => {
      cancelled = true;
    };
  }, [settingsStore]);

  const stopGenerationSessionId = activeSession && sessionResponding ? activeSession.id : "";
  useEffect(() => {
    onStopGenerationTargetChange?.(stopGenerationSessionId);
  }, [onStopGenerationTargetChange, stopGenerationSessionId]);

  useEffect(() => {
    const view = conversationViewBySessionRef.current.get(activeSessionId);
    if (activeSessionId && !hasActivatedSessionRef.current) {
      hasActivatedSessionRef.current = true;
      pendingConversationRestoreRef.current = "";
    } else {
      pendingConversationRestoreRef.current = activeSessionId;
    }
    stickToLatestRef.current = view?.stickToLatest ?? true;
    setShowBackToLatest(view ? !view.stickToLatest : false);
  }, [activeSessionId]);

  useEffect(() => {
    const element = conversationRef.current;
    const view = conversationViewBySessionRef.current.get(activeSessionId);
    const shouldRestore = Boolean(
      activeSessionId
      && pendingConversationRestoreRef.current === activeSessionId
      && timeline?.sessionId === activeSessionId,
    );
    if (element && view && !view.stickToLatest && shouldRestore) {
      return restoreConversationView(element, view, () => {
        pendingConversationRestoreRef.current = "";
      });
    }
    if (shouldRestore) {
      pendingConversationRestoreRef.current = "";
    }
    if (stickToLatestRef.current) {
      conversationEndRef.current?.scrollIntoView({ block: "end" });
    }
  }, [activeSessionId, timeline, optimisticMessages, agentUiForms.length]);

  function createLocalDraft(input: DraftSessionCreateInput): DraftSession {
    const createdAtMs = now();
    return {
      id: `draft:${createdAtMs}:${++draftSessionSequence.current}`,
      createdAtMs,
      createInput: input,
    };
  }

  async function handleCreateSession(
    workingDirectory?: string,
    projectContext?: ProjectSessionContext,
  ): Promise<SessionSummary | null> {
    setSessionWorkspaceError("");
    const inheritedProjectContext: ProjectSessionContext | undefined = workingDirectory === undefined
      && activeDisplaySession?.projectGroupId
      && !activeDisplaySession.projectCoordinator
      ? {
          projectCoordinator: activeDisplaySession.projectCoordinator,
          projectGroupId: activeDisplaySession.projectGroupId,
        }
      : undefined;
    const resolvedProjectContext = projectContext ?? inheritedProjectContext;
    const resolvedWorkingDirectory = resolvedProjectContext?.projectCoordinator
      ? undefined
      : workingDirectory ?? (activeDisplaySession?.pluginMigration ? undefined : activeDisplaySession?.workingDirectory);
    const createInput: DraftSessionCreateInput = {
      ...(resolvedWorkingDirectory ? { workingDirectory: resolvedWorkingDirectory } : {}),
      ...(resolvedProjectContext?.projectGroupId ? { projectGroupId: resolvedProjectContext.projectGroupId } : {}),
      ...(resolvedProjectContext?.projectCoordinator ? { projectCoordinator: true } : {}),
      ...(resolvedProjectContext?.title ? { title: resolvedProjectContext.title } : {}),
    };
    if (!activeSessionId && composerDraft.trim()) {
      dispatchSessionTabs({
        type: "startup-draft.materialize",
        draft: createLocalDraft({}),
      });
    }
    const draft = createLocalDraft(createInput);
    dispatchDelete({ type: "session-selected", sessionId: draft.id });
    dispatchSessionTabs({ type: "session-draft.open", draft });
    return projectDraftSessionSummary(draft);
  }

  function handleDraftWorkspaceChange(workingDirectory?: string): void {
    if (!draftNewSession) {
      throw new Error("Only a new local session draft can change its workspace.");
    }
    const normalizedWorkingDirectory = workingDirectory?.trim() || undefined;
    if (activeDraft) {
      dispatchSessionTabs({
        type: "session-draft.workspace.changed",
        sessionId: activeDraft.id,
        workingDirectory: normalizedWorkingDirectory,
      });
      return;
    }
    if (!normalizedWorkingDirectory) return;

    const startupDraft = composerDraft;
    const draft = createLocalDraft({ workingDirectory: normalizedWorkingDirectory });
    dispatchSessionTabs({ type: "session-draft.open", draft });
    if (startupDraft) {
      dispatchSessionTabs({ type: "draft.changed", sessionId: draft.id, value: startupDraft });
      dispatchSessionTabs({ type: "draft.changed", sessionId: "", value: "" });
    }
  }

  async function handleInstallPluginMigration(session: SessionSummary): Promise<void> {
    const migration = session.pluginMigration;
    if (!migration || !toolsStore?.installPluginMigration) return;
    setInstallingMigrationJobId(migration.jobId);
    setMigrationInstallError("");
    try {
      const result = await toolsStore.installPluginMigration(migration.jobId);
      const installedMigration = {
        ...migration,
        status: "installed" as const,
        installedPluginName: result.plugin.name,
        installedPluginEnabled: result.plugin.enabled,
        ...(result.cleanupWarning ? { cleanupWarning: result.cleanupWarning } : {}),
      };
      setSessions((current) => current.map((candidate) => (
        candidate.id === session.id ? { ...candidate, pluginMigration: installedMigration } : candidate
      )));
      try {
        await sessionStore.markPluginMigrationInstalled?.(
          session.id,
          result.plugin.name,
          result.plugin.enabled,
          result.cleanupWarning,
        );
      } catch (error) {
        setMigrationInstallError(
          `Plugin ${result.plugin.name} was installed, but the migration status could not be saved: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } catch (error) {
      setMigrationInstallError(error instanceof Error ? error.message : String(error));
    } finally {
      setInstallingMigrationJobId("");
    }
  }

  async function handleDeleteSession(session: SessionSummary) {
    const next = reduceSessionDeleteState(deleteState, { type: "delete-clicked", sessionId: session.id });
    dispatchDelete({ type: "delete-clicked", sessionId: session.id });
    if (next.confirmedSessionId) {
      if (session.id in sessionTabs.draftSessionsById) {
        dispatchSessionTabs({ type: "remove", sessionId: session.id });
        return;
      }
      await sessionStore.delete(session.id);
      optimisticSessionTitlesRef.current.delete(session.id);
      setDissolvingSessionIds((current) => new Set(current).add(session.id));
      const timer = window.setTimeout(() => {
        const remaining = sessionsRef.current.filter((item) => item.id !== session.id);
        sessionsRef.current = remaining;
        setSessions(remaining);
        dispatchSessionTabs({ type: "remove", sessionId: session.id });
        conversationViewBySessionRef.current.delete(session.id);
        submission.forgetSession(session.id);
        setDissolvingSessionIds((current) => {
          const nextIds = new Set(current);
          nextIds.delete(session.id);
          return nextIds;
        });
      }, SESSION_DELETE_DISSOLVE_MS);
      deleteDissolveTimers.current.push(timer);
    }
  }

  async function handleSessionStoreRefresh(preserveSession?: SessionSummary): Promise<SessionSummary[]> {
    const listedSessions = await sessionStore.list();
    let titledSessions = listedSessions.map((session) => {
      if (!isDefaultSessionTitle(session.title)) {
        optimisticSessionTitlesRef.current.delete(session.id);
        return session;
      }
      const optimisticTitle = optimisticSessionTitlesRef.current.get(session.id);
      return optimisticTitle ? { ...session, title: optimisticTitle } : session;
    });
    const listedSessionIdsBeforeReconciliation = new Set(titledSessions.map((session) => session.id));
    const knownSessionIds = new Set(sessionsRef.current.map((session) => session.id));
    const missingOptimisticSessions = sessionsRef.current.filter((session) => (
      optimisticSessionTitlesRef.current.has(session.id) && !listedSessionIdsBeforeReconciliation.has(session.id)
    ));
    const replacementCandidates = titledSessions.filter((session) => !knownSessionIds.has(session.id));
    let sessionIdReplacement: { previousSessionId: string; sessionId: string } | undefined;
    if (missingOptimisticSessions.length === 1 && replacementCandidates.length === 1) {
      const pendingSession = missingOptimisticSessions[0];
      const replacementSession = replacementCandidates[0];
      sessionIdReplacement = {
        previousSessionId: pendingSession.id,
        sessionId: replacementSession.id,
      };
      const optimisticTitle = optimisticSessionTitlesRef.current.get(pendingSession.id);
      optimisticSessionTitlesRef.current.delete(pendingSession.id);
      if (optimisticTitle && isDefaultSessionTitle(replacementSession.title)) {
        optimisticSessionTitlesRef.current.set(replacementSession.id, optimisticTitle);
        titledSessions = titledSessions.map((session) => (
          session.id === replacementSession.id ? { ...session, title: optimisticTitle } : session
        ));
      }
    }
    const listedSessionIds = new Set(titledSessions.map((session) => session.id));
    const pendingOptimisticSessions = sessionsRef.current.filter((session) => (
      optimisticSessionTitlesRef.current.has(session.id) && !listedSessionIds.has(session.id)
    )).map((session) => ({
      ...session,
      title: optimisticSessionTitlesRef.current.get(session.id) ?? session.title,
    }));
    const visibleSessions = [...pendingOptimisticSessions, ...titledSessions];
    const preserveOptimisticTitle = preserveSession && !isDefaultSessionTitle(preserveSession.title);
    const nextSessions = preserveSession && !visibleSessions.some((session) => session.id === preserveSession.id)
      ? [preserveSession, ...visibleSessions]
      : visibleSessions.map((session) => (
        preserveOptimisticTitle && session.id === preserveSession.id && isDefaultSessionTitle(session.title)
          ? { ...session, title: preserveSession.title }
          : session
      ));
    sessionsRef.current = nextSessions;
    setSessions(nextSessions);
    if (sessionIdReplacement) {
      dispatchSessionTabs({ type: "replace", ...sessionIdReplacement });
      moveMapValue(
        conversationViewBySessionRef.current,
        sessionIdReplacement.previousSessionId,
        sessionIdReplacement.sessionId,
      );
      submission.replaceSession(sessionIdReplacement.previousSessionId, sessionIdReplacement.sessionId);
      chatApplication.replaceSession(
        sessionIdReplacement.previousSessionId,
        sessionIdReplacement.sessionId,
      );
    }
    dispatchSessionTabs({
      type: "reconcile",
      availableSessionIds: nextSessions.map((session) => session.id),
    });
    return nextSessions;
  }

  async function handlePinConversation(session: SessionSummary) {
    const pinned = !session.pinned;
    await sessionStore.pin(session.id, pinned);
    setSessions((current) => current.map((item) => item.id === session.id ? { ...item, pinned } : item));
    setHeaderMenuOpen(false);
  }

  async function handleRenameConversation(session: SessionSummary) {
    const nextTitle = window.prompt(t("shell.rename"), session.title)?.trim();
    if (!nextTitle || nextTitle === session.title) {
      setHeaderMenuOpen(false);
      return;
    }
    await sessionStore.rename(session.id, nextTitle);
    optimisticSessionTitlesRef.current.delete(session.id);
    setSessions((current) => current.map((item) => item.id === session.id ? { ...item, title: nextTitle } : item));
    setHeaderMenuOpen(false);
  }

  async function handleCopyId(session: SessionSummary) {
    await writeClipboardText(session.id);
    setHeaderMenuOpen(false);
  }

  async function handleCopyMarkdown(session: SessionSummary) {
    await writeClipboardText(await chatStore.copyMarkdown(session.id));
    setHeaderMenuOpen(false);
  }

  async function handleArchiveConversation(session: SessionSummary) {
    await sessionStore.archive(session.id);
    const remaining = sessions.filter((item) => item.id !== session.id);
    sessionsRef.current = remaining;
    setSessions(remaining);
    dispatchSessionTabs({ type: "remove", sessionId: session.id });
    conversationViewBySessionRef.current.delete(session.id);
    setHeaderMenuOpen(false);
  }

  async function handleBranchFromMessage(session: SessionSummary, messageId: string) {
    const branched = await submission.fork(session.id, messageId);
    const nextSessions = [branched, ...sessionsRef.current.filter((item) => item.id !== branched.id)];
    sessionsRef.current = nextSessions;
    setSessions(nextSessions);
    dispatchSessionTabs({ type: "open", sessionId: branched.id });
  }

  async function handleComposerSend(
    message: string,
    files: ComposerFileReference[],
    pastedContent: PastedContent[],
    options: ComposerSendOptions,
  ) {
    const availableMentionIds = new Set(composerSessionMentionOptions.map((option) => option.id));
    await submission.send({
      availableSessionIds: availableMentionIds,
      files,
      isRunning: activeSession ? sessionResponding : false,
      message,
      options,
      pastedContent,
      selectedSkillIds: composerSelectedSkillIds,
      selectedSessionIds: composerSessionMentionIds,
      sessions: sessionsRef.current.map((session) => ({
        id: session.id,
        title: displaySessionTitle(session.title, t),
        updatedAtMs: session.updatedAtMs,
      })),
      artifactReferences: composerArtifactReferences.map(({ id: _id, ...reference }) => reference),
      spreadsheetAnnotations: composerSpreadsheetAnnotations,
    }, activeSession, chatApplication);
  }

  function handleConversationScroll(): void {
    const element = conversationRef.current;
    if (!element) {
      return;
    }
    const view = captureConversationView(element);
    const nearBottom = view.stickToLatest;
    pendingConversationRestoreRef.current = "";
    stickToLatestRef.current = nearBottom;
    conversationViewBySessionRef.current.set(activeSessionId, view);
    setShowBackToLatest(!nearBottom);
  }

  function handleBackToLatest(): void {
    stickToLatestRef.current = true;
    const element = conversationRef.current;
    conversationViewBySessionRef.current.set(activeSessionId, {
      scrollTop: element ? Math.max(0, element.scrollHeight - element.clientHeight) : 0,
      stickToLatest: true,
    });
    setShowBackToLatest(false);
    conversationEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }

  async function createSessionForDraft(): Promise<SessionSummary | null> {
    if (!draftNewSession) {
      return null;
    }
    if (!draftSessionCreatePromise.current) {
      const draftSession = sessionTabs.draftSessionsById[activeSessionId];
      const modelInput = composerSessionModelInput(composerModels, composerModel);
      const createInput = {
        ...draftSession?.createInput,
        ...modelInput,
      };
      const createArgument = draftSession || Object.keys(createInput).length
        ? createInput
        : undefined;
      const materializingSessionId = activeSessionId;
      setSessionCreatePending(true);
      setSessionWorkspaceError("");
      draftSessionCreatePromise.current = sessionStore.create(createArgument)
        .then((created) => {
          activateCreatedSession(created, materializingSessionId);
          return created;
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          setSessionWorkspaceError(message);
          console.error("[session-workspaces] session.create.failed", {
            error: message,
            workingDirectory: draftSession?.createInput.workingDirectory ?? "",
            projectGroupId: draftSession?.createInput.projectGroupId ?? "",
          });
          return Promise.reject(error);
        })
        .finally(() => {
          draftSessionCreatePromise.current = null;
          setSessionCreatePending(false);
        });
    }
    return draftSessionCreatePromise.current;
  }

  function activateCreatedSession(created: SessionSummary, previousSessionId = ""): void {
    sessionsRef.current = [created, ...sessionsRef.current.filter((session) => session.id !== created.id)];
    setSessions((current) => [created, ...current.filter((session) => session.id !== created.id)]);
    dispatchSessionTabs(previousSessionId !== created.id
      ? { type: "replace", previousSessionId, sessionId: created.id }
      : { type: "open", sessionId: created.id });
  }

  async function handleStopGeneration(session: SessionSummary) {
    await chatApplication.cancel(session.id);
  }

  function handleChatSessionRuntimeEffect(effect: ChatSessionRuntimeEffect): void {
    if (effect.type === "timeline_applied") {
      updateSessionStatusFromTimeline(effect.sessionId, effect.timeline);
      submission.receiveTimeline(effect.sessionId, effect.timeline);
      return;
    }
    if (effect.type === "message_received") {
      submission.receiveMessage(effect.sessionId, effect.message);
      return;
    }
    if (effect.type === "session_refresh_requested") {
      void chatApplication.receiveSessionEvent(effect.sessionId, effect.event);
      return;
    }

    chatApplication.receiveCommand(effect.sessionId, effect.event);
  }

  function updateSessionStatusFromTimeline(sessionId: string, nextTimeline: ChatTimelineSnapshot) {
    const status = projectTimelineSessionStatus(nextTimeline);
    if (!status) return;
    setSessions((current) => {
      const next = current.map((session) => (
        session.id === sessionId ? { ...session, status } : session
      ));
      sessionsRef.current = next;
      return next;
    });
  }

  async function handleOpenSubagent(delegate: DelegatedAgentState) {
    if (!activeSession) {
      return;
    }
    openDrawer({ kind: "subagent", title: delegate.title, delegate, loading: Boolean(chatStore.loadDelegateTrace) });
    if (!chatStore.loadDelegateTrace) {
      return;
    }
    try {
      const payload = await chatStore.loadDelegateTrace({
        sessionKey: activeSession.id,
        delegateId: delegate.id,
        ...(delegate.traceRef ? { traceRef: delegate.traceRef } : {}),
      });
      const loaded = applyLoadedDelegatedAgentTrace(delegate, payload);
      setDrawer((current) => current?.kind === "subagent" && current.delegate.id === delegate.id
        ? { ...current, delegate: loaded, loading: false }
        : current);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setDrawer((current) => current?.kind === "subagent" && current.delegate.id === delegate.id
        ? { ...current, error: message, loading: false }
        : current);
    }
  }

  function handleOpenArtifact(artifact: ArtifactRef) { return sidecarResources.current?.openArtifact(artifact); }
  function handleOpenAssistantFileLink(link: AssistantFileLink) { return sidecarResources.current?.openFileLink(link); }

  async function handleSubmitAgentUiForm(form: AgentUiForm, values: Record<string, unknown>) {
    await chatApplication.submitForm(activePersistedSessionId, form, values);
  }

  async function handleCancelAgentUiForm(form: AgentUiForm) {
    await chatApplication.submitForm(activePersistedSessionId, form);
  }

  function handleSessionSidebarCollapsedChange(collapsed: boolean) {
    if (sessionSidebarCollapsed === undefined) {
      setLocalSessionSidebarCollapsed(collapsed);
    }
    onSessionSidebarCollapsedChange?.(collapsed);
  }

  function handleSelectSession(session: SessionSummary) {
    dispatchDelete({ type: "session-selected", sessionId: session.id });
    dispatchSessionTabs({ type: "open", sessionId: session.id });
  }

  function handleActivateSessionTab(sessionId: string) {
    dispatchDelete({ type: "session-selected", sessionId });
    dispatchSessionTabs({ type: "activate", sessionId });
  }

  function handleCloseSessionTab(sessionId: string) {
    dispatchSessionTabs({ type: "close", sessionId });
    if (sessionId === activeSessionId) {
      setHeaderMenuOpen(false);
    }
  }

  function openDrawer(next: NonNullable<DrawerState>) {
    if (!drawerElementRef.current?.contains(document.activeElement)) {
      drawerTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
    setDrawerSessionId(activeSessionId);
    setDrawer(next);
  }

  function closeDrawer() {
    if (drawerElementRef.current?.contains(document.activeElement)) {
      if (drawerTriggerRef.current?.isConnected) drawerTriggerRef.current.focus();
      else setComposerFocusRequestId((current) => current + 1);
    }
    setDrawer(null);
  }

  function handleComposerDraftChange(value: string) {
    dispatchSessionTabs({ type: "draft.changed", sessionId: activeSessionId, value });
  }

  function handleSpreadsheetAskForChange(
    artifact: ArtifactRef,
    request: SpreadsheetCellChangeRequest,
    revision?: string,
  ): void {
    const id = `spreadsheet:${artifact.id}:${request.sheet}:${request.address}`;
    const annotation: SpreadsheetComposerAnnotation = {
      filePath: artifact.fetchPath || artifact.title,
      fileTitle: artifact.title,
      revision,
      id,
      request: {
        ...request,
        value: boundedSpreadsheetSelectionValue(request.value),
      },
    };
    setComposerSpreadsheetAnnotations((current) => [
      ...current.filter((candidate) => candidate.id !== id),
      annotation,
    ]);
    setComposerFocusRequestId((current) => current + 1);
    logRendererEvent("info", "artifact.office.selection.composer_requested", {
      address: request.address,
      artifactKind: artifact.kind,
      sheet: request.sheet,
    });
  }

  function handleChatPageKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key !== "Escape" || event.defaultPrevented || !sessionResponding || !canCancelTurn || !activeSession) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('[role="dialog"], [role="menu"], [role="listbox"]')) return;
    event.preventDefault();
    void handleStopGeneration(activeSession);
  }

  const visibleAgentUiForms = agentUiForms.filter(isVisibleAgentUiForm);
  const interactiveFormIds = new Set(visibleAgentUiForms.map((form) => form.form_id));
  const headerTitle = activeDisplaySession
    ? displaySessionTitle(activeDisplaySession.title, t)
    : draftNewSession ? t("shell.newChat") : t("shell.noSelection");
  const mascotMood = projectTinybotMascotMood({
    responding: sessionResponding,
    sessionStatus: activeSession?.status,
    turnStatus: latestTurnStatus,
  });
  useEffect(() => {
    onMascotMoodChange?.(mascotMood);
  }, [mascotMood, onMascotMoodChange]);
  return (
    <section
      className="react-chat-page"
      aria-label={t("shell.label")}
      data-session-sidebar-collapsed={resolvedSessionSidebarCollapsed}
      onKeyDown={handleChatPageKeyDown}
    >
      <ChatSessionWorkspace
        actions={{
          onCancelDeleteConfirmation: (sessionId) => dispatchDelete({ type: "row-left", sessionId }),
          onCollapsedChange: handleSessionSidebarCollapsedChange,
          onCreateSession: handleCreateSession,
          onDeleteSession: handleDeleteSession,
          onSelectSession: handleSelectSession,
        }}
        activeSessionId={activeSessionId}
        collapsed={resolvedSessionSidebarCollapsed}
        confirmingDeleteSessionId={deleteState.confirmingSessionId}
        createPending={sessionCreatePending}
        dissolvingSessionIds={dissolvingSessionIds}
        error={sessionWorkspaceError}
        now={now}
        projectGroupStore={projectGroupStore}
        sessions={displayedSessions}
        workspaceRegistryStore={workspaceRegistryStore}
      >
      {({ availableWorkspaces, chooseWorkspace, workspaceError, workspacePickerPending }) => (
      <div
        className="react-chat-workspace"
        data-sidecar-presentation={sidecar.presentation}
        data-sidecar-layout-motion={sidecar.layoutMotion}
        style={{ "--react-sidecar-width": `${sidecar.width}px` } as CSSProperties}
      >
      <main className="react-chat-surface" data-empty-session={emptyActiveSession ? "true" : undefined}>
        <header className="react-chat-header">
          <h1 className="react-chat-header__title">{headerTitle}</h1>
          <SessionTabStrip
            activeSessionId={activeSessionId}
            tabs={openSessionTabs}
            onActivate={handleActivateSessionTab}
            onClose={handleCloseSessionTab}
          />
          <div className="react-chat-header__actions">
            <button
              aria-label={sidecar.presentation === "closed" ? t("sidecar.show") : t("sidecar.hide")}
              aria-pressed={sidecar.presentation !== "closed"}
              ref={sidecarToggleRef}
              title={sidecar.presentation === "closed" ? t("sidecar.show") : t("sidecar.hide")}
              type="button"
              onClick={() => sidecarResources.current?.toggle()}
            >
              {sidecar.presentation === "closed"
                ? <PanelRightOpen aria-hidden="true" size={17} />
                : <PanelRightClose aria-hidden="true" size={17} />}
            </button>
            <button
              aria-label={t("shell.conversationMenu")}
              title={t("shell.conversationMenu")}
              type="button"
              onClick={() => setHeaderMenuOpen((open) => !open)}
            >
              <MoreHorizontal aria-hidden="true" size={18} />
            </button>
            {headerMenuOpen ? (
              <div className="react-menu react-popover-surface" role="menu">
                <button aria-label={activeSession?.pinned ? t("shell.unpin") : t("shell.pin")} className="react-popover-item" role="menuitem" type="button" onClick={() => activeSession && void handlePinConversation(activeSession)}>
                  {activeSession?.pinned ? t("shell.unpin") : t("shell.pin")}
                </button>
                <button aria-label={t("shell.rename")} className="react-popover-item" role="menuitem" type="button" onClick={() => activeSession && void handleRenameConversation(activeSession)}>{t("shell.rename")}</button>
                <button aria-label={t("shell.copyId")} className="react-popover-item" role="menuitem" type="button" onClick={() => activeSession && void handleCopyId(activeSession)}>{t("shell.copyId")}</button>
                <button aria-label={t("shell.copyMarkdown")} className="react-popover-item" role="menuitem" type="button" onClick={() => activeSession && void handleCopyMarkdown(activeSession)}>{t("shell.copyMarkdown")}</button>
                <button aria-label={t("shell.archive")} className="react-popover-item" role="menuitem" type="button" onClick={() => activeSession && void handleArchiveConversation(activeSession)}>{t("shell.archive")}</button>
                <button className="react-popover-item" disabled role="menuitem" type="button">{t("shell.sideChat")}</button>
                <button className="react-popover-item" disabled role="menuitem" type="button">{t("shell.branch")} <ChevronDown aria-hidden="true" size={14} /></button>
                <button className="react-popover-item" disabled role="menuitem" type="button">{t("shell.newWindow")}</button>
              </div>
            ) : null}
          </div>
        </header>

        {floatingPlan ? (
          <FloatingPlanStatus
            identityKey={floatingPlan.identityKey}
            plan={floatingPlan.plan}
            revisionKey={floatingPlan.revisionKey}
          />
        ) : null}

        <div
          ref={conversationRef}
          aria-label={t("shell.conversation")}
          aria-live="polite"
          className="react-conversation-view"
          id="tinybot-chat-conversation"
          role="tabpanel"
          onScroll={handleConversationScroll}
        >
          <ChatTimeline
            actions={{
              onBranch: (messageId) => activeSession && void handleBranchFromMessage(activeSession, messageId),
              onOpenArtifact: (artifact) => void handleOpenArtifact(artifact),
              onOpenFileLink: (link) => void handleOpenAssistantFileLink(link),
              onOpenSubagent: (delegate) => void handleOpenSubagent(delegate),
              onOpenTool: (toolCall) => openDrawer({ kind: "tool", title: toolCall.name, toolCall }),
            }}
            error={timelineError}
            hookResults={hookResults}
            interactiveFormIds={interactiveFormIds}
            latestFailedTurnId={latestFailedTurnId}
            optimisticMessages={optimisticMessages}
            sessionRunning={sessionRunning}
            turns={activeSession ? timeline?.turns ?? [] : []}
          />
          {activeSession && timeline?.turns.length ? null : emptyActiveSession ? (
            <EmptyChatStart
              availableWorkspaces={availableWorkspaces}
              selectedWorkspacePath={activeDraft?.createInput.workingDirectory}
              workspaceError={workspaceError}
              workspacePickerPending={workspacePickerPending}
              workspaceSelectionEnabled={Boolean(
                draftNewSession
                && !activeDraft?.createInput.projectCoordinator
                && !activeDraft?.createInput.projectGroupId
              )}
              onAddWorkspace={chooseWorkspace}
              onSelectWorkspace={handleDraftWorkspaceChange}
            />
          ) : activeSession ? null : <EmptyStateText text={t("shell.selectSession")} />}
          {showPluginMigrationResult && activeSession?.pluginMigration ? (
            <section
              aria-label={t("migration.label")}
              className="react-plugin-migration-result"
              data-status={activeSession.pluginMigration.status}
            >
              <span aria-hidden="true" className="react-plugin-migration-result__icon">
                {activeSession.pluginMigration.status === "installed"
                  ? <Check size={16} />
                  : installingMigrationJobId === activeSession.pluginMigration.jobId
                    ? <Loader2 className="react-spin" size={16} />
                    : <FolderOpen size={16} />}
              </span>
              <span className="react-plugin-migration-result__copy">
                <strong>{activeSession.pluginMigration.status === "installed"
                  ? t("migration.installed", {
                      name: activeSession.pluginMigration.installedPluginName || "Plugin",
                      state: activeSession.pluginMigration.installedPluginEnabled === false ? t("migration.keptDisabled") : t("migration.enabled"),
                    })
                  : t("migration.complete")}</strong>
                <small>{activeSession.pluginMigration.status === "installed"
                  ? activeSession.pluginMigration.cleanupWarning || t("migration.cleaned")
                  : t("migration.validate")}</small>
                {migrationInstallError ? <small className="react-plugin-migration-result__error" role="alert">{migrationInstallError}</small> : null}
              </span>
              {activeSession.pluginMigration.status === "pending" ? (
                <button
                  disabled={Boolean(installingMigrationJobId) || !toolsStore?.installPluginMigration}
                  type="button"
                  onClick={() => void handleInstallPluginMigration(activeSession)}
                >
                  {installingMigrationJobId === activeSession.pluginMigration.jobId ? t("migration.installing") : t("migration.install")}
                </button>
              ) : null}
            </section>
          ) : null}
          {visibleAgentUiForms.length ? (
            <div className="react-agent-ui-forms" aria-label={t("turn.agentForms")}>
              {visibleAgentUiForms.map((form) => (
                <AgentUiFormCard
                  form={form}
                  key={form.form_id}
                  submitting={submittingFormId === form.form_id}
                  onCancel={() => void handleCancelAgentUiForm(form)}
                  onSubmit={(values) => void handleSubmitAgentUiForm(form, values)}
                />
              ))}
            </div>
          ) : null}
          <div ref={conversationEndRef} aria-hidden="true" />
        </div>

        {showBackToLatest ? (
          <button className="react-back-to-latest" type="button" onClick={handleBackToLatest}>{t("shell.backToLatest")}</button>
        ) : null}

        <ChatQueueNotice application={chatApplication} sessionId={activePersistedSessionId} />
        {compactingActiveSession ? (
          <p aria-live="polite" className="react-context-compaction-status" role="status">
            <Loader2 aria-hidden="true" />
            <span>{t("shell.compacting")}</span>
          </p>
        ) : null}
        {showCommandLifecycleStatus ? (
          <p
            aria-live="polite"
            className="react-agent-command-status"
            data-stage={commandLifecycle.stage}
            role={commandLifecycle.stage === "rejected" || commandLifecycle.stage === "timed_out" ? "alert" : "status"}
          >
            {threadCommandLifecycleLabel(commandLifecycle, t)}
          </p>
        ) : null}
        <div className="react-composer-drop-target">
          <ChatQueuedInputs application={chatApplication} sessionId={activePersistedSessionId} />
          <ClaudeStyleAiInput
            className={["react-composer", emptyActiveSession ? "react-composer--raised" : ""].filter(Boolean).join(" ")}
            contextReferences={composerArtifactContextReferences}
            focusRequestId={composerFocusRequestId}
            disabled={sessionsLoaded && !activeSession && !draftNewSession}
            disabledReason={sessionsLoaded && !activeSession && !draftNewSession ? t("shell.createOrSelect") : undefined}
            sendDisabled={!sessionsLoaded}
          sendDisabledReason={!sessionsLoaded ? t("shell.loadingSessions") : undefined}
          defaultModel={composerModel}
          defaultReasoningEffort={composerReasoningEffort}
          contextUsage={activeContextUsage}
          models={composerModels}
          onModelChange={(modelId) => {
            const selected = composerModels.find((model) => model.id === modelId);
            if (!selected) return;
            const selectedModelId = selected.modelId || selected.id;
            setComposerModel(modelId);
            if (emptyActiveSession) {
              const persistence = submission.saveDefaultModel(selectedModelId, selected.providerId);
              void persistence.catch((error) => {
                reportTimelineError(t("errors.modelSaveFailed", {
                  message: error instanceof Error ? error.message : String(error),
                }));
              });
            }
            if (activeSession) {
              setSessions((current) => current.map((session) => (
                session.id === activeSession.id
                  ? {
                      ...session,
                      model: selectedModelId,
                      modelProvider: selected.providerId,
                    }
                  : session
              )));
              const setModel = selected.providerId
                ? sessionStore.setModel?.(activeSession.id, selectedModelId, selected.providerId)
                : sessionStore.setModel?.(activeSession.id, selectedModelId);
              void setModel?.catch((error) => {
                reportTimelineError(t("errors.modelSaveFailed", { message: error instanceof Error ? error.message : String(error) }));
              });
            }
          }}
          onReasoningEffortChange={(effort) => {
            setComposerReasoningEffort(effort);
            writeCurrentChatReasoningEffort(effort);
          }}
          onAddSessionMention={(id) => setComposerSessionMentionIds((current) => (
            current.includes(id) || current.length >= MAX_COMPOSER_SESSION_REFERENCES ? current : [...current, id]
          ))}
          onAddSkill={(id) => setComposerSelectedSkillIds((current) => (
            current.includes(id) ? current : [...current, id]
          ))}
          onClearSessionMentions={() => setComposerSessionMentionIds([])}
          onClearContextReferences={() => { setComposerSpreadsheetAnnotations([]); setComposerArtifactReferences([]); }}
          onClearSkills={() => setComposerSelectedSkillIds([])}
          onRemoveContextReference={(id) => {
            setComposerSpreadsheetAnnotations((current) => current.filter((annotation) => annotation.id !== id));
            setComposerArtifactReferences((current) => current.filter((reference) => reference.id !== id));
          }}
          onRemoveSessionMention={(id) => setComposerSessionMentionIds((current) => current.filter((sessionId) => sessionId !== id))}
          onRemoveSkill={(id) => setComposerSelectedSkillIds((current) => current.filter((skillId) => skillId !== id))}
          responding={sessionResponding}
          selectedSessionMentionIds={composerSessionMentionIds}
          selectedSkillIds={composerSelectedSkillIds}
          sessionMentionOptions={composerSessionMentionOptions}
          skillOptions={composerSkillOptions}
          slashCommands={slashCommands}
          tools={composerToolOptions}
          canStopResponding={canCancelTurn}
          stopUnavailableReason={cancelUnavailableReason}
          placeholder={emptyActiveSession ? t("shell.taskPlaceholder") : t("shell.messagePlaceholder")}
          value={composerDraft}
          onSelectFiles={pickDesktopChatFiles}
          onValueChange={handleComposerDraftChange}
          onSendMessage={(message, files, pastedContent, options) => handleComposerSend(message, files, pastedContent, options)}
          onStopResponding={() => activeSession && handleStopGeneration(activeSession)}
          />
        </div>
      </main>

      <SidecarResources
        ref={sidecarResources}
        activeSession={activeSession}
        activeDisplaySession={activeDisplaySession}
        activeSessionId={activeSessionId}
        chatStore={chatStore}
        workspaceStore={workspaceStore}
        artifactReviewEpoch={artifactReviewEpoch}
        sessionResponding={sessionResponding}
        presentDrawer={Boolean(presentDrawer)}
        onLayoutChange={setSidecar}
        onHide={() => sidecarToggleRef.current?.focus()}
        onReference={(reference) => {
          setComposerArtifactReferences((current) => [...current.filter((item) => item.id !== reference.id), reference]);
          setComposerFocusRequestId((current) => current + 1);
        }}
        onAskForSpreadsheetChange={handleSpreadsheetAskForChange}
        onHandoff={async (sessionId) => {
          await submission.submitTurn(sessionId, { text: t("browserHandoffContinue") }, "browser-handoff-complete");
          await handleSessionStoreRefresh(activeSession);
        }}
        onError={reportTimelineError}
      />

      {presentDrawer ? (
        <aside
          ref={drawerElementRef}
          className="react-right-drawer"
          aria-label={t("shell.detailsDrawer")}
          aria-hidden={!currentDrawer || undefined}
          inert={!currentDrawer || undefined}
          data-motion="fade-content"
          data-state={currentDrawer ? "open" : "closing"}
        >
          <div className="react-right-drawer__header">
            <h2>{presentDrawer.title}</h2>
            <button aria-label={t("shell.closeDetails")} type="button" onClick={closeDrawer}>
              <X aria-hidden="true" size={16} />
            </button>
          </div>
          <div className="react-right-drawer__content">
            {presentDrawer.kind === "tool" ? (
              <ToolCallDetails toolCall={presentDrawer.toolCall} />
            ) : (
              <SubagentDetails delegate={presentDrawer.delegate} error={presentDrawer.error} loading={presentDrawer.loading} />
            )}
          </div>
        </aside>
      ) : null}
      </div>
      )}
      </ChatSessionWorkspace>
    </section>
  );
}


function EmptyStateText({ text }: { text: string }) {
  return <p className="react-empty-state">{text}</p>;
}

function threadCommandLifecycleLabel(lifecycle: ThreadCommandLifecycle, t: TFunction<"chat">): string {
  const commandKind = lifecycle.stage === "idle" ? "agent.cancel" : lifecycle.command.kind;
  const operation = ({
    "agent.cancel": t("lifecycle.operation.cancel"),
    "form.cancel": t("lifecycle.operation.formCancellation"),
    "form.submit": t("lifecycle.operation.formSubmission"),
    "operation.retry": t("lifecycle.operation.retry"),
  } satisfies Record<ThreadCommand["kind"], string>)[commandKind];
  const completionOperation = commandKind === "agent.cancel" ? t("lifecycle.operation.cancellation") : operation;
  switch (lifecycle.stage) {
    case "idle":
      return "";
    case "sending":
      return t("lifecycle.sending", { operation: operation.toLocaleLowerCase() });
    case "waiting_for_canonical":
      return t("lifecycle.waiting", { operation });
    case "acknowledged":
      return t("lifecycle.acknowledged", { itemId: lifecycle.acknowledgement.itemId, operation });
    case "completed":
      return t("lifecycle.completed", { itemId: lifecycle.completion.itemId, operation: completionOperation, status: lifecycle.completion.status });
    case "rejected":
    case "timed_out":
      return lifecycle.error;
  }
}

function isVisibleAgentUiForm(form: AgentUiForm): boolean {
  return form.status !== "submitted" && form.status !== "cancelled" && form.status !== "expired";
}

async function writeClipboardText(value: string): Promise<void> {
  await navigator.clipboard?.writeText(value);
}

function moveMapValue<T>(
  map: Map<string, T>,
  previousSessionId: string,
  sessionId: string,
): void {
  if (!map.has(previousSessionId) || previousSessionId === sessionId) {
    return;
  }
  const value = map.get(previousSessionId) as T;
  map.delete(previousSessionId);
  map.set(sessionId, value);
}

function toComposerModelOption(model: ChatModelOption, t: TFunction<"chat">): ModelOption {
  return {
    id: model.providerId
      ? `provider:${encodeURIComponent(model.providerId)}|model:${encodeURIComponent(model.id)}`
      : model.id,
    modelId: model.id,
    ...(model.providerId ? { providerId: model.providerId } : {}),
    name: model.label || model.id,
    description: model.description || model.providerLabel || t("composer.configuredModel"),
    supportsImageInput: model.supportsImageInput,
    ...(model.supportsImageInput ? { badge: t("composer.imageInput") } : {}),
  };
}

function ToolCallDetails({ toolCall }: { toolCall: ToolCallSummary }) {
  const { t } = useTranslation("chat");
  const sections = toolCallDetailSections(toolCall, t);
  if (!sections.length) {
    return <p>{t("details.unavailable")}</p>;
  }
  return (
    <div className="react-tool-detail">
      {sections.map((section) => (
        <section key={section.label}>
          <h3>{section.label}</h3>
          <pre>{section.value}</pre>
        </section>
      ))}
    </div>
  );
}

function SubagentDetails({
  delegate,
  error,
  loading,
}: {
  delegate: DelegatedAgentState;
  error?: string;
  loading: boolean;
}) {
  const { t } = useTranslation("chat");
  return (
    <div className="react-subagent-detail">
      <dl>
        <div><dt>{t("details.id")}</dt><dd>{delegate.id}</dd></div>
        <div><dt>{t("details.status")}</dt><dd>{delegate.status}</dd></div>
        {delegate.traceRef ? <div><dt>{t("details.trace")}</dt><dd>{delegate.traceRef}</dd></div> : null}
        {delegate.childTurnId ? <div><dt>{t("details.childTurn")}</dt><dd>{delegate.childTurnId}</dd></div> : null}
      </dl>
      {delegate.task ? <p>{delegate.task}</p> : null}
      {delegate.latestActivity ? <p>{delegate.latestActivity}</p> : null}
      {loading ? <p aria-live="polite">{t("details.loadingTrace")}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {delegate.trace?.steps.length ? (
        <ol aria-label={t("details.subagentTrace")}>
          {delegate.trace.steps.map((step) => (
            <li data-status={step.status} key={step.id}>
              <strong>{step.title}</strong>
              {step.summary ? <p>{step.summary}</p> : null}
            </li>
          ))}
        </ol>
      ) : null}
      {delegate.finalOutput ? <section><h3>{t("details.finalOutput")}</h3><p>{delegate.finalOutput}</p></section> : null}
    </div>
  );
}

function toolCallDetailSections(toolCall: ToolCallSummary, t: TFunction<"chat">): Array<{ label: string; value: string }> {
  return [
    { label: t("details.status"), value: toolCall.status },
    { label: t("details.summary"), value: toolCall.summary ?? "" },
    { label: t("details.arguments"), value: toolCall.argsText ?? "" },
    { label: t("details.response"), value: toolCall.responseText ?? "" },
    { label: t("details.delegate"), value: formatDetailLines([
      [t("details.title"), toolCall.delegateTitle],
      [t("details.type"), toolCall.delegateType],
      [t("details.task"), toolCall.delegateTask],
      [t("details.id"), toolCall.delegateId],
    ]) },
    { label: t("details.trace"), value: formatDetailLines([
      [t("details.trace"), toolCall.traceRef],
      [t("details.childTurn"), toolCall.childTurnId],
      [t("details.parentTurn"), toolCall.parentTurnId],
      [t("details.session"), toolCall.sessionKey],
    ]) },
    { label: t("details.finalOutput"), value: toolCall.finalOutput ?? "" },
  ].filter((section) => section.value.trim());
}

function formatDetailLines(rows: Array<[string, string | undefined]>): string {
  return rows
    .filter(([, value]) => Boolean(value?.trim()))
    .map(([label, value]) => `${label}: ${value}`)
    .join("\n");
}

function projectDraftSessionSummary(draft: DraftSession): SessionSummary {
  return {
    id: draft.id,
    projectCoordinator: draft.createInput.projectCoordinator,
    projectGroupId: draft.createInput.projectGroupId,
    status: "idle",
    title: draft.createInput.title ?? "New chat",
    updatedAtMs: draft.createdAtMs,
    workingDirectory: draft.createInput.workingDirectory,
  };
}

function boundedSpreadsheetSelectionValue(value: string): string {
  return value.length > 12000 ? `${value.slice(0, 12000)}\n[Selection excerpt truncated; read the referenced range for all values.]` : value;
}

