import { useEffect, useEffectEvent, useId, useMemo, useReducer, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
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
import {
  MAX_QUEUED_INPUTS,
  deleteQueuedInput,
  dispatchNextQueuedInput,
  pauseQueuedInputs,
  resumeNextQueuedInput,
  updateInterruptStatus,
} from "../../app-core/chat/chatInputState";
import type { QueuedInput } from "../../app-core/chat/chatUiProjection";
import {
  ClaudeStyleAiInput,
  type ComposerFileReference,
  type ComposerContextReference,
  type ComposerSendOptions,
  type ComposerSessionMentionOption,
  type ComposerSlashCommand,
  type ModelOption,
  type PastedContent,
} from "../../components/ui/claude-style-ai-input";
import { formatRelativeUpdatedTime } from "../lib/relativeTime";
import type { ChatEvent, ChatInput, ChatModelOption, ChatStore, ProjectGroupStore, SessionStore, SessionSummary, SettingsStore, ToolsStore, WorkspaceStore } from "../services";
import { createDesktopCompactCommand, createDesktopTurnSubmitCommand } from "../../app-core/chat/desktopCommand";
import {
  clearCurrentChatModel,
  readCurrentChatModelPreference,
  writeCurrentChatModel,
} from "../../app-core/chat/chatModelPreference";
import {
  readCurrentChatReasoningEffort,
  writeCurrentChatReasoningEffort,
} from "../../app-core/chat/reasoningEffort";
import { pickDesktopChatFiles } from "../../app-core/native/desktopNativeFilePicker";
import { reduceSessionDeleteState } from "../sessions/sessionDeleteState";
import type { ReactChatMessage, ToolCallSummary } from "./messageActions";
import type { AgentUiForm } from "../../app-core/agent-ui/agentUiEvents";
import { AgentUiFormCard } from "./AgentUiFormCard";
import { DataViewCard } from "./DataViewCard";
import {
  canDispatchQueuedInput,
  projectChatEventEffects,
  projectTimelineSessionStatus,
} from "./chatEventPolicy";
import {
  projectLatestContextUsage,
  type ContextUsageDefaults,
} from "./chatContextUsage";
import { LiveCanvas } from "./LiveCanvas";
import {
  clampTinyOsWidth,
  INITIAL_LIVE_CANVAS_STATE,
  reduceLiveCanvasState,
  type LiveCanvasEntry,
} from "./liveCanvasModel";
import { SessionTabStrip, type SessionTabItem } from "./SessionTabStrip";
import {
  INITIAL_SESSION_TAB_WORKSPACE,
  readPersistedSessionTabWorkspace,
  reduceSessionTabWorkspace,
  sessionTabDraft,
  writePersistedSessionTabWorkspace,
} from "./sessionTabWorkspace";
import {
  groupSessionsByWorkspace,
} from "./sessionWorkspaces";
import {
  applyLoadedDelegatedAgentTrace,
  projectLoadedArtifactDetail,
} from "../../app-core/chat/chatProjection";
import type {
  ArtifactRef,
  BackendAgentTurnItem,
  ChatStep,
  ChatTurn,
  DelegatedAgentState,
  LoadedArtifactDetail,
} from "../../app-core/chat/chatTurnContracts";
import type { ChatTimelineSnapshot } from "../../app-core/chat/agentTimelineModel";
import type { TinyOsAgentRequestIntent, TinyOsAgentRequestReference, TinyOsContextReference } from "../../app-core/chat/tinyOsUiState";
import { readTinyOsReferenceTransfer, tinyOsReferenceAcceptedBy, TINYOS_REFERENCE_MIME } from "../../app-core/chat/tinyOsReferenceTransfer";
import { useTinyOsFilesController } from "./useTinyOsFilesController";
import {
  TINYOS_COMMAND_ACK_TIMEOUT_MS,
  canonicalTinyOsCommandAcknowledgement,
  canonicalTinyOsCommandCompletion,
  createTinyOsAgentCancelCommand,
  createTinyOsAgentRequestChangeCommand,
  createTinyOsAgentTurnControlCommand,
  createTinyOsBrowserInteractCommand,
  createTinyOsFileDeleteCommand,
  createTinyOsFileMoveCommand,
  createTinyOsFileSaveCommand,
  createTinyOsFormCancelCommand,
  createTinyOsFormSubmitCommand,
  createTinyOsOperationRetryCommand,
  createTinyOsTerminalCancelCommand,
  createTinyOsTerminalExecuteCommand,
  isTinyOsCommandInFlight,
  reduceTinyOsCommandLifecycle,
  type TinyOsCommandLifecycle,
  type TinyOsCommand,
  type TinyOsBrowserAction,
} from "../../app-core/chat/tinyOsCommand";
import {
  unavailableTinyOsEffectiveCapabilities,
  type TinyOsEffectiveCapabilities,
} from "../../app-core/chat/tinyOsCapabilities";
import {
  useChatSessionRuntime,
  type ChatSessionRuntimeEffect,
} from "./useChatSessionRuntime";
import {
  MAX_COMPOSER_SESSION_REFERENCES,
  nativeReferenceFromTinyOs,
  prepareChatSubmission,
  tinyOsReferenceLabel,
  type QueuedComposerInput,
} from "./chatSubmission";
import {
  ChatErrorDetails,
  ChatTimeline,
  type RecoveryAction,
} from "./ChatTimeline";
import {
  ChatSessionWorkspace,
  type ProjectSessionContext,
} from "./ChatSessionWorkspace";
import {
  deriveSessionTitle,
  displaySessionTitle,
  isDefaultSessionTitle,
} from "./sessionTitle";

export type ChatPageProps = {
  chatStore: ChatStore;
  sessionStore: SessionStore;
  projectGroupStore?: ProjectGroupStore;
  settingsStore?: SettingsStore;
  toolsStore?: Pick<ToolsStore, "installPluginMigration">;
  workspaceStore?: Pick<WorkspaceStore, "listDirectory" | "readFile">;
  createSessionSignal?: number;
  sessionSidebarCollapsed?: boolean;
  onSessionSidebarCollapsedChange?: (collapsed: boolean) => void;
  onStopGenerationTargetChange?: (sessionId: string) => void;
  onOpenFiles?: () => void;
  onOpenSettings?: () => void;
  now?: () => number;
};

type DrawerState =
  | { kind: "tool"; title: string; toolCall: ToolCallSummary }
  | { kind: "subagent"; title: string; delegate: DelegatedAgentState; loading: boolean; error?: string }
  | { kind: "artifact"; title: string; artifact: ArtifactRef; detail?: LoadedArtifactDetail; loading: boolean; error?: string }
  | { kind: "error"; title: string; step: ChatStep; turn: ChatTurn }
  | null;

type ConversationViewState = {
  scrollTop: number;
  stickToLatest: boolean;
};

function lastCanonicalEventIndex(
  items: readonly BackendAgentTurnItem[],
  turnId: string,
  itemId: string,
): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.turnId === turnId && item.itemId === itemId) return index;
  }
  return -1;
}

function readStoredTinyOsWidth(): number {
  if (typeof window === "undefined") return 480;
  const stored = Number(window.localStorage.getItem(TINYOS_WIDTH_STORAGE_KEY));
  return Number.isFinite(stored) && stored > 0 ? clampTinyOsWidth(stored) : 480;
}

function resolveComposerModel(
  models: readonly ModelOption[],
  sessionModel = "",
  sessionProvider = "",
): string {
  const sessionOption = findComposerModel(models, sessionModel, sessionProvider);
  if (sessionOption) {
    return sessionOption.id;
  }
  const stored = readCurrentChatModelPreference();
  const storedOption = findComposerModel(models, stored?.modelId ?? "", stored?.providerId ?? "");
  if (storedOption) {
    return storedOption.id;
  }
  if (stored) {
    clearCurrentChatModel();
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
  return [
    { command: "/compact", description: t("commands.compact.description"), label: t("commands.compact.label"), prompt: "/compact", submitOnSelect: true },
    { command: "/plan", description: t("commands.plan.description"), label: t("commands.plan.label"), prompt: t("commands.plan.prompt") },
    { command: "/review", description: t("commands.review.description"), label: t("commands.review.label"), prompt: t("commands.review.prompt") },
    { command: "/fix", description: t("commands.fix.description"), label: t("commands.fix.label"), prompt: t("commands.fix.prompt") },
    { command: "/test", description: t("commands.test.description"), label: t("commands.test.label"), prompt: t("commands.test.prompt") },
    { command: "/explain", description: t("commands.explain.description"), label: t("commands.explain.label"), prompt: t("commands.explain.prompt") },
  ];
}

const LIVE_CANVAS_CLOSE_MS = 160;
const SESSION_DELETE_DISSOLVE_MS = 180;
const TINYOS_WIDTH_STORAGE_KEY = "tinybot.ui.tinyos.width";
const EMPTY_OPTIMISTIC_MESSAGES: ReactChatMessage[] = [];

export function ChatPage({
  chatStore,
  createSessionSignal = 0,
  now = Date.now,
  onOpenFiles,
  onOpenSettings,
  onSessionSidebarCollapsedChange,
  onStopGenerationTargetChange,
  sessionSidebarCollapsed,
  sessionStore,
  projectGroupStore,
  settingsStore,
  toolsStore,
  workspaceStore,
}: ChatPageProps) {
  const { i18n, t } = useTranslation("chat");
  const slashCommands = useMemo(() => composerSlashCommands(t), [t]);
  const tinyOsUiScope = useId();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [sessionTabs, dispatchSessionTabs] = useReducer(
    reduceSessionTabWorkspace,
    INITIAL_SESSION_TAB_WORKSPACE,
  );
  const [optimisticMessagesBySession, setOptimisticMessagesBySession] = useState<Map<string, ReactChatMessage[]>>(
    () => new Map(),
  );
  const [tinyOsCapabilities, setTinyOsCapabilities] = useState<TinyOsEffectiveCapabilities>(() => (
    unavailableTinyOsEffectiveCapabilities("", "loading", t("runtime.loadingCapabilities"))
  ));
  const [composerModels, setComposerModels] = useState<ModelOption[]>([]);
  const [defaultComposerModel, setDefaultComposerModel] = useState("");
  const [composerReasoningEffort, setComposerReasoningEffort] = useState(readCurrentChatReasoningEffort);
  const [contextUsageDefaults, setContextUsageDefaults] = useState<ContextUsageDefaults>({});
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  const [sessionWorkspaceError, setSessionWorkspaceError] = useState("");
  const [sessionCreatePending, setSessionCreatePending] = useState(false);
  const [localSessionSidebarCollapsed, setLocalSessionSidebarCollapsed] = useState(false);
  const [drawer, setDrawer] = useState<DrawerState>(null);
  const [liveCanvas, dispatchLiveCanvas] = useReducer(reduceLiveCanvasState, INITIAL_LIVE_CANVAS_STATE);
  const [commandLifecycle, dispatchCommandLifecycle] = useReducer(
    reduceTinyOsCommandLifecycle,
    { stage: "idle" } as TinyOsCommandLifecycle,
  );
  const [compactingSessionId, setCompactingSessionId] = useState("");
  const [tinyOsWidth, setTinyOsWidth] = useState(readStoredTinyOsWidth);
  const [queuedInputsBySession, setQueuedInputsBySession] = useState<Map<string, QueuedComposerInput[]>>(() => new Map());
  const [queueMessage, setQueueMessage] = useState("");
  const [tinyOsContextReferences, setTinyOsContextReferences] = useState<TinyOsContextReference[]>([]);
  const [composerSessionMentionIds, setComposerSessionMentionIds] = useState<string[]>([]);
  const [tinyOsDropError, setTinyOsDropError] = useState("");
  const [recoveringTurnId, setRecoveringTurnId] = useState("");
  const [installingMigrationJobId, setInstallingMigrationJobId] = useState("");
  const [migrationInstallError, setMigrationInstallError] = useState("");
  const [showBackToLatest, setShowBackToLatest] = useState(false);
  const [dissolvingSessionIds, setDissolvingSessionIds] = useState<Set<string>>(() => new Set());
  const [deleteState, dispatchDelete] = useReducer(reduceSessionDeleteState, { confirmingSessionId: "" });
  const sessionsRef = useRef<SessionSummary[]>([]);
  const queuedInputsRef = useRef<Map<string, QueuedComposerInput[]>>(new Map());
  const queuedInputSequence = useRef(0);
  const interruptCancellationConfirmedInputIdsRef = useRef(new Set<string>());
  const interruptDispatchingInputIdsRef = useRef(new Set<string>());
  const interruptTerminalInputIdsRef = useRef(new Set<string>());
  const deleteDissolveTimers = useRef<number[]>([]);
  const lastCreateSessionSignal = useRef(createSessionSignal);
  const draftSessionCreatePromise = useRef<Promise<SessionSummary> | null>(null);
  const optimisticSessionTitlesRef = useRef<Map<string, string>>(new Map());
  const conversationRef = useRef<HTMLDivElement | null>(null);
  const conversationEndRef = useRef<HTMLDivElement | null>(null);
  const conversationViewBySessionRef = useRef<Map<string, ConversationViewState>>(new Map());
  const pendingConversationRestoreRef = useRef("");
  const hasActivatedSessionRef = useRef(false);
  const liveCanvasHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const liveCanvasToggleRef = useRef<HTMLButtonElement | null>(null);
  const liveCanvasPreviousVisibilityRef = useRef(liveCanvas.visibility);
  const stickToLatestRef = useRef(true);
  const activeSessionId = sessionTabs.activeSessionId;
  const sessionRuntime = useChatSessionRuntime({
    chatStore,
    onEffect: handleChatSessionRuntimeEffect,
    sessionId: activeSessionId,
  });
  const {
    agentUiForms,
    browserError: browserRuntimeError,
    browserSnapshot,
    error: timelineError,
    timeline,
  } = sessionRuntime.state;
  const {
    acceptBrowserSnapshot,
    clearBrowserError,
    clearBrowserSnapshot,
    clearError: clearTimelineError,
    reload: reloadSessionRuntime,
    reportBrowserError,
    reportError: reportTimelineError,
  } = sessionRuntime.actions;
  const composerDraft = sessionTabDraft(sessionTabs, activeSessionId);
  const optimisticMessages = optimisticMessagesBySession.get(activeSessionId) ?? EMPTY_OPTIMISTIC_MESSAGES;

  useEffect(() => {
    const clampWidthToViewport = () => setTinyOsWidth((current) => clampTinyOsWidth(current));
    window.addEventListener("resize", clampWidthToViewport);
    return () => window.removeEventListener("resize", clampWidthToViewport);
  }, []);

  const resolvedSessionSidebarCollapsed = sessionSidebarCollapsed ?? localSessionSidebarCollapsed;
  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId),
    [activeSessionId, sessions],
  );
  useEffect(() => {
    setMigrationInstallError("");
  }, [activeSessionId]);
  const openSessionTabs = useMemo<SessionTabItem[]>(() => (
    sessionTabs.openSessionIds.flatMap((sessionId) => {
      const session = sessions.find((candidate) => candidate.id === sessionId);
      return session ? [{
        id: session.id,
        status: session.status,
        title: displaySessionTitle(session.title, t),
        unread: sessionTabs.unreadSessionIds.includes(session.id),
      }] : [];
    })
  ), [sessionTabs.openSessionIds, sessionTabs.unreadSessionIds, sessions, t]);
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
  const tinyOsFiles = useTinyOsFilesController(activeSession?.id ?? "draft", workspaceStore, liveCanvas.visibility === "open");
  const draftNewSession = sessionsLoaded && !activeSession;
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
  const cancelCapability = tinyOsCapabilities.capabilities.agent.cancel;
  const capabilityTargetsActiveTurn = !tinyOsCapabilities.evaluatedTurnId
    || tinyOsCapabilities.evaluatedTurnId === activeTurn?.id;
  const canCancelTurn = Boolean(
    activeSession
    && activeTurn
    && tinyOsCapabilities.threadId === activeSession.id
    && capabilityTargetsActiveTurn
    && cancelCapability.available
  );
  const cancelUnavailableReason = !capabilityTargetsActiveTurn
    ? t("runtime.staleCapabilities")
    : cancelCapability.reason || t("runtime.cancelUnavailable");
  const pauseCapability = tinyOsCapabilities.capabilities.agent.pause;
  const resumeCapability = tinyOsCapabilities.capabilities.agent.resume;
  const canPauseTurn = Boolean(
    activeSession
    && activeTurn
    && tinyOsCapabilities.threadId === activeSession.id
    && capabilityTargetsActiveTurn
    && pauseCapability.available
  );
  const canResumeTurn = Boolean(
    activeSession
    && activeTurn
    && tinyOsCapabilities.threadId === activeSession.id
    && capabilityTargetsActiveTurn
    && resumeCapability.available
  );
  const pauseUnavailableReason = !capabilityTargetsActiveTurn
    ? t("runtime.staleCapabilities")
    : pauseCapability.reason || t("runtime.pauseUnavailable");
  const resumeUnavailableReason = !capabilityTargetsActiveTurn
    ? t("runtime.staleCapabilities")
    : resumeCapability.reason || t("runtime.resumeUnavailable");
  const cancelInFlight = isTinyOsCommandInFlight(commandLifecycle);
  const compactingActiveSession = Boolean(activeSession && compactingSessionId === activeSession.id);
  const showCommandLifecycleStatus = commandLifecycle.stage !== "idle"
    && commandLifecycle.command.kind !== "agent.cancel";
  const requestChangeCapability = tinyOsCapabilities.capabilities.files.requestChange;
  const canRequestChange = Boolean(
    activeSession
    && tinyOsCapabilities.threadId === activeSession.id
    && requestChangeCapability.available
    && !cancelInFlight
  );
  const requestChangeUnavailableReason = cancelInFlight
    ? t("runtime.agentCommandInFlight")
    : requestChangeCapability.reason || t("runtime.agentRequestsUnavailable");
  const directEditCapability = tinyOsCapabilities.capabilities.files.directEdit;
  const saveFileCapability = tinyOsCapabilities.capabilities.files.save;
  const terminalExecuteCapability = tinyOsCapabilities.capabilities.terminal.execute;
  const browserInteractCapability = tinyOsCapabilities.capabilities.browser.interact;
  const canDirectEdit = Boolean(activeSession && directEditCapability.available && !cancelInFlight);
  const canSaveFile = Boolean(activeSession && saveFileCapability.available && !cancelInFlight);
  const canExecuteTerminal = Boolean(activeSession && terminalExecuteCapability.available && !cancelInFlight);
  const canInteractBrowser = Boolean(activeSession && browserInteractCapability.available && !cancelInFlight);
  const directEditUnavailableReason = cancelInFlight ? t("runtime.tinyOsCommandInFlight") : directEditCapability.reason;
  const saveFileUnavailableReason = cancelInFlight ? t("runtime.tinyOsCommandInFlight") : saveFileCapability.reason;
  const terminalExecuteUnavailableReason = cancelInFlight ? t("runtime.tinyOsCommandInFlight") : terminalExecuteCapability.reason;
  const browserInteractUnavailableReason = cancelInFlight
    ? t("runtime.tinyOsCommandInFlight")
    : browserInteractCapability.reason || t("runtime.browserUnavailable");
  const runningTerminalOperationId = commandLifecycle.stage !== "idle"
    && commandLifecycle.stage !== "completed"
    && commandLifecycle.command.kind === "terminal.execute"
    ? commandLifecycle.command.target.operationId
    : undefined;
  const canCancelTerminal = Boolean(activeSession && runningTerminalOperationId);
  const terminalCancelUnavailableReason = runningTerminalOperationId
    ? undefined
    : t("runtime.noRunningTerminal");
  const submittingFormId = commandLifecycle.stage !== "idle"
    && (commandLifecycle.command.kind === "form.submit" || commandLifecycle.command.kind === "form.cancel")
    && isTinyOsCommandInFlight(commandLifecycle)
    ? commandLifecycle.command.form.formId
    : "";
  const activeQueuedInputs = activeSession ? queuedInputsBySession.get(activeSession.id) ?? [] : [];
  const canInterruptQueuedInput = Boolean(
    activeTurn
    && activeTurn.status !== "awaiting_user"
    && !cancelInFlight
    && !activeQueuedInputs.some((input) => (
      input.mode === "interrupt" && (input.status === "queued" || input.status === "sent")
    )),
  );
  const activeContextUsage = useMemo(
    () => projectLatestContextUsage(timeline?.turns ?? [], contextUsageDefaults),
    [contextUsageDefaults, timeline],
  );
  const latestFailedTurnId = useMemo(() => (
    [...(timeline?.turns ?? [])].reverse().find((turn) => turn.status === "failed" || turn.status === "interrupted")?.id ?? ""
  ), [timeline]);
  const retryCapability = tinyOsCapabilities.capabilities.agent.retry;
  const canRetryTurn = Boolean(
    activeSession
    && latestFailedTurnId
    && tinyOsCapabilities.threadId === activeSession.id
    && tinyOsCapabilities.evaluatedTurnId === latestFailedTurnId
    && retryCapability.available
  );
  const retryUnavailableReason = retryCapability.reason || t("runtime.retryUnavailable");
  const liveCanvasOpen = liveCanvas.visibility === "open";
  const liveCanvasPresent = liveCanvas.visibility !== "closed";

  useEffect(() => {
    if (liveCanvas.visibility !== "closing") return;
    const timer = window.setTimeout(
      () => dispatchLiveCanvas({ type: "close_complete" }),
      LIVE_CANVAS_CLOSE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [liveCanvas.visibility]);

  const browserSessionId = browserSnapshot?.data.browserSessionId;
  const browserControlState = browserSnapshot?.data.control?.state;
  useEffect(() => {
    if (!browserSessionId) return;
    if (browserControlState === "user_required") {
      dispatchLiveCanvas({ type: "return_live" });
    }
  }, [browserControlState, browserSessionId]);

  useEffect(() => {
    if (liveCanvas.visibility !== "open"
      || browserSnapshot
      || !activeSession?.id
      || !chatStore.browserRuntime) {
      return;
    }
    let cancelled = false;
    void chatStore.browserRuntime.createSession({ ownerSessionId: activeSession.id }).then((snapshot) => {
      if (!cancelled) {
        acceptBrowserSnapshot(snapshot);
      }
    }).catch((error) => {
      if (!cancelled) reportBrowserError(error);
    });
    return () => {
      cancelled = true;
    };
  }, [acceptBrowserSnapshot, activeSession?.id, browserSnapshot, chatStore, liveCanvas.visibility, reportBrowserError]);
  const liveCanvasEntries = useMemo<LiveCanvasEntry[]>(() => (
    (timelineLoaded ? timeline?.turns ?? [] : []).flatMap((turn) => (
      (turn.executionItems ?? turn.steps).map((step) => ({ step, turnId: turn.id }))
    ))
  ), [timeline, timelineLoaded]);
  const liveCanvasCanonicalItems = useMemo(() => (
    (timelineLoaded ? timeline?.turns ?? [] : []).flatMap((turn) => turn.canonicalItems ?? [])
  ), [timeline, timelineLoaded]);
  const latestLiveCanvasEntry = liveCanvasEntries[liveCanvasEntries.length - 1];
  const latestLiveCanvasAttention = useMemo(() => [...liveCanvasEntries].reverse().find(({ step }) => (
    step.kind === "error"
      || step.status === "failed"
      || step.status === "cancelled"
      || (step.kind === "form" && step.status !== "completed")
  )), [liveCanvasEntries]);
  const selectedLiveCanvasEntry = liveCanvas.mode === "live_follow"
    ? latestLiveCanvasEntry
    : liveCanvasEntries.find((entry) => entry.turnId === liveCanvas.selection?.turnId && entry.step.id === liveCanvas.selection.itemId);

  const openLiveCanvasItem = (turnId: string, step: ChatStep) => {
    const eventIndex = lastCanonicalEventIndex(liveCanvasCanonicalItems, turnId, step.id);
    const boundary = eventIndex >= 0 ? liveCanvasCanonicalItems[eventIndex] : undefined;
    dispatchLiveCanvas({
      ...(eventIndex >= 0 ? { eventIndex } : {}),
      itemId: step.id,
      ...(boundary?.turnId ? { turnId: boundary.turnId } : {}),
      turnId,
      type: "select",
    });
  };

  const handleAttachTinyOsContext = (reference: TinyOsContextReference) => {
    const id = tinyOsContextReferenceId(reference);
    setTinyOsContextReferences((current) => [
      ...current.filter((candidate) => tinyOsContextReferenceId(candidate) !== id),
      reference,
    ]);
  };

  const handleTinyOsComposerDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const parsed = readTinyOsReferenceTransfer(event.dataTransfer);
    if (parsed.status === "rejected") {
      setTinyOsDropError(parsed.reason);
      return;
    }
    const accepted = tinyOsReferenceAcceptedBy(parsed.reference, "chat");
    if (accepted.status === "rejected") {
      setTinyOsDropError(accepted.reason);
      return;
    }
    setTinyOsDropError("");
    handleAttachTinyOsContext(accepted.reference.reference);
  };

  async function handleTinyOsAgentRequest(
    reference: TinyOsAgentRequestReference,
    intent: TinyOsAgentRequestIntent,
    fromHistory: boolean,
  ): Promise<void> {
    if (!activeSession || isTinyOsCommandInFlight(commandLifecycle)) return;
    if (tinyOsCapabilities.threadId !== activeSession.id || !requestChangeCapability.available) {
      reportTimelineError(requestChangeUnavailableReason);
      return;
    }
    const command = createTinyOsAgentRequestChangeCommand({
      instruction: tinyOsAgentRequestInstruction(reference, intent, t),
      observedTurnId: tinyOsCapabilities.evaluatedTurnId,
      references: [nativeReferenceFromTinyOs(reference, t)],
      sessionId: activeSession.id,
      source: { control: `${fromHistory ? "history-" : ""}${tinyOsAgentRequestControl(reference, intent)}`, surface: "tinyos" },
    });
    clearTimelineError();
    dispatchCommandLifecycle({ command, nowMs: now(), type: "dispatch" });
    if (fromHistory) dispatchLiveCanvas({ type: "return_live" });
    try {
      await chatStore.dispatch(command);
    } catch (error) {
      dispatchCommandLifecycle({
        commandId: command.commandId,
        error: error instanceof Error ? error.message : String(error),
        type: "rejected",
      });
    }
  }

  async function dispatchTinyOsHostCommand(command: TinyOsCommand, allowDuringTerminalExecution = false): Promise<void> {
    if (!activeSession) throw new Error(t("runtime.selectSessionHostOperation"));
    const terminalExecutionInFlight = commandLifecycle.stage !== "idle"
      && commandLifecycle.command.kind === "terminal.execute"
      && commandLifecycle.stage === "acknowledged";
    if (isTinyOsCommandInFlight(commandLifecycle) && !(allowDuringTerminalExecution && terminalExecutionInFlight)) {
      throw new Error(t("runtime.tinyOsCommandAlreadyInFlight"));
    }
    clearTimelineError();
    dispatchCommandLifecycle({ command, nowMs: now(), type: "dispatch" });
    try {
      await chatStore.dispatch(command);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dispatchCommandLifecycle({ commandId: command.commandId, error: message, type: "rejected" });
      const commandError = new Error(message);
      (commandError as Error & { cause?: unknown }).cause = error;
      throw commandError;
    }
  }

  async function handleSaveTinyOsFile(input: { baseRevision?: string; content: string; createOnly: boolean; path: string }): Promise<void> {
    if (!activeSession || !saveFileCapability.available) throw new Error(saveFileUnavailableReason || t("runtime.fileSavingUnavailable"));
    await dispatchTinyOsHostCommand(createTinyOsFileSaveCommand({
      ...input,
      sessionId: activeSession.id,
      source: { control: input.createOnly ? "files-create" : "files-save", surface: "tinyos" },
    }));
  }

  async function handleMoveTinyOsFile(input: { baseRevision: string; path: string; targetPath: string }): Promise<void> {
    if (!activeSession || !saveFileCapability.available) throw new Error(saveFileUnavailableReason || t("runtime.fileMovingUnavailable"));
    await dispatchTinyOsHostCommand(createTinyOsFileMoveCommand({
      ...input,
      sessionId: activeSession.id,
      source: { control: "files-move", surface: "tinyos" },
    }));
  }

  async function handleDeleteTinyOsFile(input: { baseRevision: string; path: string }): Promise<void> {
    if (!activeSession || !saveFileCapability.available) throw new Error(saveFileUnavailableReason || t("runtime.fileDeletionUnavailable"));
    await dispatchTinyOsHostCommand(createTinyOsFileDeleteCommand({
      ...input,
      sessionId: activeSession.id,
      source: { control: "files-delete", surface: "tinyos" },
    }));
  }

  async function handleExecuteTinyOsTerminal(input: { command: string; cwd?: string }): Promise<void> {
    if (!activeSession || !terminalExecuteCapability.available) throw new Error(terminalExecuteUnavailableReason || t("runtime.terminalExecutionUnavailable"));
    await dispatchTinyOsHostCommand(createTinyOsTerminalExecuteCommand({
      ...input,
      sessionId: activeSession.id,
      source: { control: "terminal-execute", surface: "tinyos" },
    }));
  }

  async function handleCancelTinyOsTerminal(): Promise<void> {
    if (!activeSession || !runningTerminalOperationId) {
      throw new Error(terminalCancelUnavailableReason || t("runtime.terminalCancellationUnavailable"));
    }
    await dispatchTinyOsHostCommand(createTinyOsTerminalCancelCommand({
      operationId: runningTerminalOperationId,
      sessionId: activeSession.id,
      source: { control: "terminal-cancel", surface: "tinyos" },
    }), true);
  }

  async function handleInteractTinyOsBrowser(input: {
    action: TinyOsBrowserAction;
    browserSessionId: string;
    captureId: string;
    controlEpoch: number;
    observationRevision: number;
    tabId: string;
  }): Promise<void> {
    if (!activeSession || !browserInteractCapability.available) {
      throw new Error(browserInteractUnavailableReason);
    }
    await dispatchTinyOsHostCommand(createTinyOsBrowserInteractCommand({
      ...input,
      sessionId: activeSession.id,
      source: { control: `browser-${input.action.type}`, surface: "tinyos" },
    }));
  }

  useEffect(() => {
    const previousVisibility = liveCanvasPreviousVisibilityRef.current;
    if (liveCanvas.visibility === "open" && previousVisibility !== "open") {
      liveCanvasHeadingRef.current?.focus();
    } else if (liveCanvas.visibility === "closed" && previousVisibility !== "closed") {
      liveCanvasToggleRef.current?.focus();
    }
    liveCanvasPreviousVisibilityRef.current = liveCanvas.visibility;
  }, [liveCanvas.visibility]);

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    if (!activeSessionId) {
      setTinyOsCapabilities(unavailableTinyOsEffectiveCapabilities("", "no_session", t("runtime.noSessionSelected")));
      return;
    }
    let cancelled = false;
    setTinyOsCapabilities(unavailableTinyOsEffectiveCapabilities(
      activeSessionId,
      "loading",
      t("runtime.loadingCapabilities"),
    ));
    void chatStore.loadTinyOsCapabilities(activeSessionId).then((capabilities) => {
      if (!cancelled) setTinyOsCapabilities(capabilities);
    }).catch((error) => {
      if (!cancelled) {
        setTinyOsCapabilities(unavailableTinyOsEffectiveCapabilities(
          activeSessionId,
          "capability_query_failed",
          error instanceof Error ? error.message : String(error),
        ));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [activeTurn?.id, activeTurn?.status, activeSessionId, chatStore, t]);

  useEffect(() => {
    setTinyOsContextReferences([]);
    setComposerSessionMentionIds([]);
    dispatchCommandLifecycle({ type: "reset" });
  }, [activeSession?.id]);

  useEffect(() => {
    if (!timeline || commandLifecycle.stage === "idle" || commandLifecycle.stage === "completed") return;
    if (commandLifecycle.stage === "acknowledged") {
      const completion = canonicalTinyOsCommandCompletion(
        timeline.turns,
        commandLifecycle.command,
      );
      if (!completion) return;
      dispatchCommandLifecycle({
        commandId: commandLifecycle.command.commandId,
        completion,
        nowMs: now(),
        type: "operation_completed",
      });
      return;
    }
    const acknowledgement = canonicalTinyOsCommandAcknowledgement(
      timeline.turns,
      commandLifecycle.command.commandId,
    );
    if (!acknowledgement) return;
    dispatchCommandLifecycle({
      acknowledgement,
      commandId: commandLifecycle.command.commandId,
      nowMs: now(),
      type: "canonical_acknowledged",
    });
  }, [commandLifecycle, now, timeline]);

  useEffect(() => {
    if (commandLifecycle.stage !== "sending" && commandLifecycle.stage !== "waiting_for_canonical") return;
    const elapsed = Math.max(0, now() - commandLifecycle.dispatchedAtMs);
    const timer = window.setTimeout(() => {
      dispatchCommandLifecycle({ commandId: commandLifecycle.command.commandId, type: "ack_timeout" });
    }, Math.max(0, TINYOS_COMMAND_ACK_TIMEOUT_MS - elapsed));
    return () => window.clearTimeout(timer);
  }, [commandLifecycle, now]);

  useEffect(() => {
    if (commandLifecycle.stage === "idle") return;
    if (commandLifecycle.command.kind === "operation.retry"
      && (commandLifecycle.stage === "rejected" || commandLifecycle.stage === "timed_out")) {
      reportTimelineError(`Retry failed: ${commandLifecycle.error}`);
      return;
    }
    if (commandLifecycle.command.kind === "agent.request_change"
      && (commandLifecycle.stage === "rejected" || commandLifecycle.stage === "timed_out")) {
      reportTimelineError(`Agent request failed: ${commandLifecycle.error}`);
      return;
    }
    if ((commandLifecycle.command.kind === "agent.pause" || commandLifecycle.command.kind === "agent.resume")
      && (commandLifecycle.stage === "rejected" || commandLifecycle.stage === "timed_out")) {
      reportTimelineError(`Agent ${commandLifecycle.command.kind === "agent.pause" ? "pause" : "resume"} failed: ${commandLifecycle.error}`);
      return;
    }
    if ((commandLifecycle.command.kind === "form.submit" || commandLifecycle.command.kind === "form.cancel")
      && (commandLifecycle.stage === "rejected" || commandLifecycle.stage === "timed_out")) {
      reportTimelineError(`Form ${commandLifecycle.command.kind === "form.cancel" ? "cancellation" : "submission"} failed: ${commandLifecycle.error}`);
      return;
    }
    if (["file.save", "file.move", "file.delete", "terminal.execute", "terminal.cancel", "browser.interact"].includes(commandLifecycle.command.kind)
      && (commandLifecycle.stage === "rejected" || commandLifecycle.stage === "timed_out")) {
      reportTimelineError(`TinyOS host operation failed: ${commandLifecycle.error}`);
    }
  }, [commandLifecycle, reportTimelineError]);

  useEffect(() => {
    return () => {
      deleteDissolveTimers.current.forEach((timer) => window.clearTimeout(timer));
      deleteDissolveTimers.current = [];
    };
  }, []);

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
        persisted: readPersistedSessionTabWorkspace(window.localStorage),
      });
    });
    return () => {
      cancelled = true;
    };
  }, [sessionStore]);

  useEffect(() => {
    if (!sessionsLoaded) {
      return;
    }
    const timer = window.setTimeout(() => {
      writePersistedSessionTabWorkspace(window.localStorage, sessionTabs);
    }, 180);
    return () => window.clearTimeout(timer);
  }, [sessionTabs, sessionsLoaded]);

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

  const handleBackgroundChatEvent = useEffectEvent((sessionId: string, event: ChatEvent) => {
    const effects = projectChatEventEffects(event);
    if (event.timeline) {
      updateSessionStatusFromTimeline(sessionId, event.timeline);
      dispatchSessionTabs({ type: "activity", sessionId });
    }
    if (effects.backgroundTabActivity) {
      dispatchSessionTabs({ type: "activity", sessionId });
    }
    if (effects.reloadSessions) {
      void handleQueueStateAfterChatEvent(sessionId, event);
    }
  });
  useEffect(() => {
    const unsubscribes = sessionTabs.openSessionIds
      .filter((sessionId) => sessionId !== activeSessionId)
      .map((sessionId) => chatStore.subscribe(sessionId, (event) => {
        handleBackgroundChatEvent(sessionId, event);
      }));
    return () => unsubscribes.forEach((unsubscribe) => unsubscribe());
  }, [activeSessionId, chatStore, sessionTabs.openSessionIds]);

  useEffect(() => {
    if (!settingsStore?.loadChatModels) {
      setComposerModels([]);
      setDefaultComposerModel("");
      return;
    }
    let cancelled = false;
    void settingsStore.loadChatModels().then((models) => {
      if (cancelled) {
        return;
      }
      const nextModels = models.map((model) => toComposerModelOption(model, t));
      setComposerModels(nextModels);
      setDefaultComposerModel(resolveComposerModel(nextModels));
    }).catch(() => {
      if (!cancelled) {
        setComposerModels([]);
        setDefaultComposerModel("");
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
    setDefaultComposerModel(model);
    const selected = composerModels.find((option) => option.id === model);
    if (selected) {
      writeCurrentChatModel(selected.modelId || selected.id, selected.providerId);
    }
  }, [activeSession?.id, activeSession?.model, activeSession?.modelProvider, composerModels]);

  useEffect(() => {
    if (!settingsStore?.loadAgentDefaultsSettings) {
      setContextUsageDefaults({});
      return;
    }
    let cancelled = false;
    void settingsStore.loadAgentDefaultsSettings().then((settings) => {
      const contextWindowTokens = Number(settings.values.contextWindowTokens);
      if (!Number.isSafeInteger(contextWindowTokens) || contextWindowTokens <= 0) {
        throw new Error(`Invalid context window token budget: ${settings.values.contextWindowTokens}`);
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
      element.scrollTo?.({
        behavior: "instant",
        top: Math.min(view.scrollTop, Math.max(0, element.scrollHeight - element.clientHeight)),
      });
      pendingConversationRestoreRef.current = "";
      return;
    }
    if (shouldRestore) {
      pendingConversationRestoreRef.current = "";
    }
    if (stickToLatestRef.current) {
      conversationEndRef.current?.scrollIntoView({ block: "end" });
    }
  }, [activeSessionId, timeline, optimisticMessages, agentUiForms.length]);

  async function handleCreateSession(
    workingDirectory?: string,
    projectContext?: ProjectSessionContext,
  ): Promise<SessionSummary | null> {
    if (sessionCreatePending) {
      return null;
    }
    setSessionCreatePending(true);
    setSessionWorkspaceError("");
    const inheritedProjectContext: ProjectSessionContext | undefined = workingDirectory === undefined && activeSession?.projectGroupId
      ? {
          projectCoordinator: activeSession.projectCoordinator,
          projectGroupId: activeSession.projectGroupId,
        }
      : undefined;
    const resolvedProjectContext = projectContext ?? inheritedProjectContext;
    const resolvedWorkingDirectory = resolvedProjectContext?.projectCoordinator
      ? undefined
      : workingDirectory ?? (activeSession?.pluginMigration ? undefined : activeSession?.workingDirectory);
    try {
      const created = await sessionStore.create({
        ...(resolvedWorkingDirectory ? { workingDirectory: resolvedWorkingDirectory } : {}),
        ...(resolvedProjectContext?.projectGroupId ? { projectGroupId: resolvedProjectContext.projectGroupId } : {}),
        ...(resolvedProjectContext?.projectCoordinator ? { projectCoordinator: true } : {}),
        ...(resolvedProjectContext?.title ? { title: resolvedProjectContext.title } : {}),
        ...composerSessionModelInput(composerModels, defaultComposerModel),
      });
      activateCreatedSession(created);
      return created;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSessionWorkspaceError(message);
      console.error("[session-workspaces] session.create.failed", {
        error: message,
        workingDirectory: resolvedWorkingDirectory ?? "",
        projectGroupId: resolvedProjectContext?.projectGroupId ?? "",
      });
      return null;
    } finally {
      setSessionCreatePending(false);
    }
  }

  async function handleInstallPluginMigration(session: SessionSummary): Promise<void> {
    const migration = session.pluginMigration;
    if (!migration || !toolsStore) return;
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
      await sessionStore.delete(session.id);
      optimisticSessionTitlesRef.current.delete(session.id);
      setDissolvingSessionIds((current) => new Set(current).add(session.id));
      const timer = window.setTimeout(() => {
        const remaining = sessionsRef.current.filter((item) => item.id !== session.id);
        sessionsRef.current = remaining;
        setSessions(remaining);
        dispatchSessionTabs({ type: "remove", sessionId: session.id });
        conversationViewBySessionRef.current.delete(session.id);
        setOptimisticMessagesBySession((current) => {
          if (!current.has(session.id)) return current;
          const next = new Map(current);
          next.delete(session.id);
          return next;
        });
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
      setOptimisticMessagesBySession((current) => replaceMapKey(
        current,
        sessionIdReplacement.previousSessionId,
        sessionIdReplacement.sessionId,
      ));
      updateQueuedInputsBySession((current) => replaceMapKey(
        current,
        sessionIdReplacement.previousSessionId,
        sessionIdReplacement.sessionId,
      ));
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
    const branched = await chatStore.branchFromMessage(session.id, messageId);
    const nextSessions = [branched, ...sessionsRef.current.filter((item) => item.id !== branched.id)];
    sessionsRef.current = nextSessions;
    setSessions(nextSessions);
    dispatchSessionTabs({ type: "open", sessionId: branched.id });
  }

  function dispatchTurn(sessionId: string, input: ChatInput, control: string): Promise<void> {
    return chatStore.dispatch(createDesktopTurnSubmitCommand({
      message: input,
      sessionId,
      source: { control, surface: "chat" },
    }));
  }

  async function handleBrowserHandoffComplete(session: SessionSummary): Promise<void> {
    try {
      await dispatchTurn(session.id, { text: t("browserHandoffContinue") }, "browser-handoff-complete");
      await handleSessionStoreRefresh(session);
    } catch (error) {
      reportTimelineError(t("runtime.browserHandoffFailed", { message: error instanceof Error ? error.message : String(error) }));
    }
  }

  async function handleExitTinyOs(): Promise<void> {
    const browserSession = browserSnapshot?.data;
    const browserRuntime = chatStore.browserRuntime;
    if (browserSession && browserRuntime && browserSession.sessionId === activeSession?.id) {
      try {
        await browserRuntime.closeSession(browserSession.browserSessionId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        reportBrowserError(message);
        reportTimelineError(t("runtime.browserReleaseFailed", { message }));
        console.error("[tinyos] browser.session.close.failed", {
          browserSessionId: browserSession.browserSessionId,
          error: message,
          ownerSessionId: browserSession.sessionId,
        });
        return;
      }
      clearBrowserSnapshot(browserSession.browserSessionId);
      clearBrowserError();
    }
    dispatchLiveCanvas({ type: "close" });
  }

  async function handleComposerSend(
    message: string,
    files: ComposerFileReference[],
    pastedContent: PastedContent[],
    options: ComposerSendOptions,
  ) {
    const availableMentionIds = new Set(composerSessionMentionOptions.map((option) => option.id));
    const prepared = await prepareChatSubmission({
      availableSessionIds: availableMentionIds,
      files,
      isRunning: activeSession ? sessionResponding : false,
      loadSessionTranscript: chatStore.copyMarkdown,
      message,
      now: nextQueuedInputTimestamp,
      options,
      pastedContent,
      queuedInputs: activeQueuedInputs,
      selectedSessionIds: composerSessionMentionIds,
      sessions: sessionsRef.current.map((session) => ({
        id: session.id,
        title: displaySessionTitle(session.title, t),
        updatedAtMs: session.updatedAtMs,
      })),
      t,
      tinyOsReferences: tinyOsContextReferences,
    });
    if (prepared.kind === "compact") {
      if (!activeSession) {
        throw new Error(t("errors.compactNeedsSession"));
      }
      const compactSession = activeSession;
      handleComposerDraftChange("");
      setCompactingSessionId(compactSession.id);
      try {
        await chatStore.dispatch(createDesktopCompactCommand({
          sessionId: compactSession.id,
          source: { control: "slash-compact", surface: "chat" },
        }));
        await reloadSessionRuntime();
        await handleSessionStoreRefresh(compactSession);
      } catch (error) {
        console.error("[chat] context.compact.failed", {
          error: error instanceof Error ? error.message : String(error),
          sessionId: compactSession.id,
        });
        throw error;
      } finally {
        setCompactingSessionId((current) => current === compactSession.id ? "" : current);
      }
      return;
    }
    if (prepared.kind === "empty") {
      return;
    }
    if (prepared.kind === "queue_limit_reached") {
      setQueueMessage(t("queue.limit", { count: MAX_QUEUED_INPUTS }));
      return;
    }
    const sendSession = activeSession ?? await createSessionForDraft();
    if (!sendSession) {
      return;
    }
    if (prepared.kind === "queue_input") {
      handleQueuedComposerResult(sendSession.id, prepared.input);
      return;
    }
    const visibleText = prepared.visibleText;
    const optimisticSession = isDefaultSessionTitle(sendSession.title)
      ? { ...sendSession, title: deriveSessionTitle(visibleText, t) }
      : sendSession;
    if (optimisticSession !== sendSession) {
      optimisticSessionTitlesRef.current.set(sendSession.id, optimisticSession.title);
      setSessions((current) => current.map((session) => session.id === sendSession.id ? optimisticSession : session));
      await sessionStore.rename(sendSession.id, optimisticSession.title);
    }
    await dispatchTurn(sendSession.id, prepared.turnInput, "composer-send");
    await handleSessionStoreRefresh(optimisticSession);
  }

  async function handleRecoverTurn(
    turn: ChatTurn,
    action: RecoveryAction,
    retryItemId?: string,
    surface: "chat" | "tinyos" = "chat",
  ): Promise<void> {
    if (!activeSession || recoveringTurnId || isTinyOsCommandInFlight(commandLifecycle)) {
      return;
    }
    setRecoveringTurnId(turn.id);
    try {
      if (action === "retry") {
        if (tinyOsCapabilities.threadId !== activeSession.id
          || tinyOsCapabilities.evaluatedTurnId !== turn.id
          || !tinyOsCapabilities.capabilities.agent.retry.available) {
          reportTimelineError(tinyOsCapabilities.capabilities.agent.retry.reason || t("runtime.failedTurnRetryUnavailable"));
          return;
        }
        const failedItem = retryItemId
          ? (turn.executionItems ?? turn.steps).find((step) => step.id === retryItemId && step.status === "failed")
          : [...(turn.executionItems ?? turn.steps)].reverse().find((step) => step.status === "failed");
        if (!failedItem) {
          reportTimelineError(t("runtime.failedItemUnavailable"));
          return;
        }
        const command = createTinyOsOperationRetryCommand({
          itemId: failedItem.id,
          sessionId: activeSession.id,
          source: { control: surface === "tinyos" ? "operation-shelf" : "error-recovery", surface },
          threadId: turn.canonicalItems?.find((item) => item.threadId)?.threadId,
          turnId: turn.id,
        });
        clearTimelineError();
        dispatchCommandLifecycle({ command, nowMs: now(), type: "dispatch" });
        try {
          await chatStore.dispatch(command);
        } catch (error) {
          dispatchCommandLifecycle({
            commandId: command.commandId,
            error: error instanceof Error ? error.message : String(error),
            type: "rejected",
          });
        }
        return;
      }
      if (action === "restart") {
        const created = await sessionStore.create({
          title: deriveSessionTitle(turn.userMessage.text, t),
          ...(activeSession.model
            ? {
                model: activeSession.model,
                ...(activeSession.modelProvider ? { modelProvider: activeSession.modelProvider } : {}),
              }
            : composerSessionModelInput(composerModels, defaultComposerModel)),
        });
        activateCreatedSession(created);
        await dispatchTurn(created.id, { text: turn.userMessage.text }, "recovery-restart");
        await handleSessionStoreRefresh(created);
        return;
      }
      const text = t("continuePrompt");
      await dispatchTurn(activeSession.id, { text }, "recovery-continue");
      await handleSessionStoreRefresh(activeSession);
    } finally {
      setRecoveringTurnId("");
    }
  }

  function handleConversationScroll(): void {
    const element = conversationRef.current;
    if (!element) {
      return;
    }
    const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 96;
    pendingConversationRestoreRef.current = "";
    stickToLatestRef.current = nearBottom;
    conversationViewBySessionRef.current.set(activeSessionId, {
      scrollTop: element.scrollTop,
      stickToLatest: nearBottom,
    });
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

  function handleQueuedComposerResult(
    sessionId: string,
    input: QueuedComposerInput,
  ) {
    setQueueMessage("");
    updateQueuedInputsBySession((current) => {
      const next = new Map(current);
      next.set(sessionId, [...(next.get(sessionId) ?? []), input]);
      return next;
    });
  }

  async function handleInterruptComposerResult(
    sessionId: string,
    turnId: string,
    input: QueuedComposerInput,
  ) {
    setQueueMessage("");
    updateQueuedInputsBySession((current) => {
      const next = new Map(current);
      next.set(sessionId, (next.get(sessionId) ?? []).map((candidate) => (
        candidate.id === input.id ? input : candidate
      )));
      return next;
    });
    const command = createTinyOsAgentCancelCommand({
      sessionId,
      source: { control: "composer-interrupt", surface: "chat" },
      turnId,
    });
    try {
      await chatStore.dispatch(command);
      interruptCancellationConfirmedInputIdsRef.current.add(input.id);
      await sendPendingInterruptInput(sessionId);
    } catch (error) {
      interruptCancellationConfirmedInputIdsRef.current.delete(input.id);
      interruptTerminalInputIdsRef.current.delete(input.id);
      updateInterruptForSession(sessionId, input.id, "failed");
      throw error;
    }
  }

  function updateInterruptForSession(
    sessionId: string,
    inputId: string,
    status: "sent" | "failed",
  ) {
    updateQueuedInputsBySession((current) => {
      const inputs = current.get(sessionId) ?? [];
      if (!inputs.some((input) => input.id === inputId && input.mode === "interrupt")) return current;
      const next = new Map(current);
      next.set(sessionId, updateInterruptStatus(inputs, inputId, status) as QueuedComposerInput[]);
      return next;
    });
  }

  async function createSessionForDraft(): Promise<SessionSummary | null> {
    if (!draftNewSession) {
      return null;
    }
    if (!draftSessionCreatePromise.current) {
      const modelInput = composerSessionModelInput(composerModels, defaultComposerModel);
      draftSessionCreatePromise.current = sessionStore.create(Object.keys(modelInput).length ? modelInput : undefined)
        .then((created) => {
          activateCreatedSession(created);
          return created;
        })
        .finally(() => {
          draftSessionCreatePromise.current = null;
        });
    }
    return draftSessionCreatePromise.current;
  }

  function activateCreatedSession(created: SessionSummary): void {
    sessionsRef.current = [created, ...sessionsRef.current.filter((session) => session.id !== created.id)];
    setSessions((current) => [created, ...current.filter((session) => session.id !== created.id)]);
    dispatchSessionTabs({ type: "open", sessionId: created.id });
  }

  function handleDeleteQueuedInput(sessionId: string, inputId: string) {
    setQueueMessage("");
    removeQueuedInputForSession(sessionId, inputId);
  }

  async function handleInterruptQueuedInput(sessionId: string, inputId: string) {
    setQueueMessage("");
    if (!activeTurn || activeTurn.status === "awaiting_user") {
      setQueueMessage(t("errors.noInterruptibleTurn"));
      return;
    }
    const inputs = queuedInputsRef.current.get(sessionId) ?? [];
    if (inputs.some((input) => (
      input.mode === "interrupt" && (input.status === "queued" || input.status === "sent")
    ))) {
      setQueueMessage(t("errors.interruptPending"));
      return;
    }
    const queuedInput = inputs.find((input) => (
      input.id === inputId
      && input.mode === "queued"
      && (input.status === "queued" || input.status === "paused")
    ));
    try {
      if (!queuedInput) {
        throw new Error(`Queued input ${inputId} is no longer available`);
      }
      await handleInterruptComposerResult(sessionId, activeTurn.id, {
        ...queuedInput,
        mode: "interrupt",
        status: "queued",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[chat] queued-input.interrupt.failed", {
        error: message,
        inputId,
        sessionId,
      });
      setQueueMessage(t("errors.interruptFailed", { message }));
    }
  }

  function removeQueuedInputForSession(sessionId: string, inputId: string) {
    updateQueuedInputsBySession((current) => {
      const next = new Map(current);
      const remaining = deleteQueuedInput(next.get(sessionId) ?? [], inputId);
      if (remaining.length) {
        next.set(sessionId, remaining as QueuedComposerInput[]);
      } else {
        next.delete(sessionId);
      }
      return next;
    });
  }

  async function handleStopGeneration(session: SessionSummary, surface: "chat" | "tinyos") {
    if (cancelInFlight) return;
    if (!canCancelTurn) {
      reportTimelineError(`Cannot cancel: ${cancelUnavailableReason}`);
      return;
    }
    if (!activeTurn) {
      reportTimelineError(t("runtime.cancelActiveTurnUnavailable"));
      return;
    }
    const command = createTinyOsAgentCancelCommand({
      sessionId: session.id,
      source: { control: surface === "tinyos" ? "system-bar-cancel" : "stop-response", surface },
      threadId: activeTurn.canonicalItems?.find((item) => item.threadId)?.threadId,
      turnId: activeTurn.id,
    });
    pauseQueuedInputsForSession(session.id);
    dispatchCommandLifecycle({ command, nowMs: now(), type: "dispatch" });
    try {
      await chatStore.dispatch(command);
    } catch (error) {
      dispatchCommandLifecycle({
        commandId: command.commandId,
        error: error instanceof Error ? error.message : String(error),
        type: "rejected",
      });
    }
  }

  function updateQueuedInputsBySession(
    updater: (current: Map<string, QueuedComposerInput[]>) => Map<string, QueuedComposerInput[]>,
  ) {
    setQueuedInputsBySession((current) => {
      const next = updater(current);
      queuedInputsRef.current = next;
      return next;
    });
  }

  function nextQueuedInputTimestamp(): string {
    const sequence = queuedInputSequence.current;
    queuedInputSequence.current += 1;
    return new Date(now() + sequence).toISOString();
  }

  function handleChatSessionRuntimeEffect(effect: ChatSessionRuntimeEffect): void {
    if (effect.type === "timeline_applied") {
      updateSessionStatusFromTimeline(effect.sessionId, effect.timeline);
      setOptimisticMessagesBySession((current) => updateSessionMessages(
        current,
        effect.sessionId,
        (messages) => messages.filter((message) => !effect.timeline.turns.some((turn) => (
          turn.userMessage.clientEventId === message.id
        ))),
      ));
      return;
    }
    if (effect.type === "message_received") {
      setOptimisticMessagesBySession((current) => updateSessionMessages(
        current,
        effect.sessionId,
        (messages) => (
          messages.some((message) => message.id === effect.message.id)
            ? messages.map((message) => (
              message.id === effect.message.id ? { ...message, ...effect.message } : message
            ))
            : [...messages, effect.message]
        ),
      ));
      return;
    }
    if (effect.type === "session_refresh_requested") {
      void handleQueueStateAfterChatEvent(effect.sessionId, effect.event);
      return;
    }

    const event = effect.event;
    if (event.command && event.type === "command.dispatched") {
      pauseQueuedInputsForSession(event.command.target.sessionId);
      dispatchCommandLifecycle({ command: event.command, nowMs: now(), type: "dispatch" });
      return;
    }
    if (event.commandId && event.operationId && event.operationStatus && event.type === "host.operation") {
      dispatchCommandLifecycle({
        commandId: event.commandId,
        error: event.error,
        nowMs: now(),
        operationId: event.operationId,
        status: event.operationStatus,
        type: "host_operation_updated",
      });
      return;
    }
    if (event.commandId && event.type === "command.accepted") {
      dispatchCommandLifecycle({ commandId: event.commandId, nowMs: now(), type: "transport_accepted" });
      return;
    }
    if (event.commandId && event.type === "error") {
      dispatchCommandLifecycle({
        commandId: event.commandId,
        error: event.error || t("runtime.commandRejected"),
        type: "rejected",
      });
    }
  }

  async function handleQueueStateAfterChatEvent(sessionId: string, event: ChatEvent) {
    const nextSessions = await handleSessionStoreRefresh();
    const effects = projectChatEventEffects(event);
    if (effects.terminalAgentEvent && await sendPendingInterruptInput(sessionId, true)) {
      return;
    }
    if (effects.queuedInputDisposition === "pause") {
      pauseQueuedInputsForSession(sessionId);
      return;
    }
    if (effects.queuedInputDisposition !== "dispatch_next") {
      return;
    }
    const nextSession = nextSessions.find((session) => session.id === sessionId);
    if (!canDispatchQueuedInput(nextSession)) {
      return;
    }
    await sendNextQueuedInput(sessionId, "normal_completion");
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

  async function sendPendingInterruptInput(
    sessionId: string,
    terminalEventReceived = false,
  ): Promise<boolean> {
    const input = (queuedInputsRef.current.get(sessionId) ?? []).find((candidate) => (
      candidate.mode === "interrupt" && (candidate.status === "queued" || candidate.status === "sent")
    ));
    if (!input) return false;
    if (terminalEventReceived) {
      interruptTerminalInputIdsRef.current.add(input.id);
    }
    if (!interruptCancellationConfirmedInputIdsRef.current.has(input.id)
      || !interruptTerminalInputIdsRef.current.has(input.id)) {
      return true;
    }
    if (interruptDispatchingInputIdsRef.current.has(input.id)) return true;
    interruptDispatchingInputIdsRef.current.add(input.id);
    updateInterruptForSession(sessionId, input.id, "sent");
    try {
      await dispatchTurn(sessionId, toChatInput(input), "interrupt-new-turn");
      removeQueuedInputForSession(sessionId, input.id);
      await handleSessionStoreRefresh();
    } catch (error) {
      updateInterruptForSession(sessionId, input.id, "failed");
      setQueueMessage(t("errors.interruptFailed", { message: error instanceof Error ? error.message : String(error) }));
    } finally {
      interruptCancellationConfirmedInputIdsRef.current.delete(input.id);
      interruptDispatchingInputIdsRef.current.delete(input.id);
      interruptTerminalInputIdsRef.current.delete(input.id);
    }
    return true;
  }

  async function handleResumeQueuedInputs(sessionId: string) {
    await sendNextQueuedInput(sessionId, "manual_resume");
  }

  async function sendNextQueuedInput(sessionId: string, mode: "normal_completion" | "manual_resume") {
    const inputs = queuedInputsRef.current.get(sessionId) ?? [];
    const result = mode === "manual_resume" ? resumeNextQueuedInput(inputs) : dispatchNextQueuedInput(inputs);
    if (!result.nextInput) {
      return;
    }
    await dispatchTurn(sessionId, toChatInput(result.nextInput as QueuedComposerInput), `queue-${mode}`);
    updateQueuedInputsBySession((current) => {
      const next = new Map(current);
      if (result.remainingInputs.length) {
        next.set(sessionId, result.remainingInputs as QueuedComposerInput[]);
      } else {
        next.delete(sessionId);
      }
      return next;
    });
    await handleSessionStoreRefresh();
  }

  function pauseQueuedInputsForSession(sessionId: string) {
    updateQueuedInputsBySession((current) => {
      const inputs = current.get(sessionId) ?? [];
      if (!inputs.length) {
        return current;
      }
      const next = new Map(current);
      next.set(sessionId, pauseQueuedInputs(inputs) as QueuedComposerInput[]);
      return next;
    });
  }

  async function handleOpenSubagent(delegate: DelegatedAgentState) {
    if (!activeSession) {
      return;
    }
    setDrawer({ kind: "subagent", title: delegate.title, delegate, loading: Boolean(chatStore.loadDelegateTrace) });
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

  async function handleOpenArtifact(artifact: ArtifactRef) {
    if (!activeSession) {
      return;
    }
    if (artifact.kind === "data_view") {
      setDrawer({
        kind: "artifact",
        title: artifact.title,
        artifact,
        ...(artifact.dataView ? { detail: { id: artifact.id, title: artifact.title, mimeType: artifact.mimeType, dataView: artifact.dataView } } : {}),
        loading: false,
        ...(artifact.dataViewError ? { error: artifact.dataViewError } : {}),
      });
      return;
    }
    setDrawer({ kind: "artifact", title: artifact.title, artifact, loading: Boolean(chatStore.loadArtifact) });
    if (!chatStore.loadArtifact) {
      return;
    }
    try {
      const payload = await chatStore.loadArtifact({
        artifactId: artifact.id,
        sessionKey: activeSession.id,
      });
      const detail = projectLoadedArtifactDetail(artifact, payload);
      setDrawer((current) => current?.kind === "artifact" && current.artifact.id === artifact.id
        ? { ...current, detail, loading: false }
        : current);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setDrawer((current) => current?.kind === "artifact" && current.artifact.id === artifact.id
        ? { ...current, error: message, loading: false }
        : current);
    }
  }

  async function handleSubmitAgentUiForm(
    form: AgentUiForm,
    values: Record<string, unknown>,
    surface: "chat" | "tinyos",
  ) {
    if (!activeSession || isTinyOsCommandInFlight(commandLifecycle)) {
      return;
    }
    if (!activeTurn) {
      reportTimelineError(t("runtime.submitFormTurnUnavailable"));
      return;
    }
    const formTurnId = agentUiFormCorrelationString(form, "turn_id") || form.turn_id || activeTurn.id;
    if (formTurnId !== activeTurn.id) {
      reportTimelineError(t("runtime.submitFormStaleTurn", { turnId: formTurnId }));
      return;
    }
    const command = createTinyOsFormSubmitCommand({
      formId: form.form_id,
      sessionId: activeSession.id,
      source: { control: surface === "tinyos" ? "system-form" : "chat-form", surface },
      threadId: agentUiFormCorrelationString(form, "thread_id")
        || activeTurn.canonicalItems?.find((item) => item.threadId)?.threadId,
      turnId: activeTurn.id,
      values,
    });
    clearTimelineError();
    dispatchCommandLifecycle({ command, nowMs: now(), type: "dispatch" });
    try {
      await chatStore.dispatch(command);
    } catch (error) {
      dispatchCommandLifecycle({
        commandId: command.commandId,
        error: error instanceof Error ? error.message : String(error),
        type: "rejected",
      });
    }
  }

  async function handleCancelAgentUiForm(form: AgentUiForm, surface: "chat" | "tinyos") {
    if (!activeSession || isTinyOsCommandInFlight(commandLifecycle)) {
      return;
    }
    if (!activeTurn) {
      reportTimelineError(t("runtime.cancelFormTurnUnavailable"));
      return;
    }
    const formTurnId = agentUiFormCorrelationString(form, "turn_id") || form.turn_id || activeTurn.id;
    if (formTurnId !== activeTurn.id) {
      reportTimelineError(t("runtime.cancelFormStaleTurn", { turnId: formTurnId }));
      return;
    }
    const command = createTinyOsFormCancelCommand({
      formId: form.form_id,
      sessionId: activeSession.id,
      source: { control: surface === "tinyos" ? "system-form" : "chat-form", surface },
      threadId: agentUiFormCorrelationString(form, "thread_id")
        || activeTurn.canonicalItems?.find((item) => item.threadId)?.threadId,
      turnId: activeTurn.id,
    });
    clearTimelineError();
    dispatchCommandLifecycle({ command, nowMs: now(), type: "dispatch" });
    try {
      await chatStore.dispatch(command);
    } catch (error) {
      dispatchCommandLifecycle({
        commandId: command.commandId,
        error: error instanceof Error ? error.message : String(error),
        type: "rejected",
      });
    }
  }

  async function handleAgentTurnControl(kind: "agent.pause" | "agent.resume", surface: "chat" | "tinyos") {
    if (!activeSession || isTinyOsCommandInFlight(commandLifecycle)) return;
    const available = kind === "agent.pause" ? canPauseTurn : canResumeTurn;
    const unavailableReason = kind === "agent.pause" ? pauseUnavailableReason : resumeUnavailableReason;
    if (!available) {
      reportTimelineError(t(kind === "agent.pause" ? "runtime.cannotPause" : "runtime.cannotResume", { reason: unavailableReason }));
      return;
    }
    if (!activeTurn) {
      reportTimelineError(t(kind === "agent.pause" ? "runtime.pauseTurnUnavailable" : "runtime.resumeTurnUnavailable"));
      return;
    }
    const command = createTinyOsAgentTurnControlCommand({
      kind,
      sessionId: activeSession.id,
      source: { control: surface === "tinyos" ? `system-bar-${kind.slice("agent.".length)}` : `chat-${kind.slice("agent.".length)}`, surface },
      threadId: activeTurn.canonicalItems?.find((item) => item.threadId)?.threadId,
      turnId: activeTurn.id,
    });
    clearTimelineError();
    dispatchCommandLifecycle({ command, nowMs: now(), type: "dispatch" });
    try {
      await chatStore.dispatch(command);
    } catch (error) {
      dispatchCommandLifecycle({
        commandId: command.commandId,
        error: error instanceof Error ? error.message : String(error),
        type: "rejected",
      });
    }
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

  function handleComposerDraftChange(value: string) {
    dispatchSessionTabs({ type: "draft.changed", sessionId: activeSessionId, value });
  }

  function handleChatPageKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key !== "Escape" || event.defaultPrevented || !sessionResponding || !canCancelTurn || !activeSession) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('[role="dialog"], [role="menu"], [role="listbox"]')) return;
    event.preventDefault();
    void handleStopGeneration(activeSession, "chat");
  }

  const visibleAgentUiForms = agentUiForms.filter(isVisibleAgentUiForm);
  const interactiveFormIds = new Set(visibleAgentUiForms.map((form) => form.form_id));
  const headerTitle = activeSession ? displaySessionTitle(activeSession.title, t) : draftNewSession ? t("shell.newChat") : t("shell.noSelection");
  return (
    <section
      className="react-chat-page"
      data-live-canvas-expanded={liveCanvasPresent && liveCanvas.surface === "expanded" ? "true" : undefined}
      aria-label={t("shell.label")}
      data-live-canvas-open={liveCanvasPresent ? "true" : undefined}
      data-session-sidebar-collapsed={resolvedSessionSidebarCollapsed}
      style={{ "--tinyos-width": `${tinyOsWidth}px` } as CSSProperties}
      onKeyDown={handleChatPageKeyDown}
    >
      <ChatSessionWorkspace
        actions={{
          onCancelDeleteConfirmation: (sessionId) => dispatchDelete({ type: "row-left", sessionId }),
          onCollapsedChange: handleSessionSidebarCollapsedChange,
          onCreateSession: handleCreateSession,
          onDeleteSession: handleDeleteSession,
          onOpenFiles,
          onOpenSettings,
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
        sessions={sessions}
      >

      <main className="react-chat-surface" data-empty-session={emptyActiveSession ? "true" : undefined}>
        <header className="react-chat-header">
          <h1 className="react-chat-header__title">{headerTitle}</h1>
          <SessionTabStrip
            activeSessionId={activeSessionId}
            tabs={openSessionTabs}
            onActivate={handleActivateSessionTab}
            onClose={handleCloseSessionTab}
            onCreate={() => void handleCreateSession()}
          />
          <div className="react-chat-header__actions">
            <button
              ref={liveCanvasToggleRef}
              aria-controls="tinybot-live-canvas"
              aria-expanded={liveCanvasOpen}
              aria-label={liveCanvasOpen
                ? t("shell.closeTinyOs")
                : latestLiveCanvasAttention
                  ? t("shell.openTinyOsAttention")
                  : liveCanvasEntries.length
                    ? t("shell.openTinyOsActivity")
                    : t("shell.openTinyOs")}
              className="react-live-canvas-toggle"
              data-active={liveCanvasOpen ? "true" : undefined}
              data-attention={latestLiveCanvasAttention ? "true" : undefined}
              data-has-activity={liveCanvasEntries.length ? "true" : undefined}
              title={liveCanvasOpen ? t("shell.closeTinyOs") : t("shell.openTinyOs")}
              type="button"
              onClick={() => dispatchLiveCanvas({ type: "toggle" })}
            >
              {liveCanvasOpen ? <PanelRightClose aria-hidden="true" size={18} /> : <PanelRightOpen aria-hidden="true" size={18} />}
              {!liveCanvasOpen && liveCanvasEntries.length ? <span aria-hidden="true" className="react-live-canvas-toggle__status" /> : null}
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
              <div className="react-menu" role="menu">
                <button aria-label={activeSession?.pinned ? t("shell.unpin") : t("shell.pin")} role="menuitem" type="button" onClick={() => activeSession && void handlePinConversation(activeSession)}>
                  {activeSession?.pinned ? t("shell.unpin") : t("shell.pin")}
                </button>
                <button aria-label={t("shell.rename")} role="menuitem" type="button" onClick={() => activeSession && void handleRenameConversation(activeSession)}>{t("shell.rename")}</button>
                <button aria-label={t("shell.copyId")} role="menuitem" type="button" onClick={() => activeSession && void handleCopyId(activeSession)}>{t("shell.copyId")}</button>
                <button aria-label={t("shell.copyMarkdown")} role="menuitem" type="button" onClick={() => activeSession && void handleCopyMarkdown(activeSession)}>{t("shell.copyMarkdown")}</button>
                <button aria-label={t("shell.archive")} role="menuitem" type="button" onClick={() => activeSession && void handleArchiveConversation(activeSession)}>{t("shell.archive")}</button>
                <button disabled role="menuitem" type="button">{t("shell.sideChat")}</button>
                <button disabled role="menuitem" type="button">{t("shell.branch")} <ChevronDown aria-hidden="true" size={14} /></button>
                <button disabled role="menuitem" type="button">{t("shell.newWindow")}</button>
              </div>
            ) : null}
          </div>
        </header>

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
              onOpenError: (turn, step) => setDrawer({ kind: "error", title: t("shell.errorDetails"), step, turn }),
              onOpenLiveCanvas: (turn, step) => openLiveCanvasItem(turn.id, step),
              onOpenSubagent: (delegate) => void handleOpenSubagent(delegate),
              onOpenTool: (toolCall) => setDrawer({ kind: "tool", title: toolCall.name, toolCall }),
              onRecover: (turn, action) => void handleRecoverTurn(turn, action),
            }}
            error={timelineError}
            interactiveFormIds={interactiveFormIds}
            latestFailedTurnId={latestFailedTurnId}
            optimisticMessages={optimisticMessages}
            recoveringTurnId={recoveringTurnId}
            sessionRunning={sessionRunning}
            turns={activeSession ? timeline?.turns ?? [] : []}
          />
          {activeSession && timeline?.turns.length ? null : emptyActiveSession ? <EmptyChatStart onSelectPrompt={handleComposerDraftChange} /> : activeSession ? null : <EmptyStateText text={t("shell.selectSession")} />}
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
                  disabled={Boolean(installingMigrationJobId) || !toolsStore}
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
                  onCancel={() => void handleCancelAgentUiForm(form, "chat")}
                  onSubmit={(values) => void handleSubmitAgentUiForm(form, values, "chat")}
                />
              ))}
            </div>
          ) : null}
          <div ref={conversationEndRef} aria-hidden="true" />
        </div>

        {showBackToLatest ? (
          <button className="react-back-to-latest" type="button" onClick={handleBackToLatest}>{t("shell.backToLatest")}</button>
        ) : null}

        {queueMessage ? <p className="react-queued-inputs__message">{queueMessage}</p> : null}
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
            {tinyOsCommandLifecycleLabel(commandLifecycle, t)}
          </p>
        ) : null}
        <div
          className="tinyos-composer-drop-target"
          onDragOver={(event) => {
            if (!Array.from(event.dataTransfer.types).includes(TINYOS_REFERENCE_MIME)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
          }}
          onDrop={handleTinyOsComposerDrop}
        >
          {activeSession && activeQueuedInputs.length ? (
            <QueuedInputsPanel
              canInterrupt={canInterruptQueuedInput}
              inputs={activeQueuedInputs}
              onDelete={(inputId) => handleDeleteQueuedInput(activeSession.id, inputId)}
              onInterrupt={(inputId) => void handleInterruptQueuedInput(activeSession.id, inputId)}
              onResume={() => void handleResumeQueuedInputs(activeSession.id)}
            />
          ) : null}
          <ClaudeStyleAiInput
            className={["react-composer", emptyActiveSession ? "react-composer--raised" : ""].filter(Boolean).join(" ")}
          contextReferences={tinyOsContextReferences.map((reference) => composerReferenceFromTinyOs(reference, t))}
          disabled={!activeSession && !draftNewSession}
          disabledReason={!sessionsLoaded ? t("shell.loadingSessions") : !activeSession && !draftNewSession ? t("shell.createOrSelect") : undefined}
          defaultModel={defaultComposerModel}
          defaultReasoningEffort={composerReasoningEffort}
          contextUsage={activeContextUsage}
          models={composerModels}
          onModelChange={(modelId) => {
            const selected = composerModels.find((model) => model.id === modelId);
            if (!selected) return;
            const selectedModelId = selected.modelId || selected.id;
            setDefaultComposerModel(modelId);
            writeCurrentChatModel(selectedModelId, selected.providerId);
            if (activeSession) {
              setSessions((current) => current.map((session) => (
                session.id === activeSession.id
                  ? {
                      ...session,
                      model: selectedModelId,
                      ...(selected.providerId ? { modelProvider: selected.providerId } : {}),
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
          onClearSessionMentions={() => setComposerSessionMentionIds([])}
          onRemoveSessionMention={(id) => setComposerSessionMentionIds((current) => current.filter((sessionId) => sessionId !== id))}
          responding={sessionResponding}
          selectedSessionMentionIds={composerSessionMentionIds}
          sessionMentionOptions={composerSessionMentionOptions}
          slashCommands={slashCommands}
          canStopResponding={canCancelTurn}
          stopUnavailableReason={cancelUnavailableReason}
          placeholder={emptyActiveSession ? t("shell.taskPlaceholder") : t("shell.messagePlaceholder")}
          value={composerDraft}
          onClearContextReferences={() => setTinyOsContextReferences([])}
          onRemoveContextReference={(id) => setTinyOsContextReferences((current) => current.filter((reference) => tinyOsContextReferenceId(reference) !== id))}
          onSelectFiles={pickDesktopChatFiles}
          onValueChange={handleComposerDraftChange}
          onSendMessage={(message, files, pastedContent, options) => handleComposerSend(message, files, pastedContent, options)}
          onStopResponding={() => activeSession && handleStopGeneration(activeSession, "chat")}
          />
          {tinyOsDropError ? <p className="tinyos-composer-drop-error" role="alert">{tinyOsDropError}</p> : null}
        </div>
      </main>

      {liveCanvasPresent ? (
        <LiveCanvas
          activeTurnId={activeTurn?.id}
          agentUiForms={visibleAgentUiForms}
          canonicalItems={liveCanvasCanonicalItems}
          canCancelTerminal={canCancelTerminal}
          canInteractBrowser={canInteractBrowser}
          canDirectEdit={canDirectEdit}
          canExecuteTerminal={canExecuteTerminal}
          entries={liveCanvasEntries}
          nativeSnapshots={browserSnapshot ? [browserSnapshot] : []}
          browserRuntime={chatStore.browserRuntime}
          closing={liveCanvas.visibility === "closing"}
          expanded={liveCanvas.surface === "expanded"}
          headingRef={liveCanvasHeadingRef}
          mode={liveCanvas.mode}
          canCancelTurn={canCancelTurn}
          canPauseTurn={canPauseTurn}
          canRequestChange={canRequestChange}
          canResumeTurn={canResumeTurn}
          canRetryTurn={canRetryTurn}
          canSaveFile={canSaveFile}
          cancelUnavailableReason={activeTurn && !canCancelTurn ? cancelUnavailableReason : undefined}
          pauseUnavailableReason={activeTurn && !canPauseTurn ? pauseUnavailableReason : undefined}
          commandLifecycle={commandLifecycle}
          selection={selectedLiveCanvasEntry}
          selectionEventIndex={liveCanvas.selection?.eventIndex}
          sessionKey={`${tinyOsUiScope}:${activeSession?.id ?? "draft"}`}
          widthPx={tinyOsWidth}
          filesController={tinyOsFiles}
          directEditUnavailableReason={directEditUnavailableReason}
          browserInteractUnavailableReason={browserRuntimeError || browserInteractUnavailableReason}
          onAttachContext={handleAttachTinyOsContext}
          onCancelForm={(form) => void handleCancelAgentUiForm(form, "tinyos")}
          onCancelTurn={() => activeSession && void handleStopGeneration(activeSession, "tinyos")}
          onPauseTurn={() => void handleAgentTurnControl("agent.pause", "tinyos")}
          onClose={() => dispatchLiveCanvas({ type: "close" })}
          onExit={handleExitTinyOs}
          onExpandedChange={() => dispatchLiveCanvas({ type: "expand_toggle" })}
          onOpenArtifact={(artifact) => void handleOpenArtifact(artifact)}
          onAgentRequest={(reference, intent, fromHistory) => void handleTinyOsAgentRequest(reference, intent, fromHistory)}
          onCancelTerminal={handleCancelTinyOsTerminal}
          onBrowserHandoffComplete={({ browserSessionId, ownerSessionId }) => {
            if (activeSession?.id !== ownerSessionId || browserSnapshot?.data.browserSessionId !== browserSessionId) return;
            void handleBrowserHandoffComplete(activeSession);
          }}
          onBrowserInteract={handleInteractTinyOsBrowser}
          onDeleteFile={handleDeleteTinyOsFile}
          onExecuteTerminal={handleExecuteTinyOsTerminal}
          onMoveFile={handleMoveTinyOsFile}
          onRetryOperation={(entry) => {
            const turn = timeline?.turns.find((candidate) => candidate.id === entry.turnId);
            if (turn) void handleRecoverTurn(turn, "retry", entry.step.id, "tinyos");
          }}
          onReturnToLive={() => dispatchLiveCanvas({ type: "return_live" })}
          onResumeTurn={() => void handleAgentTurnControl("agent.resume", "tinyos")}
          onSelectEntry={(entry) => openLiveCanvasItem(entry.turnId, entry.step)}
          onSubmitForm={(form, values) => void handleSubmitAgentUiForm(form, values, "tinyos")}
          onSaveFile={handleSaveTinyOsFile}
          requestChangeUnavailableReason={requestChangeUnavailableReason}
          retryTurnId={latestFailedTurnId || undefined}
          retryUnavailableReason={retryUnavailableReason}
          runningTerminalOperationId={runningTerminalOperationId}
          saveFileUnavailableReason={saveFileUnavailableReason}
          terminalCancelUnavailableReason={terminalCancelUnavailableReason}
          terminalExecuteUnavailableReason={terminalExecuteUnavailableReason}
          resumeUnavailableReason={activeTurn && !canResumeTurn ? resumeUnavailableReason : undefined}
          onWidthChange={(widthPx) => {
            setTinyOsWidth(widthPx);
            window.localStorage.setItem(TINYOS_WIDTH_STORAGE_KEY, String(widthPx));
          }}
        />
      ) : null}

      {drawer ? (
        <aside className="react-right-drawer" aria-label={t("shell.detailsDrawer")} data-motion="fade-content" data-state="open">
          <div className="react-right-drawer__header">
            <h2>{drawer.title}</h2>
            <button aria-label={t("shell.closeDetails")} type="button" onClick={() => setDrawer(null)}>
              <X aria-hidden="true" size={16} />
            </button>
          </div>
          <div className="react-right-drawer__content">
            {drawer.kind === "tool" ? (
              <ToolCallDetails toolCall={drawer.toolCall} />
            ) : drawer.kind === "subagent" ? (
              <SubagentDetails delegate={drawer.delegate} error={drawer.error} loading={drawer.loading} />
            ) : drawer.kind === "artifact" ? (
              <ArtifactDetails artifact={drawer.artifact} detail={drawer.detail} error={drawer.error} loading={drawer.loading} />
            ) : (
              <ChatErrorDetails step={drawer.step} turn={drawer.turn} />
            )}
          </div>
        </aside>
      ) : null}
      </ChatSessionWorkspace>
    </section>
  );
}


function EmptyChatStart({ onSelectPrompt }: { onSelectPrompt: (prompt: string) => void }) {
  const { t } = useTranslation("chat");
  const prompts = t("prompts", { returnObjects: true }) as readonly string[];
  return (
    <section aria-label={t("search.start")} className="react-empty-chat-start" data-empty-session="true">
      <h2>{t("empty.title")}</h2>
      <p>{t("empty.description")}</p>
      <div className="react-empty-chat-prompts" aria-label={t("empty.suggestions")}>
        {prompts.map((prompt) => (
          <button key={prompt} type="button" onClick={() => onSelectPrompt(prompt)}>{prompt}</button>
        ))}
      </div>
    </section>
  );
}

function EmptyStateText({ text }: { text: string }) {
  return <p className="react-empty-state">{text}</p>;
}

function toChatInput(input: QueuedComposerInput): ChatInput {
  return input.turnInput;
}

function tinyOsContextReferenceId(reference: TinyOsContextReference): string {
  const scope = reference.kind === "terminal"
    ? `${reference.turnId}:${reference.sourceItemId}`
    : reference.provenance.kind === "canonical"
      ? `${reference.provenance.turnId}:${reference.provenance.sourceItemId}`
      : reference.provenance.workspaceKey;
  return [
    reference.kind,
    scope,
    reference.kind === "file" ? reference.path : reference.command,
    reference.startLine ?? "",
    reference.endLine ?? "",
    reference.kind === "file" ? reference.revision ?? "" : "",
  ].join(":");
}

function tinyOsCommandLifecycleLabel(lifecycle: TinyOsCommandLifecycle, t: TFunction<"chat">): string {
  const commandKind = lifecycle.stage === "idle" ? "agent.cancel" : lifecycle.command.kind;
  const operation = ({
    "agent.cancel": t("lifecycle.operation.cancel"),
    "agent.pause": t("lifecycle.operation.pause"),
    "agent.request_change": t("lifecycle.operation.agentRequest"),
    "agent.resume": t("lifecycle.operation.resume"),
    "browser.interact": t("lifecycle.operation.browserInteraction"),
    "file.delete": t("lifecycle.operation.fileDeletion"),
    "file.move": t("lifecycle.operation.fileMove"),
    "file.save": t("lifecycle.operation.fileSave"),
    "form.cancel": t("lifecycle.operation.formCancellation"),
    "form.submit": t("lifecycle.operation.formSubmission"),
    "operation.retry": t("lifecycle.operation.retry"),
    "terminal.cancel": t("lifecycle.operation.terminalCancellation"),
    "terminal.execute": t("lifecycle.operation.terminalExecution"),
  } satisfies Record<TinyOsCommand["kind"], string>)[commandKind];
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

function agentUiFormCorrelationString(form: AgentUiForm, key: string): string {
  const value = form.correlation[key];
  return typeof value === "string" ? value : "";
}

function composerReferenceFromTinyOs(reference: TinyOsContextReference, t: TFunction<"chat">): ComposerContextReference {
  return {
    detail: reference.kind === "file" ? t("references.fileSelection") : t("references.terminalOutput"),
    id: tinyOsContextReferenceId(reference),
    kind: reference.kind,
    label: tinyOsReferenceLabel(reference, t),
  };
}

function tinyOsAgentRequestControl(reference: TinyOsAgentRequestReference, intent: TinyOsAgentRequestIntent): string {
  return `${reference.kind}-${intent.replace(/_/g, "-")}`;
}

function tinyOsAgentRequestInstruction(reference: TinyOsAgentRequestReference, intent: TinyOsAgentRequestIntent, t: TFunction<"chat">): string {
  if (intent === "explain") {
    return reference.kind === "file"
      ? t("agentRequests.explainFile")
      : t("agentRequests.explainTerminal");
  }
  if (intent === "modify" && reference.kind === "file") {
    return t("agentRequests.modifyFile");
  }
  if (intent === "follow_up" && reference.kind === "terminal") {
    return t("agentRequests.followTerminal");
  }
  if (intent === "adjust_plan" && reference.kind === "plan") {
    return t("agentRequests.adjustPlan", { adjustment: reference.adjustment });
  }
  throw new Error(`Unsupported TinyOS Agent request: ${reference.kind}/${intent}`);
}

function isVisibleAgentUiForm(form: AgentUiForm): boolean {
  return form.status !== "submitted" && form.status !== "cancelled" && form.status !== "expired";
}

async function writeClipboardText(value: string): Promise<void> {
  await navigator.clipboard?.writeText(value);
}

function updateSessionMessages(
  current: Map<string, ReactChatMessage[]>,
  sessionId: string,
  update: (messages: ReactChatMessage[]) => ReactChatMessage[],
): Map<string, ReactChatMessage[]> {
  const nextMessages = update(current.get(sessionId) ?? EMPTY_OPTIMISTIC_MESSAGES);
  const next = new Map(current);
  if (nextMessages.length) {
    next.set(sessionId, nextMessages);
  } else {
    next.delete(sessionId);
  }
  return next;
}

function replaceMapKey<T>(
  current: Map<string, T>,
  previousSessionId: string,
  sessionId: string,
): Map<string, T> {
  if (!current.has(previousSessionId) || previousSessionId === sessionId) {
    return current;
  }
  const next = new Map(current);
  const value = next.get(previousSessionId) as T;
  next.delete(previousSessionId);
  next.set(sessionId, value);
  return next;
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
  };
}

function QueuedInputsPanel({
  canInterrupt,
  inputs,
  onDelete,
  onInterrupt,
  onResume,
}: {
  canInterrupt: boolean;
  inputs: QueuedInput[];
  onDelete: (inputId: string) => void;
  onInterrupt: (inputId: string) => void;
  onResume: () => void;
}) {
  const { t } = useTranslation("chat");
  const hasPausedInput = inputs.some((input) => input.status === "paused");
  const pendingCount = inputs.filter((input) => input.status === "queued" || input.status === "paused").length;
  return (
    <section aria-label={t("queue.label")} aria-live="polite" className="react-queued-inputs">
      <div className="react-queued-inputs__header">
        <h2>{t("queue.title")}</h2>
        <div>
          <span>{t("queue.pending", { max: MAX_QUEUED_INPUTS, pending: pendingCount })}</span>
          {hasPausedInput ? <button type="button" onClick={onResume}>{t("queue.resume")}</button> : null}
        </div>
      </div>
      <ol>
        {inputs.map((input) => (
          <li className="react-queued-input" data-status={input.status} key={input.id}>
            <span>{queuedInputStatusLabel(input, t)}</span>
            <p>{input.content}</p>
            {(input.mode === "queued" && (input.status === "queued" || input.status === "paused")) || (input.mode === "interrupt" && input.status !== "queued") ? (
              <div className="react-queued-input__actions">
                {input.mode === "queued" && canInterrupt ? (
                  <button
                    className="react-queued-input__interrupt"
                    title={t("queue.interruptHelp")}
                    type="button"
                    onClick={() => onInterrupt(input.id)}
                  >
                    {t("queue.interrupt")}
                  </button>
                ) : null}
                <button type="button" onClick={() => onDelete(input.id)}>{input.mode === "interrupt" ? t("queue.clearInterrupt") : t("queue.delete")}</button>
              </div>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
}

function queuedInputStatusLabel(input: QueuedInput, t: TFunction<"chat">): string {
  if (input.mode === "interrupt") {
    switch (input.status) {
      case "sent":
        return t("queue.sending");
      case "failed":
        return t("queue.interruptFailed");
      default:
        return t("queue.interrupting");
    }
  }
  switch (input.status) {
    case "paused":
      return t("queue.paused");
    case "sent":
      return t("queue.sent");
    case "failed":
      return t("queue.failed");
    default:
      return t("queue.waiting");
  }
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

function ArtifactDetails({
  artifact,
  detail,
  error,
  loading,
}: {
  artifact: ArtifactRef;
  detail?: LoadedArtifactDetail;
  error?: string;
  loading: boolean;
}) {
  const { t } = useTranslation("chat");
  return (
    <div className="react-artifact-detail">
      <dl>
        <div><dt>{t("details.id")}</dt><dd>{artifact.id}</dd></div>
        {detail?.mimeType || artifact.mimeType ? <div><dt>{t("details.type")}</dt><dd>{detail?.mimeType || artifact.mimeType}</dd></div> : null}
      </dl>
      {loading ? <p aria-live="polite">{t("details.loadingArtifact")}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {detail?.imageDataUrl ? <img alt={detail.title} src={detail.imageDataUrl} /> : null}
      {detail?.dataView ? <DataViewCard artifact={{ ...artifact, dataView: detail.dataView }} expanded /> : null}
      {detail?.textContent ? <pre>{detail.textContent}</pre> : null}
      {!loading && !error && !detail?.dataView && !detail?.imageDataUrl && !detail?.textContent ? <p>{t("details.noPreview")}</p> : null}
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
