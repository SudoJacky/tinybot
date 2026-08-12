import { useEffect, useId, useMemo, useReducer, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { TFunction } from "i18next";
import {
  Activity,
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Circle,
  Copy,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  GitBranch,
  Loader2,
  ListCollapse,
  Play,
  RefreshCw,
  RotateCcw,
  MoreHorizontal,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  Search,
  Settings,
  Trash2,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  MAX_QUEUED_INPUTS,
  deleteQueuedInput,
  dispatchNextQueuedInput,
  pauseQueuedInputs,
  resumeNextQueuedInput,
  submitComposerText,
  updateInterruptStatus,
} from "../../app-core/chat/chatInputState";
import type { QueuedInput } from "../../app-core/chat/chatUiProjection";
import {
  ClaudeStyleAiInput,
  formatFileMetadata,
  type ComposerFileReference,
  type ComposerContextReference,
  type ComposerSendOptions,
  type ComposerSessionMentionOption,
  type ComposerSlashCommand,
  type ModelOption,
  type PastedContent,
} from "../../components/ui/claude-style-ai-input";
import { TextType } from "../../components/ui/TextType";
import { formatRelativeUpdatedTime } from "../lib/relativeTime";
import type { ChatEvent, ChatInput, ChatModelOption, ChatStore, ProjectGroup, ProjectGroupStore, SessionStore, SessionSummary, SettingsStore, ToolsStore, WorkspaceStore } from "../services";
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
import { pickDesktopWorkspaceDirectory } from "../../app-core/native/desktopNativeWorkspacePicker";
import { reduceSessionDeleteState } from "../sessions/sessionDeleteState";
import { canBranchFromMessage, canCopyMessage, type ContextReferenceSummary, type ReactChatMessage, type ToolCallSummary } from "./messageActions";
import type { AgentUiForm } from "../../app-core/agent-ui/agentUiEvents";
import { AgentUiFormCard } from "./AgentUiFormCard";
import { AssistantMarkdown } from "./AssistantMarkdown";
import { isApplyPatchToolCall, PatchDiffCard, patchChangeSetFromToolResult } from "./PatchDiffCard";
import { ToolActivityItem } from "./ToolActivityItem";
import { DataViewCard } from "./DataViewCard";
import { clampTinyOsWidth, LiveCanvas, type LiveCanvasEntry, type LiveCanvasMode } from "./LiveCanvas";
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
  sessionWorkspaceName,
} from "./sessionWorkspaces";
import { projectSessionGroups } from "./projectSessionGroups";
import { ProjectGroupDialog } from "./ProjectGroupDialog";
import {
  applyLoadedDelegatedAgentTrace,
  projectLoadedArtifactDetail,
  type ArtifactRef,
  type BackendAgentTurnItem,
  type ChatStep,
  type ChatTurn,
  type DelegatedAgentState,
  type LoadedArtifactDetail,
  type TokenUsage,
  type ToolCallState,
} from "../../app-core/chat/chatTurnModel";
import type { ChatTimelineSnapshot } from "../../app-core/chat/agentTimelineModel";
import type { TinyOsNativeBrowserSession, TinyOsNativeSnapshot } from "../../app-core/chat/tinyOsNativeSnapshot";
import type { AgentInputReference } from "../../app-core/chat/agentInputReference";
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

type ContextUsageDefaults = {
  contextWindowStrategy?: string;
  contextWindowTokens?: number;
};

type LiveCanvasState = {
  mode: LiveCanvasMode;
  selection?: { eventIndex?: number; itemId: string; turnId: string };
  surface: "panel" | "expanded";
  visibility: "closed" | "closing" | "open";
};

type LiveCanvasAction =
  | { type: "close" }
  | { type: "close_complete" }
  | { type: "expand_toggle" }
  | { type: "return_live" }
  | { type: "select"; eventIndex?: number; itemId: string; turnId: string }
  | { type: "toggle" };

const INITIAL_LIVE_CANVAS_STATE: LiveCanvasState = {
  mode: "live_follow",
  surface: "panel",
  visibility: "closed",
};

function reduceLiveCanvasState(state: LiveCanvasState, action: LiveCanvasAction): LiveCanvasState {
  switch (action.type) {
    case "close":
      return state.visibility === "open" ? { ...state, visibility: "closing" } : state;
    case "close_complete":
      return state.visibility === "closing" ? { ...state, visibility: "closed" } : state;
    case "expand_toggle":
      return { ...state, surface: state.surface === "expanded" ? "panel" : "expanded", visibility: "open" };
    case "return_live":
      return { ...state, mode: "live_follow", visibility: "open" };
    case "select":
      return {
        ...state,
        mode: "history",
        selection: {
          ...(action.eventIndex !== undefined ? { eventIndex: action.eventIndex } : {}),
          itemId: action.itemId,
          turnId: action.turnId,
        },
        visibility: "open",
      };
    case "toggle":
      return state.visibility === "open"
        ? { ...state, visibility: "closing" }
        : { ...state, mode: "live_follow", visibility: "open" };
  }
}

type RecoveryAction = "continue" | "retry" | "restart";

type QueuedComposerInput = QueuedInput & { turnInput: ChatInput };

function shouldFrameBatchTimeline(timeline: ChatTimelineSnapshot): boolean {
  return timeline.turns[timeline.turns.length - 1]?.status === "running";
}

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
const MAX_COMPOSER_SESSION_REFERENCES = 4;
const MAX_COMPOSER_SESSION_CONTEXT_BYTES = 48 * 1024;
const SESSION_TRANSCRIPT_OMISSION = "\n\n[... middle conversation content omitted to fit the context limit ...]\n\n";

type ProjectSessionContext = {
  projectCoordinator?: boolean;
  projectGroupId: string;
  title?: string;
};

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
  const [projectGroups, setProjectGroups] = useState<ProjectGroup[]>([]);
  const [projectDialogGroupId, setProjectDialogGroupId] = useState<string | "new">();
  const [workspaceActionMenuOpen, setWorkspaceActionMenuOpen] = useState(false);
  const [sessionTabs, dispatchSessionTabs] = useReducer(
    reduceSessionTabWorkspace,
    INITIAL_SESSION_TAB_WORKSPACE,
  );
  const [timeline, setTimeline] = useState<ChatTimelineSnapshot | null>(null);
  const [optimisticMessagesBySession, setOptimisticMessagesBySession] = useState<Map<string, ReactChatMessage[]>>(
    () => new Map(),
  );
  const [timelineError, setTimelineError] = useState("");
  const [browserSnapshot, setBrowserSnapshot] = useState<TinyOsNativeSnapshot<TinyOsNativeBrowserSession>>();
  const [browserRuntimeError, setBrowserRuntimeError] = useState("");
  const [tinyOsCapabilities, setTinyOsCapabilities] = useState<TinyOsEffectiveCapabilities>(() => (
    unavailableTinyOsEffectiveCapabilities("", "loading", t("runtime.loadingCapabilities"))
  ));
  const [composerModels, setComposerModels] = useState<ModelOption[]>([]);
  const [defaultComposerModel, setDefaultComposerModel] = useState("");
  const [composerReasoningEffort, setComposerReasoningEffort] = useState(readCurrentChatReasoningEffort);
  const [contextUsageDefaults, setContextUsageDefaults] = useState<ContextUsageDefaults>({});
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  const [sessionSearchOpen, setSessionSearchOpen] = useState(false);
  const [sessionWorkspaceError, setSessionWorkspaceError] = useState("");
  const [sessionCreatePending, setSessionCreatePending] = useState(false);
  const [workspacePickerPending, setWorkspacePickerPending] = useState(false);
  const [localSessionSidebarCollapsed, setLocalSessionSidebarCollapsed] = useState(false);
  const [drawer, setDrawer] = useState<DrawerState>(null);
  const [liveCanvas, dispatchLiveCanvas] = useReducer(reduceLiveCanvasState, INITIAL_LIVE_CANVAS_STATE);
  const [commandLifecycle, dispatchCommandLifecycle] = useReducer(
    reduceTinyOsCommandLifecycle,
    { stage: "idle" } as TinyOsCommandLifecycle,
  );
  const [compactingSessionId, setCompactingSessionId] = useState("");
  const [tinyOsWidth, setTinyOsWidth] = useState(readStoredTinyOsWidth);
  const [agentUiForms, setAgentUiForms] = useState<AgentUiForm[]>([]);
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
  const workspaceActionMenuRef = useRef<HTMLDivElement | null>(null);
  const activeSessionId = sessionTabs.activeSessionId;
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
  ), [sessionTabs.openSessionIds, sessionTabs.unreadSessionIds, sessions]);
  const projectProjection = useMemo(
    () => projectSessionGroups(projectGroups, sessions),
    [projectGroups, sessions],
  );
  const allSessionWorkspaces = useMemo(() => groupSessionsByWorkspace(sessions).map((workspace) => ({
    ...workspace,
    label: workspace.label ?? t("shell.generalSessions"),
  })), [sessions, t]);
  const sessionWorkspaces = useMemo(() => groupSessionsByWorkspace(projectProjection.ungroupedSessions).map((workspace) => ({
    ...workspace,
    label: workspace.label ?? t("shell.generalSessions"),
  })), [projectProjection.ungroupedSessions, t]);
  const availableProjectWorkspaceIds = useMemo(() => Array.from(new Set([
    ...sessions.flatMap((session) => session.workingDirectory ? [session.workingDirectory] : []),
    ...projectGroups.flatMap((group) => group.workspaceIds),
  ])), [projectGroups, sessions]);
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
    () => latestTimelineUsage(timeline?.turns ?? [], contextUsageDefaults),
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

  useEffect(() => {
    const browserSession = browserSnapshot?.data;
    if (!browserSession) return;
    if (browserSession.control?.state === "user_required") {
      dispatchLiveCanvas({ type: "return_live" });
    }
  }, [browserSnapshot?.data.browserSessionId, browserSnapshot?.data.control?.state]);

  useEffect(() => {
    setBrowserSnapshot(undefined);
    setBrowserRuntimeError("");
  }, [activeSession?.id]);

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
        setBrowserSnapshot(snapshot);
        setBrowserRuntimeError("");
      }
    }).catch((error) => {
      if (!cancelled) setBrowserRuntimeError(error instanceof Error ? error.message : String(error));
    });
    return () => {
      cancelled = true;
    };
  }, [activeSession?.id, browserSnapshot, chatStore, liveCanvas.visibility]);
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
      setTimelineError(requestChangeUnavailableReason);
      return;
    }
    const command = createTinyOsAgentRequestChangeCommand({
      instruction: tinyOsAgentRequestInstruction(reference, intent, t),
      observedTurnId: tinyOsCapabilities.evaluatedTurnId,
      references: [nativeReferenceFromTinyOs(reference, t)],
      sessionId: activeSession.id,
      source: { control: `${fromHistory ? "history-" : ""}${tinyOsAgentRequestControl(reference, intent)}`, surface: "tinyos" },
    });
    setTimelineError("");
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
    setTimelineError("");
    dispatchCommandLifecycle({ command, nowMs: now(), type: "dispatch" });
    try {
      await chatStore.dispatch(command);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dispatchCommandLifecycle({ commandId: command.commandId, error: message, type: "rejected" });
      throw new Error(message);
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
  }, [activeTurn?.id, activeTurn?.status, activeSessionId, chatStore]);

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
      setTimelineError(`Retry failed: ${commandLifecycle.error}`);
      return;
    }
    if (commandLifecycle.command.kind === "agent.request_change"
      && (commandLifecycle.stage === "rejected" || commandLifecycle.stage === "timed_out")) {
      setTimelineError(`Agent request failed: ${commandLifecycle.error}`);
      return;
    }
    if ((commandLifecycle.command.kind === "agent.pause" || commandLifecycle.command.kind === "agent.resume")
      && (commandLifecycle.stage === "rejected" || commandLifecycle.stage === "timed_out")) {
      setTimelineError(`Agent ${commandLifecycle.command.kind === "agent.pause" ? "pause" : "resume"} failed: ${commandLifecycle.error}`);
      return;
    }
    if ((commandLifecycle.command.kind === "form.submit" || commandLifecycle.command.kind === "form.cancel")
      && (commandLifecycle.stage === "rejected" || commandLifecycle.stage === "timed_out")) {
      setTimelineError(`Form ${commandLifecycle.command.kind === "form.cancel" ? "cancellation" : "submission"} failed: ${commandLifecycle.error}`);
      return;
    }
    if (["file.save", "file.move", "file.delete", "terminal.execute", "terminal.cancel", "browser.interact"].includes(commandLifecycle.command.kind)
      && (commandLifecycle.stage === "rejected" || commandLifecycle.stage === "timed_out")) {
      setTimelineError(`TinyOS host operation failed: ${commandLifecycle.error}`);
    }
  }, [commandLifecycle]);

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
    if (!projectGroupStore) return;
    let cancelled = false;
    void projectGroupStore.list().then((groups) => {
      if (!cancelled) setProjectGroups(groups);
    }).catch((error) => {
      if (!cancelled) setSessionWorkspaceError(error instanceof Error ? error.message : String(error));
    });
    return () => {
      cancelled = true;
    };
  }, [projectGroupStore]);

  useEffect(() => {
    if (!workspaceActionMenuOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!workspaceActionMenuRef.current?.contains(event.target as Node)) {
        setWorkspaceActionMenuOpen(false);
      }
    };
    window.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => window.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [workspaceActionMenuOpen]);

  useEffect(() => {
    if (!sessionsLoaded) {
      return;
    }
    const timer = window.setTimeout(() => {
      writePersistedSessionTabWorkspace(window.localStorage, sessionTabs);
    }, 180);
    return () => window.clearTimeout(timer);
  }, [sessionTabs, sessionsLoaded]);

  useEffect(() => {
    if (createSessionSignal === lastCreateSessionSignal.current) {
      return;
    }
    lastCreateSessionSignal.current = createSessionSignal;
    void handleCreateSession();
  }, [createSessionSignal]);

  useEffect(() => {
    if (!activeSessionId) {
      setTimeline(null);
      setTimelineError("");
      return;
    }
    setTimeline(null);
    setTimelineError("");
    setAgentUiForms([]);
    setBrowserSnapshot(undefined);
    let cancelled = false;
    const loadTimeline = () => chatStore.load(activeSessionId).then((nextTimeline) => {
      if (!cancelled) {
        setTimeline(nextTimeline);
        setTimelineError("");
      }
    }).catch((error) => {
      if (!cancelled) {
        setTimelineError(error instanceof Error ? error.message : String(error));
      }
    });
    const loadAgentUiForms = () => chatStore.listAgentUiForms(activeSessionId).then((nextForms) => {
      if (!cancelled) {
        setAgentUiForms(nextForms);
      }
    });
    let pendingStreamingTimeline: ChatTimelineSnapshot | null = null;
    let streamingFrame: number | null = null;
    const applyTimeline = (nextTimeline: ChatTimelineSnapshot) => {
      setTimeline(nextTimeline);
      setTimelineError("");
      setOptimisticMessagesBySession((current) => updateSessionMessages(
        current,
        activeSessionId,
        (messages) => messages.filter((message) => !nextTimeline.turns.some((turn) => (
          turn.userMessage.clientEventId === message.id
        ))),
      ));
    };
    const scheduleStreamingTimeline = (nextTimeline: ChatTimelineSnapshot) => {
      pendingStreamingTimeline = nextTimeline;
      if (streamingFrame !== null) {
        return;
      }
      streamingFrame = window.requestAnimationFrame(() => {
        streamingFrame = null;
        const pending = pendingStreamingTimeline;
        pendingStreamingTimeline = null;
        if (pending && !cancelled) {
          applyTimeline(pending);
        }
      });
    };
    void loadTimeline();
    void loadAgentUiForms();
    const unsubscribe = chatStore.subscribe(activeSessionId, (event) => {
      if (event.browserSnapshot) {
        setBrowserSnapshot(event.browserSnapshot);
        setBrowserRuntimeError("");
        return;
      }
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
      if (event.commandId && event.type === "command.canonical-updated") {
        void loadTimeline();
        return;
      }
      if (event.commandId && event.type === "error") {
        dispatchCommandLifecycle({ commandId: event.commandId, error: event.error || t("runtime.commandRejected"), type: "rejected" });
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
          applyTimeline(event.timeline);
        }
        return;
      }
      if (event.error) {
        setTimelineError(event.error);
        return;
      }
      if (event.message) {
        const nextMessage = event.message;
        setOptimisticMessagesBySession((current) => updateSessionMessages(
          current,
          activeSessionId,
          (messages) => (
            messages.some((message) => message.id === nextMessage.id)
              ? messages.map((message) => (
                message.id === nextMessage.id ? { ...message, ...nextMessage } : message
              ))
              : [...messages, nextMessage]
          ),
        ));
        return;
      }
      if (shouldReloadSessionsForChatEvent(event)) {
        void handleQueueStateAfterChatEvent(activeSessionId, event);
      }
      if (shouldReloadMessagesForChatEvent(event.type)) {
        void loadTimeline();
      }
      if (shouldReloadAgentUiFormsForChatEvent(event.type)) {
        void loadAgentUiForms();
      }
    });
    return () => {
      cancelled = true;
      if (streamingFrame !== null) {
        window.cancelAnimationFrame(streamingFrame);
      }
      unsubscribe();
    };
  }, [activeSessionId, chatStore, now]);

  useEffect(() => {
    const unsubscribes = sessionTabs.openSessionIds
      .filter((sessionId) => sessionId !== activeSessionId)
      .map((sessionId) => chatStore.subscribe(sessionId, (event) => {
        if (event.timeline) {
          const status = sessionStatusFromTimeline(event.timeline);
          if (status) {
            setSessions((current) => {
              const next = current.map((session) => (
                session.id === sessionId ? { ...session, status } : session
              ));
              sessionsRef.current = next;
              return next;
            });
          }
          dispatchSessionTabs({ type: "activity", sessionId });
        }
        if (isBackgroundTabActivityEvent(event)) {
          dispatchSessionTabs({ type: "activity", sessionId });
        }
        if (shouldReloadSessionsForChatEvent(event)) {
          void handleQueueStateAfterChatEvent(sessionId, event);
        }
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
  }, [settingsStore]);

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

  useEffect(() => {
    onStopGenerationTargetChange?.(activeSession && sessionResponding ? activeSession.id : "");
  }, [activeSession?.id, onStopGenerationTargetChange, sessionResponding]);

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

  async function handleCreateSessionFromSearch() {
    const created = await handleCreateSession();
    if (created) {
      setSessionSearchOpen(false);
    }
  }

  async function handleAddWorkspace() {
    if (workspacePickerPending || sessionCreatePending) {
      return;
    }
    setWorkspacePickerPending(true);
    setSessionWorkspaceError("");
    try {
      const workingDirectory = await pickDesktopWorkspaceDirectory();
      if (workingDirectory) {
        await handleCreateSession(workingDirectory);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSessionWorkspaceError(message);
      console.error("[session-workspaces] workspace.pick.failed", { error: message });
    } finally {
      setWorkspacePickerPending(false);
    }
  }

  async function handleSaveProjectGroup(input: {
    projectGroupId?: string;
    name: string;
    workspaceIds: string[];
  }) {
    if (!projectGroupStore) throw new Error(t("projectGroups.unavailable"));
    const saved = await projectGroupStore.save(input);
    setProjectGroups((current) => {
      const existing = current.findIndex((group) => group.projectGroupId === saved.projectGroupId);
      if (existing < 0) return [...current, saved];
      const next = [...current];
      next[existing] = saved;
      return next;
    });
  }

  async function handleDeleteProjectGroup(projectGroupId: string) {
    if (!projectGroupStore) throw new Error(t("projectGroups.unavailable"));
    await projectGroupStore.delete(projectGroupId);
    setProjectGroups((current) => current.filter((group) => group.projectGroupId !== projectGroupId));
  }

  async function handleChooseProjectWorkspace(): Promise<string | undefined> {
    if (workspacePickerPending) return undefined;
    setWorkspacePickerPending(true);
    try {
      return await pickDesktopWorkspaceDirectory() || undefined;
    } finally {
      setWorkspacePickerPending(false);
    }
  }

  function handleCreateCoordinatorSession(project: ProjectGroup) {
    void handleCreateSession(undefined, {
      projectCoordinator: true,
      projectGroupId: project.projectGroupId,
      title: t("projectGroups.newCoordinatorTitle", { name: project.name }),
    });
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
      setTimelineError(t("runtime.browserHandoffFailed", { message: error instanceof Error ? error.message : String(error) }));
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
        setBrowserRuntimeError(message);
        setTimelineError(t("runtime.browserReleaseFailed", { message }));
        console.error("[tinyos] browser.session.close.failed", {
          browserSessionId: browserSession.browserSessionId,
          error: message,
          ownerSessionId: browserSession.sessionId,
        });
        return;
      }
      setBrowserSnapshot((current) => (
        current?.data.browserSessionId === browserSession.browserSessionId ? undefined : current
      ));
      setBrowserRuntimeError("");
    }
    dispatchLiveCanvas({ type: "close" });
  }

  async function handleComposerSend(
    message: string,
    files: ComposerFileReference[],
    pastedContent: PastedContent[],
    options: ComposerSendOptions,
  ) {
    if (message.trim() === "/compact") {
      if (files.length || pastedContent.length || tinyOsContextReferences.length || composerSessionMentionIds.length) {
        throw new Error(t("errors.compactWithAttachments"));
      }
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
        const compactedTimeline = await chatStore.load(compactSession.id);
        setTimeline((current) => (
          current?.sessionId === compactSession.id ? compactedTimeline : current
        ));
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
    const availableMentionIds = new Set(composerSessionMentionOptions.map((option) => option.id));
    const mentionedSessions = composerSessionMentionIds.map((sessionId) => {
      const session = sessionsRef.current.find((candidate) => candidate.id === sessionId);
      if (!session || !availableMentionIds.has(sessionId)) {
        throw new Error(t("composer.sessionMention.unavailable"));
      }
      return session;
    });
    const references = [
      ...files.map(nativeReferenceFromComposerFile),
      ...tinyOsContextReferences.map((reference) => nativeReferenceFromTinyOs(reference, t)),
      ...await nativeReferencesFromComposerSessions(mentionedSessions, chatStore.copyMarkdown, t),
    ];
    const visibleText = formatComposerMessage(
      message || (files.length
        ? t("composer.attachedFilesPrompt")
        : mentionedSessions.length ? t("composer.sessionMention.attachedPrompt")
          : references.length ? t("composer.attachedContextPrompt") : ""),
      pastedContent,
      t,
    );
    const sendSession = activeSession ?? await createSessionForDraft();
    if (!visibleText || !sendSession) {
      return;
    }
    const queuedResult = submitComposerText({
      content: visibleText,
      isRunning: sendSession.id === activeSession?.id
        ? sessionResponding
        : isQueueableRunningSession(sendSession, emptyActiveSession),
      now: nextQueuedInputTimestamp(),
      queuedInputs: activeQueuedInputs,
    });
    if (queuedResult.kind === "queue_limit_reached") {
      setQueueMessage(t("queue.limit", { count: MAX_QUEUED_INPUTS }));
      return;
    }
    const turnInput = createComposerChatInput(
      queuedResult.kind === "send_message" ? queuedResult.content : queuedResult.input.content,
      options,
      references,
    );
    if (queuedResult.kind === "queue_input") {
      handleQueuedComposerResult(sendSession.id, queuedResult.input, turnInput);
      return;
    }
    const optimisticSession = isDefaultSessionTitle(sendSession.title)
      ? { ...sendSession, title: deriveSessionTitle(visibleText, t) }
      : sendSession;
    if (optimisticSession !== sendSession) {
      optimisticSessionTitlesRef.current.set(sendSession.id, optimisticSession.title);
      setSessions((current) => current.map((session) => session.id === sendSession.id ? optimisticSession : session));
      await sessionStore.rename(sendSession.id, optimisticSession.title);
    }
    await dispatchTurn(sendSession.id, turnInput, "composer-send");
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
          setTimelineError(tinyOsCapabilities.capabilities.agent.retry.reason || t("runtime.failedTurnRetryUnavailable"));
          return;
        }
        const failedItem = retryItemId
          ? (turn.executionItems ?? turn.steps).find((step) => step.id === retryItemId && step.status === "failed")
          : [...(turn.executionItems ?? turn.steps)].reverse().find((step) => step.status === "failed");
        if (!failedItem) {
          setTimelineError(t("runtime.failedItemUnavailable"));
          return;
        }
        const command = createTinyOsOperationRetryCommand({
          itemId: failedItem.id,
          sessionId: activeSession.id,
          source: { control: surface === "tinyos" ? "operation-shelf" : "error-recovery", surface },
          threadId: turn.canonicalItems?.find((item) => item.threadId)?.threadId,
          turnId: turn.id,
        });
        setTimelineError("");
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
    input: QueuedInput,
    turnInput: ChatInput,
  ) {
    setQueueMessage("");
    updateQueuedInputsBySession((current) => {
      const next = new Map(current);
      next.set(sessionId, [...(next.get(sessionId) ?? []), {
        ...input,
        turnInput,
      }]);
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
      setTimelineError(`Cannot cancel: ${cancelUnavailableReason}`);
      return;
    }
    if (!activeTurn) {
      setTimelineError(t("runtime.cancelActiveTurnUnavailable"));
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

  async function handleQueueStateAfterChatEvent(sessionId: string, event: ChatEvent) {
    const nextSessions = await handleSessionStoreRefresh();
    if (isTerminalAgentEvent(event) && await sendPendingInterruptInput(sessionId, true)) {
      return;
    }
    if (shouldPauseQueuedInputsForChatEvent(event)) {
      pauseQueuedInputsForSession(sessionId);
      return;
    }
    if (!shouldDispatchQueuedInputForChatEvent(event)) {
      return;
    }
    const nextSession = nextSessions.find((session) => session.id === sessionId);
    if (!canDispatchQueuedInputForSession(nextSession)) {
      return;
    }
    await sendNextQueuedInput(sessionId, "normal_completion");
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
      setTimelineError(t("runtime.submitFormTurnUnavailable"));
      return;
    }
    const formTurnId = agentUiFormCorrelationString(form, "turn_id") || form.turn_id || activeTurn.id;
    if (formTurnId !== activeTurn.id) {
      setTimelineError(t("runtime.submitFormStaleTurn", { turnId: formTurnId }));
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
    setTimelineError("");
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
      setTimelineError(t("runtime.cancelFormTurnUnavailable"));
      return;
    }
    const formTurnId = agentUiFormCorrelationString(form, "turn_id") || form.turn_id || activeTurn.id;
    if (formTurnId !== activeTurn.id) {
      setTimelineError(t("runtime.cancelFormStaleTurn", { turnId: formTurnId }));
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
    setTimelineError("");
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
      setTimelineError(t(kind === "agent.pause" ? "runtime.cannotPause" : "runtime.cannotResume", { reason: unavailableReason }));
      return;
    }
    if (!activeTurn) {
      setTimelineError(t(kind === "agent.pause" ? "runtime.pauseTurnUnavailable" : "runtime.resumeTurnUnavailable"));
      return;
    }
    const command = createTinyOsAgentTurnControlCommand({
      kind,
      sessionId: activeSession.id,
      source: { control: surface === "tinyos" ? `system-bar-${kind.slice("agent.".length)}` : `chat-${kind.slice("agent.".length)}`, surface },
      threadId: activeTurn.canonicalItems?.find((item) => item.threadId)?.threadId,
      turnId: activeTurn.id,
    });
    setTimelineError("");
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

  function handleSessionSearchSelect(session: SessionSummary) {
    dispatchDelete({ type: "session-selected", sessionId: session.id });
    dispatchSessionTabs({ type: "open", sessionId: session.id });
    setSessionSearchOpen(false);
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

  function renderSidebarSessionRow(session: SessionSummary, index: number) {
    const confirming = deleteState.confirmingSessionId === session.id;
    const dissolving = dissolvingSessionIds.has(session.id);
    return (
      <div
        className="react-session-row"
        data-active={session.id === activeSession?.id}
        data-confirming={confirming}
        data-dissolving={dissolving ? "true" : undefined}
        data-motion-role="item"
        key={session.id}
        onMouseLeave={() => dispatchDelete({ type: "row-left", sessionId: session.id })}
        style={{ "--react-session-row-index": String(index) } as CSSProperties}
      >
        <button
          aria-label={session.title}
          className="react-session-row__select"
          type="button"
          disabled={dissolving}
          onClick={() => {
            dispatchDelete({ type: "session-selected", sessionId: session.id });
            dispatchSessionTabs({ type: "open", sessionId: session.id });
          }}
        >
          <span className="react-session-row__title">{displaySessionTitle(session.title, t)}</span>
          <small>{formatRelativeUpdatedTime(session.updatedAtMs, now())}</small>
        </button>
        <button
          aria-label={t(confirming ? "shell.confirmDelete" : "shell.delete", { name: session.title })}
          className="react-session-row__delete"
          data-confirming={confirming}
          type="button"
          disabled={dissolving}
          onClick={() => void handleDeleteSession(session)}
        >
          <Trash2 aria-hidden="true" size={15} />
        </button>
      </div>
    );
  }

  const visibleAgentUiForms = agentUiForms.filter(isVisibleAgentUiForm);
  const interactiveFormIds = new Set(visibleAgentUiForms.map((form) => form.form_id));
  const headerTitle = activeSession ? displaySessionTitle(activeSession.title, t) : draftNewSession ? t("shell.newChat") : t("shell.noSelection");
  const projectDialogGroup = projectDialogGroupId && projectDialogGroupId !== "new"
    ? projectGroups.find((group) => group.projectGroupId === projectDialogGroupId)
    : undefined;

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
      <aside className="react-session-list" aria-label={t("shell.sessions")} data-collapsed={resolvedSessionSidebarCollapsed}>
        <div className="react-session-list__header">
          <div className="react-session-list__title-row">
            <h2>Tinybot</h2>
            <div className="react-session-list__title-actions">
              <div className="react-session-list__workspace-actions" ref={workspaceActionMenuRef}>
                <button
                  aria-expanded={workspaceActionMenuOpen}
                  aria-haspopup="menu"
                  aria-label={t("shell.workspaceActions")}
                  className="react-session-list__add-workspace"
                  disabled={workspacePickerPending || sessionCreatePending}
                  title={t("shell.workspaceActions")}
                  type="button"
                  onClick={() => setWorkspaceActionMenuOpen((open) => !open)}
                >
                  <FolderPlus aria-hidden="true" size={15} />
                </button>
                {workspaceActionMenuOpen ? (
                  <div aria-label={t("shell.workspaceActions")} className="react-session-list__workspace-menu" role="menu">
                    <button
                      role="menuitem"
                      type="button"
                      onClick={() => {
                        setWorkspaceActionMenuOpen(false);
                        void handleAddWorkspace();
                      }}
                    >
                      <FolderPlus aria-hidden="true" size={14} />
                      {t("shell.addWorkspace")}
                    </button>
                    <button
                      disabled={!projectGroupStore}
                      role="menuitem"
                      type="button"
                      onClick={() => {
                        setWorkspaceActionMenuOpen(false);
                        setProjectDialogGroupId("new");
                      }}
                    >
                      <GitBranch aria-hidden="true" size={14} />
                      {t("projectGroups.create")}
                    </button>
                  </div>
                ) : null}
              </div>
              <button
                aria-label={t("shell.searchChats")}
                className="react-session-list__search"
                title={t("shell.searchChats")}
                type="button"
                onClick={() => setSessionSearchOpen(true)}
              >
                <Search aria-hidden="true" size={15} />
              </button>
              <button
                aria-label={resolvedSessionSidebarCollapsed ? t("shell.expandSidebar") : t("shell.collapseSidebar")}
                className="react-session-list__collapse"
                title={resolvedSessionSidebarCollapsed ? t("shell.expandSidebar") : t("shell.collapseSidebar")}
                type="button"
                onClick={() => handleSessionSidebarCollapsedChange(!resolvedSessionSidebarCollapsed)}
              >
                <ChevronLeft aria-hidden="true" data-direction={resolvedSessionSidebarCollapsed ? "expand" : "collapse"} size={16} />
              </button>
            </div>
          </div>
          <button
            aria-label={t("shell.newChat")}
            className="react-session-list__new"
            disabled={sessionCreatePending}
            type="button"
            onClick={() => void handleCreateSession()}
          >
            {sessionCreatePending ? <Loader2 aria-hidden="true" className="react-session-list__pending" size={15} /> : <Plus aria-hidden="true" size={15} />}
            <span>{t("shell.newChat")}</span>
          </button>
          {sessionWorkspaceError ? (
            <p className="react-session-list__error" role="alert">{sessionWorkspaceError}</p>
          ) : null}
        </div>
        <div className="react-session-list__rows" aria-label={t("shell.sessionRows")} data-motion="animated-list">
          {projectProjection.groups.map((projectGroup) => {
            const projectSessions = [
              ...projectGroup.coordinatorSessions,
              ...projectGroup.workspaces.flatMap((workspace) => workspace.sessions),
            ];
            return (
              <details
                aria-label={t("projectGroups.groupLabel", { name: projectGroup.project.name })}
                className="react-project-group"
                data-active={projectSessions.some((session) => session.id === activeSession?.id) ? "true" : undefined}
                key={projectGroup.project.projectGroupId}
                open
                role="group"
              >
                <summary title={projectGroup.project.name}>
                  <ChevronRight aria-hidden="true" className="react-project-group__chevron" size={14} />
                  <GitBranch aria-hidden="true" className="react-project-group__icon" size={15} />
                  <strong>{projectGroup.project.name}</strong>
                </summary>
                <div className="react-project-group__actions">
                  <button
                    aria-label={t("projectGroups.newCoordinator", { name: projectGroup.project.name })}
                    disabled={sessionCreatePending}
                    onClick={() => handleCreateCoordinatorSession(projectGroup.project)}
                    title={t("projectGroups.newCoordinator", { name: projectGroup.project.name })}
                    type="button"
                  >
                    <Plus aria-hidden="true" size={14} />
                  </button>
                  <button
                    aria-label={t("projectGroups.edit", { name: projectGroup.project.name })}
                    onClick={() => setProjectDialogGroupId(projectGroup.project.projectGroupId)}
                    title={t("projectGroups.edit", { name: projectGroup.project.name })}
                    type="button"
                  >
                    <MoreHorizontal aria-hidden="true" size={15} />
                  </button>
                </div>
                <div className="react-project-group__content">
                  {projectGroup.coordinatorSessions.length ? (
                    <section className="react-project-group__coordinators">
                      <div className="react-project-group__member-title">
                        <GitBranch aria-hidden="true" size={13} />
                        <span>{t("projectGroups.coordination")}</span>
                      </div>
                      {projectGroup.coordinatorSessions.map(renderSidebarSessionRow)}
                    </section>
                  ) : null}
                  {projectGroup.workspaces.map((workspace) => (
                    <section className="react-project-workspace" key={workspace.workspaceId}>
                      <div className="react-project-group__member-title" title={workspace.workspaceId}>
                        <Folder aria-hidden="true" size={13} />
                        <span>
                          <strong>{workspace.label}</strong>
                          <small>{workspace.workspaceId}</small>
                        </span>
                        <button
                          aria-label={t("projectGroups.newWorkspaceSession", { name: workspace.label })}
                          disabled={sessionCreatePending}
                          onClick={() => void handleCreateSession(workspace.workspaceId, {
                            projectGroupId: projectGroup.project.projectGroupId,
                          })}
                          title={t("projectGroups.newWorkspaceSession", { name: workspace.label })}
                          type="button"
                        >
                          <Plus aria-hidden="true" size={13} />
                        </button>
                      </div>
                      <div className="react-project-workspace__sessions">
                        {workspace.sessions.map(renderSidebarSessionRow)}
                      </div>
                    </section>
                  ))}
                </div>
              </details>
            );
          })}
          {sessionWorkspaces.length ? sessionWorkspaces.map((workspace) => (
            <details
              aria-label={t("shell.workspace", { name: workspace.label })}
              className="react-session-workspace"
              data-active={workspace.sessions.some((session) => session.id === activeSession?.id) ? "true" : undefined}
              key={workspace.key}
              open
              role="group"
            >
              <summary title={workspace.workingDirectory ?? workspace.label}>
                <ChevronRight aria-hidden="true" className="react-session-workspace__chevron" size={14} />
                <span aria-hidden="true" className="react-session-workspace__folder">
                  <Folder className="react-session-workspace__folder-icon--collapsed" size={15} />
                  <FolderOpen className="react-session-workspace__folder-icon--expanded" size={15} />
                </span>
                <span className="react-session-workspace__copy">
                  <strong>{workspace.label}</strong>
                  {workspace.workingDirectory ? <small>{workspace.workingDirectory}</small> : null}
                </span>
              </summary>
              <button
                aria-label={t("shell.newSessionIn", { name: workspace.label })}
                className="react-session-workspace__new"
                disabled={sessionCreatePending}
                title={t("shell.newSessionIn", { name: workspace.label })}
                type="button"
                onClick={() => void handleCreateSession(workspace.workingDirectory)}
              >
                <Plus aria-hidden="true" size={15} />
              </button>
              <div className="react-session-workspace__sessions">
                {workspace.sessions.map(renderSidebarSessionRow)}
              </div>
            </details>
          )) : null}
          {!projectProjection.groups.length && !sessionWorkspaces.length && !resolvedSessionSidebarCollapsed
            ? <EmptyStateText text={t("shell.noSessions")} />
            : null}
        </div>
      </aside>

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
          {timelineError ? <p aria-live="assertive" className="react-timeline-error">{timelineError}</p> : null}
          {activeSession && timeline?.turns.length ? timeline.turns.map((turn) => (
            <CanonicalChatTurn
              interactiveFormIds={interactiveFormIds}
              key={turn.id}
              turn={turn}
              onBranch={(messageId) => void handleBranchFromMessage(activeSession, messageId)}
              onOpenArtifact={(artifact) => void handleOpenArtifact(artifact)}
              onOpenLiveCanvas={(step) => openLiveCanvasItem(turn.id, step)}
              onOpenSubagent={(delegate) => void handleOpenSubagent(delegate)}
              onOpenTool={(toolCall) => setDrawer({ kind: "tool", title: toolCall.name, toolCall })}
              focusError={turn.id === latestFailedTurnId}
              recovering={recoveringTurnId === turn.id}
              onOpenError={(step) => setDrawer({ kind: "error", title: t("shell.errorDetails"), step, turn })}
              onRecover={(action) => void handleRecoverTurn(turn, action)}
            />
          )) : emptyActiveSession ? <EmptyChatStart onSelectPrompt={handleComposerDraftChange} /> : activeSession ? null : <EmptyStateText text={t("shell.selectSession")} />}
          {optimisticMessages.map((message) => (
            <MessageBubble
              key={message.id}
              message={message}
              onBranch={() => undefined}
              onCopy={() => void writeClipboardText(formatMessageForCopy(message))}
              onOpenTool={() => undefined}
              sessionRunning={sessionRunning}
            />
          ))}
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
                setTimelineError(t("errors.modelSaveFailed", { message: error instanceof Error ? error.message : String(error) }));
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
              <ErrorDetails step={drawer.step} turn={drawer.turn} />
            )}
          </div>
        </aside>
      ) : null}

      {sessionSearchOpen ? (
        <SessionSearchDialog
          activeSessionId={activeSession?.id ?? ""}
          now={now}
          sessions={sessions}
          onClose={() => setSessionSearchOpen(false)}
          onCreateSession={() => void handleCreateSessionFromSearch()}
          onOpenFiles={onOpenFiles}
          onOpenSettings={onOpenSettings}
          onSelectSession={handleSessionSearchSelect}
        />
      ) : null}
      {projectDialogGroupId ? (
        <ProjectGroupDialog
          availableWorkspaceIds={availableProjectWorkspaceIds}
          group={projectDialogGroup}
          onChooseWorkspace={handleChooseProjectWorkspace}
          onClose={() => setProjectDialogGroupId(undefined)}
          onDelete={projectDialogGroup ? handleDeleteProjectGroup : undefined}
          onSave={handleSaveProjectGroup}
        />
      ) : null}
    </section>
  );
}

function SessionSearchDialog({
  activeSessionId,
  now,
  onClose,
  onCreateSession,
  onOpenFiles,
  onOpenSettings,
  onSelectSession,
  sessions,
}: {
  activeSessionId: string;
  now: () => number;
  onClose: () => void;
  onCreateSession: () => void;
  onOpenFiles?: () => void;
  onOpenSettings?: () => void;
  onSelectSession: (session: SessionSummary) => void;
  sessions: SessionSummary[];
}) {
  const { i18n, t } = useTranslation("chat");
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const filteredSessions = normalizedQuery
    ? sessions.filter((session) => [session.title, session.chatId ?? "", session.id, session.workingDirectory ?? ""]
      .some((value) => value.toLowerCase().includes(normalizedQuery)))
    : sessions;
  const recommendations = [
    {
      id: "new-chat",
      label: t("shell.newChat"),
      shortcut: "Ctrl+N",
      icon: Plus,
      run: onCreateSession,
    },
    ...(onOpenFiles ? [{
      id: "open-files",
      label: t("search.openFolder"),
      shortcut: "Ctrl+O",
      icon: FolderOpen,
      run: () => {
        onOpenFiles();
        onClose();
      },
    }] : []),
    ...(onOpenSettings ? [{
      id: "open-settings",
      label: t("search.settings"),
      shortcut: "Ctrl+,",
      icon: Settings,
      run: () => {
        onOpenSettings();
        onClose();
      },
    }] : []),
  ];

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="react-command-palette-backdrop react-session-search-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <section aria-label={t("search.label")} className="react-command-palette react-session-search-dialog" role="dialog">
        <div className="react-session-search__input-row">
          <Search aria-hidden="true" size={18} />
          <input
            aria-label={t("search.placeholder")}
            autoFocus
            placeholder={t("search.placeholder")}
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </div>
        <div className="react-session-search__section">
          <p>{t("search.chats")}</p>
          <div className="react-session-search__list">
            {filteredSessions.length ? filteredSessions.map((session, index) => (
              <button
                aria-current={session.id === activeSessionId ? "page" : undefined}
                className="react-session-search__item"
                key={session.id}
                type="button"
                onClick={() => onSelectSession(session)}
              >
                <span className="react-session-search__rank">{index + 1}</span>
                <span className="react-session-search__title">{session.title}</span>
                <span className="react-session-search__meta">
                  {session.workingDirectory ? sessionWorkspaceName(session.workingDirectory) : t("search.regular")}
                </span>
                <kbd>{`Ctrl+${index + 1}`}</kbd>
                <small>{formatRelativeUpdatedTime(session.updatedAtMs, now(), i18n.language, t("search.noDate"))}</small>
              </button>
            )) : <span className="react-session-search__empty">{t("search.noMatches")}</span>}
          </div>
        </div>
        <div className="react-session-search__section">
          <p>{t("search.suggested")}</p>
          <div className="react-session-search__list">
            {recommendations.map((recommendation) => {
              const Icon = recommendation.icon;
              return (
                <button className="react-session-search__item" key={recommendation.id} type="button" onClick={recommendation.run}>
                  <Icon aria-hidden="true" size={17} />
                  <span className="react-session-search__title">{recommendation.label}</span>
                  <kbd>{recommendation.shortcut}</kbd>
                </button>
              );
            })}
          </div>
        </div>
      </section>
    </div>
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
  return (
    <p className="react-empty-state">
      <TextType ariaLabel={text} className="react-text-type" loop={false} showCursor={false} text={text} />
    </p>
  );
}

const MESSAGE_RELOAD_EVENT_TYPES = new Set([
  "attached",
]);

const SESSION_RELOAD_EVENT_TYPES = new Set([
  "chat.created",
  "interrupted",
]);

const TERMINAL_AGENT_EVENT_TYPES = new Set([
  "agent.turn.completed",
  "agent.turn.failed",
  "agent.turn.interrupted",
]);

function shouldReloadMessagesForChatEvent(type: string): boolean {
  return MESSAGE_RELOAD_EVENT_TYPES.has(type);
}

function shouldReloadSessionsForChatEvent(event: ChatEvent): boolean {
  return SESSION_RELOAD_EVENT_TYPES.has(event.type)
    || (event.type === "agent.event" && Boolean(event.eventType && TERMINAL_AGENT_EVENT_TYPES.has(event.eventType)));
}

function shouldReloadAgentUiFormsForChatEvent(type: string): boolean {
  return type === "agent-ui.form" || type === "agent-ui.event";
}

function isBackgroundTabActivityEvent(event: ChatEvent): boolean {
  return Boolean(
    event.error
    || event.timeline
    || (event.type === "agent.event" && event.eventType && TERMINAL_AGENT_EVENT_TYPES.has(event.eventType)),
  );
}

function sessionStatusFromTimeline(timeline: ChatTimelineSnapshot): SessionSummary["status"] | undefined {
  const status = timeline.turns[timeline.turns.length - 1]?.status;
  if (status === "pending" || status === "running" || status === "awaiting_user") {
    return "running";
  }
  if (status === "failed" || status === "interrupted") {
    return "failed";
  }
  if (status === "completed") {
    return "idle";
  }
  return undefined;
}

function shouldDispatchQueuedInputForChatEvent(event: ChatEvent): boolean {
  return event.type === "agent.event" && event.eventType === "agent.turn.completed";
}

function isTerminalAgentEvent(event: ChatEvent): boolean {
  return event.type === "agent.event" && Boolean(event.eventType && TERMINAL_AGENT_EVENT_TYPES.has(event.eventType));
}

function shouldPauseQueuedInputsForChatEvent(event: ChatEvent): boolean {
  return event.type === "interrupted"
    || (event.type === "agent.event" && (
      event.eventType === "agent.turn.failed" || event.eventType === "agent.turn.interrupted"
    ));
}

function canDispatchQueuedInputForSession(session: SessionSummary | undefined): boolean {
  return session?.status !== "running" && session?.status !== "failed";
}

function latestTimelineUsage(
  turns: ChatTurn[],
  defaults: ContextUsageDefaults = {},
): TokenUsage | undefined {
  let latestCompactedTokens: number | undefined;
  let latestCompactionStrategy: string | undefined;
  for (const turn of [...turns].reverse()) {
    if (turn.usage) {
      if (latestCompactedTokens === undefined || turn.usage.contextWindowTokens === undefined) {
        return turn.usage;
      }
      return usageAfterCompaction(
        latestCompactedTokens,
        turn.usage.contextWindowTokens,
        latestCompactionStrategy,
        turn.usage,
      );
    }
    const compaction = [...turn.steps]
      .reverse()
      .find((step) => step.kind === "compaction" && step.compaction?.estimatedTokensAfter !== undefined)
      ?.compaction;
    latestCompactedTokens ??= compaction?.estimatedTokensAfter;
    latestCompactionStrategy ??= compaction?.strategy;
    if (latestCompactedTokens !== undefined && compaction?.contextWindowTokens !== undefined) {
      return usageAfterCompaction(
        latestCompactedTokens,
        compaction.contextWindowTokens,
        latestCompactionStrategy,
      );
    }
  }
  if (latestCompactedTokens !== undefined && defaults.contextWindowTokens !== undefined) {
    return usageAfterCompaction(
      latestCompactedTokens,
      defaults.contextWindowTokens,
      latestCompactionStrategy ?? defaults.contextWindowStrategy,
    );
  }
  return undefined;
}

function usageAfterCompaction(
  estimatedTokensAfter: number,
  contextWindowTokens: number,
  contextWindowStrategy?: string,
  previousUsage: TokenUsage = {},
): TokenUsage {
  const contextWindowUsedTokens = Math.min(estimatedTokensAfter, contextWindowTokens);
  return {
    ...previousUsage,
    contextWindowRemainingTokens: Math.max(0, contextWindowTokens - contextWindowUsedTokens),
    ...(contextWindowStrategy ? { contextWindowStrategy } : {}),
    contextWindowTokens,
    contextWindowUsedTokens,
    percent: contextWindowTokens > 0 ? (contextWindowUsedTokens / contextWindowTokens) * 100 : 0,
  };
}

function isQueueableRunningSession(session: SessionSummary, emptyActiveSession: boolean): boolean {
  return session.status === "running" && !emptyActiveSession && !session.id.startsWith("pending:");
}

function toChatInput(input: QueuedComposerInput): ChatInput {
  return input.turnInput;
}

function createComposerChatInput(
  text: string,
  options: ComposerSendOptions,
  references: AgentInputReference[],
): ChatInput {
  return {
    text,
    ...(options.model ? { model: options.model } : {}),
    ...(options.provider ? { provider: options.provider } : {}),
    ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
    ...(references.length ? { references } : {}),
  };
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

function tinyOsReferenceLabel(reference: TinyOsContextReference, t: TFunction<"chat">): string {
  const lineRange = reference.startLine
    ? `L${reference.startLine}${reference.endLine && reference.endLine !== reference.startLine ? `–${reference.endLine}` : ""}`
    : t("references.selection");
  return reference.kind === "file" ? `${reference.path} · ${lineRange}` : `${reference.command} · ${lineRange}`;
}

function composerReferenceFromTinyOs(reference: TinyOsContextReference, t: TFunction<"chat">): ComposerContextReference {
  return {
    detail: reference.kind === "file" ? t("references.fileSelection") : t("references.terminalOutput"),
    id: tinyOsContextReferenceId(reference),
    kind: reference.kind,
    label: tinyOsReferenceLabel(reference, t),
  };
}

function nativeReferenceFromTinyOs(reference: TinyOsAgentRequestReference, t: TFunction<"chat">): AgentInputReference {
  const canonical = reference.kind === "file"
    ? reference.provenance.kind === "canonical" ? reference.provenance : undefined
    : { sourceItemId: reference.sourceItemId, turnId: reference.turnId };
  const scope = canonical?.turnId ?? (reference.kind === "file" && reference.provenance.kind === "workspace_read" ? reference.provenance.workspaceKey : undefined);
  const detail = reference.kind === "file"
    ? t("references.fileSelection")
    : reference.kind === "terminal" ? t("references.terminalSelection") : t("references.planSnapshot");
  const title = reference.kind === "plan" ? t("references.executionPlan") : tinyOsReferenceLabel(reference, t);
  return {
    detail,
    evidenceId: canonical?.sourceItemId,
    kind: "reference",
    scope,
    sourceEndLine: reference.kind === "plan" ? undefined : reference.endLine,
    sourceLine: reference.kind === "plan" ? undefined : reference.startLine,
    sourceText: reference.kind === "plan" ? reference.snapshotText : reference.selectedText,
    title,
    type: `tinyos.${reference.kind}`,
    ...(reference.kind === "file" ? {
      rawLine: reference.startLine,
      rawPath: reference.path,
      revision: reference.revision,
      sourcePath: reference.path,
    } : {}),
  };
}

function nativeReferenceFromComposerFile(file: ComposerFileReference): AgentInputReference {
  return {
    detail: formatFileMetadata(file.mimeType, file.sizeBytes),
    kind: "reference",
    rawPath: file.path,
    title: file.name,
    type: "tinyos.file",
  };
}

async function nativeReferencesFromComposerSessions(
  sessions: SessionSummary[],
  loadTranscript: (sessionId: string) => Promise<string>,
  t: TFunction<"chat">,
): Promise<AgentInputReference[]> {
  const selected = sessions.slice(0, MAX_COMPOSER_SESSION_REFERENCES);
  if (!selected.length) return [];
  const transcriptBudget = Math.floor(MAX_COMPOSER_SESSION_CONTEXT_BYTES / selected.length);
  return Promise.all(selected.map(async (session) => {
    let transcript: string;
    try {
      transcript = await loadTranscript(session.id);
    } catch (error) {
      console.error("[chat] composer.session_reference.load_failed", {
        error: error instanceof Error ? error.message : String(error),
        sessionId: session.id,
      });
      throw error;
    }
    return {
      detail: t("composer.sessionMention.referenceDetail"),
      kind: "reference" as const,
      revision: String(session.updatedAtMs),
      scope: session.id,
      sourceText: truncateUtf8Middle(
        transcript || t("composer.sessionMention.emptyTranscript"),
        transcriptBudget,
      ),
      title: displaySessionTitle(session.title, t),
      type: "tinyos.thread",
    };
  }));
}

function truncateUtf8Middle(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maxBytes) return value;
  const markerBytes = encoder.encode(SESSION_TRANSCRIPT_OMISSION).byteLength;
  const contentBudget = Math.max(0, maxBytes - markerBytes);
  const prefixBudget = Math.floor(contentBudget / 3);
  const suffixBudget = contentBudget - prefixBudget;
  return `${utf8Prefix(value, prefixBudget, encoder)}${SESSION_TRANSCRIPT_OMISSION}${utf8Suffix(value, suffixBudget, encoder)}`;
}

function utf8Prefix(value: string, maxBytes: number, encoder: TextEncoder): string {
  let output = "";
  let bytes = 0;
  for (const character of value) {
    const nextBytes = encoder.encode(character).byteLength;
    if (bytes + nextBytes > maxBytes) break;
    output += character;
    bytes += nextBytes;
  }
  return output;
}

function utf8Suffix(value: string, maxBytes: number, encoder: TextEncoder): string {
  const output: string[] = [];
  let bytes = 0;
  for (const character of Array.from(value).reverse()) {
    const nextBytes = encoder.encode(character).byteLength;
    if (bytes + nextBytes > maxBytes) break;
    output.push(character);
    bytes += nextBytes;
  }
  return output.reverse().join("");
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

function formatComposerMessage(message: string, pastedContent: PastedContent[], t: TFunction<"chat">): string {
  const segments = [message.trim()].filter(Boolean);
  for (const pasted of pastedContent) {
    segments.push(`${t("composer.pastedContentLabel")}:\n${pasted.content}`);
  }
  return segments.join("\n\n");
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

function CanonicalChatTurn({
  focusError,
  interactiveFormIds,
  onBranch,
  onOpenError,
  onOpenArtifact,
  onOpenLiveCanvas,
  onRecover,
  onOpenSubagent,
  onOpenTool,
  recovering,
  turn,
}: {
  focusError: boolean;
  interactiveFormIds: ReadonlySet<string>;
  onBranch: (messageId: string) => void;
  onOpenError: (step: ChatStep) => void;
  onOpenArtifact: (artifact: ArtifactRef) => void;
  onOpenLiveCanvas: (step: ChatStep) => void;
  onRecover: (action: RecoveryAction) => void;
  onOpenSubagent: (delegate: DelegatedAgentState) => void;
  onOpenTool: (toolCall: ToolCallSummary) => void;
  recovering: boolean;
  turn: ChatTurn;
}) {
  const { t } = useTranslation("chat");
  const executionItems = turn.executionItems ?? turn.steps;
  const finalAnswer = turn.finalAnswer ?? turn.finalMessage;
  const reasoningSteps = turn.steps.filter((step) => step.kind === "reasoning");
  const planSteps = turn.steps.filter((step) => step.kind === "plan");
  const errorSteps = turn.status === "interrupted"
    ? []
    : turn.steps.filter((step) => step.kind === "error");
  const legacyProcessSteps = turn.steps.filter((step) => (
    step.kind !== "reasoning"
    && step.kind !== "plan"
    && step.kind !== "error"
    && !(step.kind === "form" && step.form && interactiveFormIds.has(step.form.formId))
  ));
  const dataViewArtifacts = uniqueArtifacts(executionItems.flatMap((step) => step.artifacts ?? []))
    .filter((artifact) => artifact.kind === "data_view");
  const hasUserMessage = Boolean(turn.userMessage.text.trim() || turn.userMessage.references?.length);
  return (
    <section aria-label={t("turn.label")} className="react-canonical-turn" data-status={turn.status}>
      {hasUserMessage ? (
        <CanonicalMessage
          messageId={turn.userMessage.id}
          references={turn.userMessage.references}
          role="user"
          text={turn.userMessage.text}
        />
      ) : null}
      {turn.executionItems && executionItems.length ? (
        <ExecutionTimeline
          executionItems={executionItems}
          focusError={focusError}
          onOpenArtifact={onOpenArtifact}
          onOpenError={onOpenError}
          onOpenLiveCanvas={onOpenLiveCanvas}
          onOpenSubagent={onOpenSubagent}
          onOpenTool={onOpenTool}
          onRecover={onRecover}
          recovering={recovering}
          turn={turn}
        />
      ) : !turn.executionItems ? (
        <>
          {planSteps.map((step) => (
            <CanonicalChatStep key={step.id} onOpenArtifact={onOpenArtifact} onOpenSubagent={onOpenSubagent} onOpenTool={onOpenTool} step={step} />
          ))}
          {groupCanonicalSteps(legacyProcessSteps).map((group) => (
            Array.isArray(group) ? (
              <div className="react-canonical-tool-group" key={group.map((step) => step.id).join(":")}>
                <AgentSteps onOpenTool={onOpenTool} toolCalls={group.map((step) => toolCallSummaryFromStep(step, step.toolCall!, t))} />
                <CanonicalArtifacts artifacts={group.flatMap((step) => step.artifacts ?? [])} onOpen={onOpenArtifact} />
                <CanonicalScopedErrors errors={group.flatMap((step) => step.scopedErrors ?? [])} />
              </div>
            ) : (
              <CanonicalChatStep key={group.id} onOpenArtifact={onOpenArtifact} onOpenSubagent={onOpenSubagent} onOpenTool={onOpenTool} step={group} />
            )
          ))}
          {errorSteps.map((step, index) => (
            <ErrorRecoveryCard
              focusOnMount={focusError && index === errorSteps.length - 1}
              key={step.id}
              recovering={recovering}
              step={step}
              turn={turn}
              onOpenDetails={() => onOpenError(step)}
              onRecover={onRecover}
            />
          ))}
        </>
      ) : null}
      {finalAnswer ? (
        <CanonicalMessage
          allowActions={turn.status === "completed"}
          messageId={finalAnswer.id}
          reasoning={turn.executionItems ? [] : reasoningSteps}
          references={finalAnswer.references}
          role="assistant"
          streaming={turn.status === "running"}
          text={finalAnswer.text}
          onBranch={turn.status === "completed" ? () => onBranch(finalAnswer.id) : undefined}
        />
      ) : !turn.executionItems && reasoningSteps.length ? (
        <CanonicalMessage
          allowActions={false}
          messageId={reasoningSteps[reasoningSteps.length - 1]?.messageId || reasoningSteps[reasoningSteps.length - 1]?.id || turn.id}
          reasoning={reasoningSteps}
          role="assistant"
          streaming={turn.status === "running"}
          text=""
        />
      ) : null}
      {dataViewArtifacts.map((artifact) => (
        <DataViewCard artifact={artifact} key={artifact.id} onOpen={onOpenArtifact} />
      ))}
    </section>
  );
}

function groupCanonicalSteps(steps: ChatStep[]): Array<ChatStep | ChatStep[]> {
  const groups: Array<ChatStep | ChatStep[]> = [];
  for (const step of steps) {
    if (step.kind !== "tool_call" || !step.toolCall) {
      groups.push(step);
      continue;
    }
    const previous = groups[groups.length - 1];
    if (Array.isArray(previous)) {
      previous.push(step);
    } else {
      groups.push([step]);
    }
  }
  return groups;
}

type ExecutionFoldIntent = "untouched" | "user_open" | "user_closed";

function ExecutionTimeline({
  executionItems,
  focusError,
  onOpenArtifact,
  onOpenError,
  onOpenLiveCanvas,
  onOpenSubagent,
  onOpenTool,
  onRecover,
  recovering,
  turn,
}: {
  executionItems: ChatStep[];
  focusError: boolean;
  onOpenArtifact: (artifact: ArtifactRef) => void;
  onOpenError: (step: ChatStep) => void;
  onOpenLiveCanvas: (step: ChatStep) => void;
  onOpenSubagent: (delegate: DelegatedAgentState) => void;
  onOpenTool: (toolCall: ToolCallSummary) => void;
  onRecover: (action: RecoveryAction) => void;
  recovering: boolean;
  turn: ChatTurn;
}) {
  const { t } = useTranslation("chat");
  const contentId = useId();
  const timelineRef = useRef<HTMLElement | null>(null);
  const abnormal = executionItems.some((step) => step.status === "failed" || step.status === "cancelled" || step.status === "blocked")
    || turn.status === "failed"
    || turn.status === "interrupted"
    || turn.status === "awaiting_user";
  const hasFinalAnswer = Boolean(turn.finalAnswer ?? turn.finalMessage);
  const [foldIntent, setFoldIntent] = useState<ExecutionFoldIntent>("untouched");
  const [open, setOpen] = useState(() => abnormal || !hasFinalAnswer);
  const visibleExecutionItems = turn.status === "interrupted"
    ? executionItems.filter((step) => step.kind !== "error")
    : executionItems;
  const errorItems = visibleExecutionItems.filter((step) => step.kind === "error");

  useEffect(() => {
    if (foldIntent !== "untouched") {
      return;
    }
    const nextOpen = abnormal || !hasFinalAnswer;
    setOpen((currentOpen) => {
      if (currentOpen === nextOpen) {
        return currentOpen;
      }
      if (currentOpen && !nextOpen) {
        const timeline = timelineRef.current;
        const scroller = timeline?.closest<HTMLElement>(".react-conversation-view");
        const heightBefore = timeline?.getBoundingClientRect().height ?? 0;
        const timelineTop = timeline?.getBoundingClientRect().top ?? 0;
        const scrollerTop = scroller?.getBoundingClientRect().top ?? 0;
        const userIsReadingHistory = Boolean(scroller && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight >= 96);
        requestAnimationFrame(() => {
          if (!timeline || !scroller || !userIsReadingHistory || timelineTop >= scrollerTop) {
            return;
          }
          const collapsedBy = Math.max(0, heightBefore - timeline.getBoundingClientRect().height);
          scroller.scrollTop = Math.max(0, scroller.scrollTop - collapsedBy);
        });
      }
      return nextOpen;
    });
  }, [abnormal, foldIntent, hasFinalAnswer]);

  const summary = executionTimelineSummary(turn, executionItems, abnormal, t);
  return (
    <section className="react-execution-timeline" data-abnormal={abnormal ? "true" : undefined} ref={timelineRef}>
      <button
        aria-controls={contentId}
        aria-expanded={open}
        className="react-execution-timeline__trigger"
        type="button"
        onClick={() => {
          setOpen((currentOpen) => {
            setFoldIntent(currentOpen ? "user_closed" : "user_open");
            return !currentOpen;
          });
        }}
      >
        <span className="react-execution-timeline__status"><Activity aria-hidden="true" size={17} /></span>
        <span className="react-execution-timeline__heading">
          <strong>{t("turn.workPerformed")}</strong>
          <small aria-live="polite">{summary}</small>
        </span>
        <ChevronDown aria-hidden="true" className="react-execution-timeline__chevron" size={18} />
      </button>
      <div className="react-execution-timeline__content" hidden={!open} id={contentId}>
        {visibleExecutionItems.map((step) => (
          <div className="react-execution-timeline__item" data-kind={step.kind} data-status={step.status} key={step.id}>
            {step.kind === "tool_call" ? null : (
              <button
                aria-label={t("turn.viewTinyOs", { name: step.title })}
                className="react-execution-timeline__canvas-button"
                title={t("turn.viewInTinyOs")}
                type="button"
                onClick={() => onOpenLiveCanvas(step)}
              >
                <PanelRightOpen aria-hidden="true" size={15} />
              </button>
            )}
            {step.kind === "error" ? (
              <ErrorRecoveryCard
                focusOnMount={focusError && step.id === errorItems[errorItems.length - 1]?.id}
                recovering={recovering}
                step={step}
                turn={turn}
                onOpenDetails={() => onOpenError(step)}
                onRecover={onRecover}
              />
            ) : (
              <CanonicalChatStep
                onOpenArtifact={onOpenArtifact}
                onOpenLiveCanvas={onOpenLiveCanvas}
                onOpenSubagent={onOpenSubagent}
                onOpenTool={onOpenTool}
                step={step}
              />
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function executionTimelineSummary(turn: ChatTurn, items: ChatStep[], abnormal: boolean, t: TFunction<"chat">): string {
  const plan = [...items].reverse().find((step) => step.plan)?.plan;
  const durationMs = turn.completedAt
    ? Math.max(0, Date.parse(turn.completedAt) - Date.parse(turn.startedAt))
    : undefined;
  const parts = [executionStatusLabel(turn.status, t), t("execution.actionCount", { count: items.length })];
  if (plan) {
    parts.push(t("execution.plan", { completed: plan.completed, total: plan.total }));
  }
  if (durationMs !== undefined && Number.isFinite(durationMs)) {
    parts.push(formatExecutionDuration(durationMs));
  }
  if (abnormal) {
    const blocked = items.find((step) => step.status === "failed" || step.status === "cancelled" || step.status === "blocked");
    parts.push(blocked?.title || t("execution.attention"));
  }
  return parts.join(" · ");
}

function executionStatusLabel(status: ChatTurn["status"], t: TFunction<"chat">): string {
  switch (status) {
    case "completed": return t("execution.status.completed");
    case "failed": return t("execution.status.failed");
    case "interrupted": return t("execution.status.interrupted");
    case "awaiting_user": return t("execution.status.awaiting");
    default: return t("execution.status.running");
  }
}

function formatExecutionDuration(durationMs: number): string {
  if (durationMs < 1_000) {
    return `${Math.round(durationMs)}ms`;
  }
  if (durationMs < 60_000) {
    return `${Math.round(durationMs / 1_000)}s`;
  }
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
}

function CanonicalMessage({
  allowActions = true,
  messageId,
  onBranch,
  reasoning = [],
  references = [],
  role,
  streaming = false,
  text,
}: {
  allowActions?: boolean;
  messageId: string;
  onBranch?: () => void;
  reasoning?: ChatStep[];
  references?: AgentInputReference[];
  role: "user" | "assistant";
  streaming?: boolean;
  text: string;
}) {
  const { t } = useTranslation("chat");
  return (
    <article className="react-message" data-actions-placement="bottom" data-role={role} data-testid={`message-${messageId}`}>
      <div className="react-message__body">
        {reasoning.map((step) => (
          <MessageReasoning durationMs={reasoningDurationMs(step)} key={step.id} streaming={step.status === "running"} text={step.summary ?? ""} />
        ))}
        {role === "assistant" ? <AssistantMarkdown streaming={streaming} text={text} /> : <PlainMessageText text={text} />}
        {references?.length ? <MessageContext references={references.map(canonicalReferenceSummary)} /> : null}
        {streaming ? <span aria-label={t("turn.agentResponding")} className="react-message__streaming" /> : null}
      </div>
      {allowActions && text.trim() ? (
        <div className="react-message__actions" data-align={role === "user" ? "right" : "left"}>
          <button aria-label={t("turn.copyMessage")} type="button" onClick={() => void writeClipboardText(text)}>
            <Copy aria-hidden="true" size={14} />
          </button>
          {onBranch ? (
            <button aria-label={t("turn.branchHere")} type="button" onClick={onBranch}>
              <GitBranch aria-hidden="true" size={14} />
            </button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function CanonicalChatStep({
  onOpenArtifact,
  onOpenLiveCanvas,
  onOpenSubagent,
  onOpenTool,
  step,
}: {
  onOpenArtifact: (artifact: ArtifactRef) => void;
  onOpenLiveCanvas?: (step: ChatStep) => void;
  onOpenSubagent: (delegate: DelegatedAgentState) => void;
  onOpenTool: (toolCall: ToolCallSummary) => void;
  step: ChatStep;
}) {
  const { i18n, t } = useTranslation("chat");
  if (step.kind === "reasoning") {
    return <MessageReasoning streaming={step.status === "running"} text={step.summary ?? ""} />;
  }
  if (step.kind === "message") {
    return (
      <CanonicalMessage
        allowActions={step.status === "completed"}
        messageId={step.messageId || step.id}
        role="assistant"
        streaming={step.status === "running"}
        text={step.summary ?? ""}
      />
    );
  }
  if (step.kind === "tool_call" && step.toolCall) {
    if (isApplyPatchToolCall(step.toolCall) && patchChangeSetFromToolResult(step.toolCall.resultJson)?.files.length) {
      return (
        <PatchDiffCard
          status={step.status}
          toolCall={step.toolCall}
          onOpenDetails={() => onOpenTool(toolCallSummaryFromStep(step, step.toolCall!, t))}
        />
      );
    }
    return (
      <ToolActivityItem
        fallbackSummary={step.summary}
        status={step.status}
        toolCall={step.toolCall}
        onOpenDetails={onOpenLiveCanvas
          ? () => onOpenLiveCanvas(step)
          : () => onOpenTool(toolCallSummaryFromStep(step, step.toolCall!, t))}
      />
    );
  }
  if (step.kind === "form" && step.form) {
    const values = canonicalFormEntries(step.form.values);
    const errors = Object.entries(step.form.errors ?? {});
    const resolution = step.form.action === "submit"
      ? t("form.submitted")
      : step.form.action === "cancel"
        ? t("form.cancelled")
        : step.status === "completed"
          ? t("form.resolved")
          : t("form.waiting");
    return (
      <section aria-label={step.title} className="react-canonical-step" data-kind={step.kind} data-status={step.status}>
        <span className="react-canonical-step__icon"><AgentStepIcon status={canonicalStepIconStatus(step)} /></span>
        <div>
          <strong>{step.title}</strong>
          <small>{resolution}</small>
          {values.length ? (
            <dl className="react-canonical-form-summary">
              {values.map(([key, value]) => (
                <div key={key}><dt>{key}</dt><dd>{canonicalFormValue(value)}</dd></div>
              ))}
            </dl>
          ) : null}
          {errors.length ? (
            <ul aria-label={t("turn.formErrors")} role="alert">
              {errors.map(([key, error]) => <li key={key}>{key}: {error}</li>)}
            </ul>
          ) : null}
          <CanonicalScopedErrors errors={step.scopedErrors ?? []} />
        </div>
      </section>
    );
  }
  if (step.kind === "delegate" && step.delegate) {
    return (
      <div className="react-canonical-step-stack">
        <button
          aria-label={t("turn.openDetails", { name: step.title })}
          className="react-canonical-step react-canonical-step--button"
          data-kind={step.kind}
          data-status={step.status}
          type="button"
          onClick={() => onOpenSubagent(step.delegate!)}
        >
          <span className="react-canonical-step__icon"><AgentStepIcon status={canonicalStepIconStatus(step)} /></span>
          <span>
            <strong>{step.title}</strong>
            {step.delegate.latestActivity ? <small>{step.delegate.latestActivity}</small> : null}
          </span>
        </button>
        <CanonicalScopedErrors errors={step.scopedErrors ?? []} />
      </div>
    );
  }
  if (step.kind === "plan" && step.plan) {
    return <CanonicalPlanCard step={step} />;
  }
  if (step.kind === "error") {
    return (
      <section aria-label={step.title} className="react-canonical-step" data-kind={step.kind} data-status={step.status} role="alert">
        <AlertTriangle aria-hidden="true" size={16} />
        <div><strong>{step.title}</strong>{step.summary ? <p>{step.summary}</p> : null}</div>
      </section>
    );
  }
  if (step.kind === "compaction") {
    const compaction = step.compaction;
    return (
      <details className="react-canonical-step" data-kind={step.kind} data-status={step.status}>
        <summary>
          <span className="react-canonical-step__icon"><ListCollapse aria-hidden="true" size={16} /></span>
          <span>{t("turn.contextCompacted")}</span>
          <ChevronRight aria-hidden="true" className="react-context-compaction-chevron" size={15} />
        </summary>
        {step.summary ? <p>{step.summary}</p> : null}
        {compaction ? (
          <ul aria-label={t("turn.compactionDetails")}>
            {compaction.estimatedTokensBefore !== undefined ? <li>{t("compaction.before", { value: compaction.estimatedTokensBefore.toLocaleString(i18n.resolvedLanguage) })}</li> : null}
            {compaction.estimatedTokensAfter !== undefined ? <li>{t("compaction.after", { value: compaction.estimatedTokensAfter.toLocaleString(i18n.resolvedLanguage) })}</li> : null}
            <li>{t("compaction.dropped", { value: compaction.droppedItemCount.toLocaleString(i18n.resolvedLanguage) })}</li>
          </ul>
        ) : null}
      </details>
    );
  }
  return (
    <section aria-label={step.title} className="react-canonical-step" data-kind={step.kind} data-status={step.status}>
      <span className="react-canonical-step__icon"><AgentStepIcon status={canonicalStepIconStatus(step)} /></span>
      <div>
        <strong>{step.title}</strong>
        {step.summary ? <p>{step.summary}</p> : null}
        {step.delegate?.latestActivity ? <small>{step.delegate.latestActivity}</small> : null}
        <CanonicalArtifacts artifacts={step.artifacts ?? []} onOpen={onOpenArtifact} />
        <CanonicalScopedErrors errors={step.scopedErrors ?? []} />
      </div>
    </section>
  );
}

function ErrorRecoveryCard({
  focusOnMount,
  onOpenDetails,
  onRecover,
  recovering,
  step,
  turn,
}: {
  focusOnMount: boolean;
  onOpenDetails: () => void;
  onRecover: (action: RecoveryAction) => void;
  recovering: boolean;
  step: ChatStep;
  turn: ChatTurn;
}) {
  const { t } = useTranslation("chat");
  const cardRef = useRef<HTMLElement | null>(null);
  const error = canonicalErrorInfo(step, t);
  const failedStep = failedPlanStep(turn);
  const completedSteps = completedPlanStepCount(turn);

  useEffect(() => {
    if (focusOnMount) {
      cardRef.current?.focus();
    }
  }, [focusOnMount]);

  return (
    <section
      ref={cardRef}
      aria-label={t("recovery.label")}
      className="react-error-recovery"
      role="alert"
      tabIndex={-1}
    >
      <div className="react-error-recovery__heading">
        <AlertTriangle aria-hidden="true" size={18} />
        <div>
          <strong>{turn.status === "interrupted" ? t("recovery.cancelled") : t("recovery.interrupted")}</strong>
          <p>{friendlyErrorMessage(error.code, error.message, t)}</p>
        </div>
      </div>
      <dl className="react-error-recovery__summary">
        {failedStep ? <div><dt>{t("recovery.failedAt")}</dt><dd>{failedStep}</dd></div> : null}
        <div><dt>{t("recovery.progress")}</dt><dd>{t("recovery.completedSteps", { count: completedSteps })}</dd></div>
      </dl>
      {completedPlanSteps(turn).length ? (
        <div className="react-error-recovery__valid-results">
          <strong>{t("recovery.validResults")}</strong>
          <ul>{completedPlanSteps(turn).map((item) => <li key={item}>{item}</li>)}</ul>
        </div>
      ) : null}
      <div className="react-error-recovery__actions" aria-label={t("recovery.actions")}>
        <button disabled={recovering} type="button" onClick={() => onRecover("continue")}><Play aria-hidden="true" size={15} />{t("recovery.continue")}</button>
        <button disabled={recovering} type="button" onClick={() => onRecover("retry")}><RotateCcw aria-hidden="true" size={15} />{t("recovery.retry")}</button>
        <button disabled={recovering} type="button" onClick={() => onRecover("restart")}><RefreshCw aria-hidden="true" size={15} />{t("recovery.restart")}</button>
        <button type="button" onClick={onOpenDetails}>{t("recovery.details")}</button>
        <button type="button" onClick={() => void writeClipboardText(formatFailureDetails(step, turn, t))}><Copy aria-hidden="true" size={15} />{t("recovery.copyError")}</button>
      </div>
    </section>
  );
}

function CanonicalPlanCard({ step }: { step: ChatStep }) {
  const { t } = useTranslation("chat");
  const contentId = useId();
  const [expanded, setExpanded] = useState(step.status !== "completed");
  const plan = step.plan;
  const completed = plan?.steps.filter((item) => item.status === "completed").length ?? 0;

  useEffect(() => {
    if (step.status === "completed") {
      setExpanded(false);
    } else if (step.status === "running") {
      setExpanded(true);
    }
  }, [step.status]);

  if (!plan) {
    return null;
  }

  return (
    <section aria-label={t("plan.label")} aria-live="polite" className="react-canonical-step" data-kind={step.kind} data-status={step.status}>
      <span className="react-canonical-step__icon"><AgentStepIcon status={canonicalStepIconStatus(step)} /></span>
      <div className="react-canonical-plan">
        <button
          aria-controls={contentId}
          aria-expanded={expanded}
          className="react-canonical-plan__heading"
          type="button"
          onClick={() => setExpanded((open) => !open)}
        >
          <strong>{t("plan.label")}</strong>
          <span>{t("plan.completed", { completed, total: plan.total })}</span>
          {expanded ? <ChevronDown aria-hidden="true" size={15} /> : <ChevronRight aria-hidden="true" size={15} />}
        </button>
        <progress
          aria-label={step.title}
          aria-valuemax={plan.total}
          aria-valuemin={0}
          aria-valuenow={completed}
          max={Math.max(plan.total, 1)}
          value={completed}
        />
        {expanded ? (
          <div className="react-canonical-plan__content" id={contentId}>
            {plan.explanation ? <p className="react-canonical-plan__explanation">{plan.explanation}</p> : null}
            <ol className="react-canonical-plan__steps">
              {plan.steps.map((planStep, index) => (
                <li data-status={planStep.status} key={`${index}:${planStep.step}`}>
                  <span className="react-canonical-plan__step-icon"><PlanStepIcon status={planStep.status} /></span>
                  <PlanStepLabel text={planStep.step} />
                  <small>{formatPlanStepStatus(planStep.status, t)}</small>
                </li>
              ))}
            </ol>
          </div>
        ) : null}
      </div>
    </section>
  );
}

type PlanStepStatus = NonNullable<ChatStep["plan"]>["steps"][number]["status"];

function PlanStepIcon({ status }: { status: PlanStepStatus }) {
  const { t } = useTranslation("chat");
  switch (status) {
    case "completed": return <Check aria-label={t("plan.status.completed")} size={14} />;
    case "in_progress": return <Loader2 aria-label={t("plan.status.inProgress")} size={14} />;
    case "failed": return <AlertTriangle aria-label={t("plan.status.failed")} size={14} />;
    case "cancelled": return <X aria-label={t("plan.status.cancelled")} size={14} />;
    default: return <Circle aria-label={t("plan.status.pending")} size={12} />;
  }
}

function PlanStepLabel({ text }: { text: string }) {
  const { t } = useTranslation("chat");
  const [expanded, setExpanded] = useState(false);
  const canExpand = text.length > 72;
  return (
    <span className="react-canonical-plan__step-label">
      <span data-expanded={expanded ? "true" : undefined}>{text}</span>
      {canExpand ? (
        <button aria-expanded={expanded} type="button" onClick={() => setExpanded((open) => !open)}>
          {expanded ? t("plan.collapse") : t("plan.expand")}
        </button>
      ) : null}
    </span>
  );
}

function formatPlanStepStatus(status: PlanStepStatus, t: TFunction<"chat">): string {
  switch (status) {
    case "completed": return t("plan.status.completed");
    case "in_progress": return t("plan.status.inProgress");
    case "failed": return t("plan.status.failed");
    case "cancelled": return t("plan.status.cancelled");
    default: return t("plan.status.pending");
  }
}

function CanonicalArtifacts({ artifacts, onOpen }: { artifacts: ArtifactRef[]; onOpen: (artifact: ArtifactRef) => void }) {
  const { t } = useTranslation("chat");
  const visibleArtifacts = artifacts.filter((artifact) => artifact.kind !== "data_view");
  if (!visibleArtifacts.length) {
    return null;
  }
  return (
    <ul aria-label={t("artifacts.label")} className="react-canonical-artifacts">
      {visibleArtifacts.map((artifact) => (
        <li key={artifact.id}>
          <button aria-label={t("artifacts.preview", { name: artifact.title })} type="button" onClick={() => onOpen(artifact)}>{artifact.title}</button>
        </li>
      ))}
    </ul>
  );
}

function uniqueArtifacts(artifacts: ArtifactRef[]): ArtifactRef[] {
  return [...new Map(artifacts.map((artifact) => [artifact.id, artifact])).values()];
}

function CanonicalScopedErrors({ errors }: { errors: NonNullable<ChatStep["scopedErrors"]> }) {
  if (!errors.length) {
    return null;
  }
  return (
    <ul className="react-canonical-scoped-errors" role="alert">
      {errors.map((error, index) => <li key={`${error.code}:${index}`}><strong>{error.code}</strong>: {error.message}</li>)}
    </ul>
  );
}

function canonicalFormEntries(values: unknown): Array<[string, unknown]> {
  return values !== null && typeof values === "object" && !Array.isArray(values)
    ? Object.entries(values)
    : [];
}

function canonicalFormValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined) {
    return "";
  }
  return JSON.stringify(value);
}

function canonicalReferenceSummary(reference: AgentInputReference, index: number): ContextReferenceSummary {
  return {
    id: reference.noteId || reference.evidenceId || `${reference.kind}:${index}`,
    kind: reference.kind,
    presentation: reference.type === "tinyos.file" && Boolean(reference.rawPath) && !reference.sourcePath
      ? "attachment"
      : "context",
    title: reference.title,
    detail: reference.detail,
    sourcePath: reference.sourcePath,
    sourceLine: reference.sourceLine,
  };
}

function toolCallSummaryFromStep(step: ChatStep, toolCall: ToolCallState, t: TFunction<"chat">): ToolCallSummary {
  return {
    id: toolCall.id,
    name: displayToolName(toolCall.name, t),
    status: step.status,
    summary: toolCall.resultPreview || step.summary,
    ...(toolCall.argsPreview ? { argsText: toolCall.argsPreview } : {}),
    ...(toolCall.resultPreview ? { responseText: toolCall.resultPreview } : {}),
  };
}

function canonicalStepIconStatus(step: ChatStep): AgentStepStatus {
  if (step.status === "completed") return "success";
  if (step.status === "running") return "active";
  if (step.status === "blocked") return "waiting";
  if (step.status === "failed" || step.status === "cancelled") return "error";
  return "pending";
}

function MessageBubble({
  message,
  onBranch,
  onCopy,
  onOpenTool,
  sessionRunning,
}: {
  message: ReactChatMessage;
  onBranch: () => void;
  onCopy: () => void;
  onOpenTool: (toolCall: ToolCallSummary) => void;
  sessionRunning: boolean;
}) {
  const { t } = useTranslation("chat");
  const actionAlignment = message.role === "user" ? "right" : "left";
  const showCopyAction = canCopyMessage(message, { sessionRunning });
  const showBranchAction = canBranchFromMessage(message, { sessionRunning });
  return (
    <article
      className="react-message"
      data-actions-placement="bottom"
      data-role={message.role}
      data-testid={`message-${message.id}`}
    >
      <div className="react-message__body">
        {message.reasoningText ? (
          <MessageReasoning streaming={message.status === "streaming"} text={message.reasoningText} />
        ) : null}
        {message.role === "assistant" ? (
          <AssistantMarkdown streaming={message.status === "streaming"} text={message.text} />
        ) : (
          <PlainMessageText text={message.text} />
        )}
        {message.contextReferences?.length ? <MessageContext references={message.contextReferences} /> : null}
        {message.toolCalls?.length ? <AgentSteps toolCalls={message.toolCalls} onOpenTool={onOpenTool} /> : null}
        {message.status === "streaming" ? <span className="react-message__streaming" aria-label={t("turn.agentResponding")} /> : null}
      </div>
      {showCopyAction || showBranchAction ? (
        <div className="react-message__actions" data-align={actionAlignment}>
          {showCopyAction ? (
            <button aria-label={t("turn.copyMessage")} type="button" onClick={onCopy}>
              <Copy aria-hidden="true" size={14} />
            </button>
          ) : null}
          {showBranchAction ? (
            <button aria-label={t("turn.branchHere")} type="button" onClick={onBranch}>
              <GitBranch aria-hidden="true" size={14} />
            </button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function MessageReasoning({ durationMs, streaming, text }: { durationMs?: number; streaming: boolean; text: string }) {
  const { t } = useTranslation("chat");
  const [expanded, setExpanded] = useState(streaming);
  const wasStreaming = useRef(streaming);
  const contentId = useId();

  useEffect(() => {
    if (wasStreaming.current !== streaming) {
      setExpanded(streaming);
      wasStreaming.current = streaming;
    }
  }, [streaming]);

  return (
    <section className="react-message-reasoning" aria-label={t("reasoning.label")}>
      <button
        aria-controls={contentId}
        aria-expanded={expanded}
        className="react-message-reasoning__trigger"
        type="button"
        onClick={() => setExpanded((open) => !open)}
      >
        <span>{streaming ? t("reasoning.thinking") : formatThinkingLabel(durationMs, t)}</span>
        {expanded ? <ChevronDown aria-hidden="true" size={14} /> : <ChevronRight aria-hidden="true" size={14} />}
      </button>
      {expanded ? (
        <div className="react-message-reasoning__content" id={contentId}>
          <PlainMessageText text={text} />
        </div>
      ) : null}
    </section>
  );
}

function MessageContext({ references }: { references: ContextReferenceSummary[] }) {
  const { t } = useTranslation("chat");
  const attachmentsOnly = references.every((reference) => reference.presentation === "attachment");
  const label = attachmentsOnly ? t("context.attachments") : t("context.context");
  return (
    <section
      aria-label={label}
      className="react-message-context"
      data-presentation={attachmentsOnly ? "attachment" : "context"}
    >
      <h3>{label}</h3>
      <ul>
        {references.map((reference) => (
          <li data-presentation={reference.presentation ?? "context"} key={reference.id}>
            {reference.presentation === "attachment" ? (
              <span className="react-message-context__icon"><FileText aria-hidden="true" size={16} /></span>
            ) : null}
            <span className="react-message-context__text">
              <strong>{reference.title}</strong>
              {reference.detail ? <small>{reference.detail}</small> : null}
              {reference.sourcePath ? (
                <small>
                  {reference.sourcePath}{typeof reference.sourceLine === "number" ? `:${reference.sourceLine}` : ""}
                </small>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function formatMessageForCopy(message: ReactChatMessage): string {
  return message.text;
}

type AgentStepStatus = "pending" | "active" | "success" | "waiting" | "error";

function AgentSteps({
  flat = false,
  onOpenTool,
  toolCalls,
}: {
  flat?: boolean;
  onOpenTool: (toolCall: ToolCallSummary) => void;
  toolCalls: ToolCallSummary[];
}) {
  const { t } = useTranslation("chat");
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  const overallStatus = resolveAgentStepsStatus(toolCalls);
  const countLabel = t("steps.count", { count: toolCalls.length });
  const currentStepIndex = resolveCurrentAgentStepIndex(toolCalls);
  return (
    <section className="react-agent-steps" data-flat={flat ? "true" : undefined} data-status={overallStatus} data-stepper="true">
      {!flat ? (
        <button
          aria-controls={listId}
          aria-expanded={expanded}
          aria-label={`${t("steps.label")}, ${countLabel}`}
          className="react-agent-steps__header"
          type="button"
          onClick={() => setExpanded((open) => !open)}
        >
          <span className="react-agent-steps__header-icon" data-status={overallStatus}>
            <AgentStepIcon status={overallStatus} />
          </span>
          <span className="react-agent-steps__title">{t("steps.title")}</span>
          <small>{countLabel}</small>
          {expanded ? <ChevronDown aria-hidden="true" size={15} /> : <ChevronRight aria-hidden="true" size={15} />}
        </button>
      ) : null}

      {flat || expanded ? (
        <ol aria-label={t("steps.label")} className="react-agent-steps__list" id={listId}>
          {toolCalls.map((toolCall, index) => {
            const status = normalizeAgentStepStatus(toolCall.status);
            const isLast = index === toolCalls.length - 1;
            const isCurrent = index === currentStepIndex;
            return (
              <li
                aria-current={isCurrent ? "step" : undefined}
                className="react-agent-step-item"
                data-motion-role="step"
                data-status={status}
                data-step-count={toolCalls.length}
                data-step-index={index}
                key={toolCall.id}
              >
                {!isLast ? <span aria-hidden="true" className="react-agent-step-item__line" /> : null}
                <span className="react-agent-step-item__marker" data-status={status}>
                  <AgentStepIcon status={status} />
                </span>
                <button
                  aria-label={t("steps.openDetails", { name: toolCall.name })}
                  className="react-agent-step"
                  type="button"
                  onClick={() => onOpenTool(toolCall)}
                >
                  <span className="react-agent-step__content">
                    <span>{toolCall.name}</span>
                    {toolCall.summary ? <small>{toolCall.summary}</small> : null}
                  </span>
                  <small className="react-agent-step__status">{formatAgentStepStatus(toolCall.status, t)}</small>
                  <PanelRightOpen aria-hidden="true" size={15} />
                </button>
              </li>
            );
          })}
        </ol>
      ) : null}
    </section>
  );
}

function AgentStepIcon({ status }: { status: AgentStepStatus }) {
  switch (status) {
    case "success":
      return <Check aria-hidden="true" size={14} />;
    case "active":
      return <Loader2 aria-hidden="true" size={14} />;
    case "waiting":
    case "error":
      return <AlertTriangle aria-hidden="true" size={14} />;
    default:
      return <Circle aria-hidden="true" size={12} />;
  }
}

function resolveAgentStepsStatus(toolCalls: ToolCallSummary[]): AgentStepStatus {
  if (toolCalls.some((toolCall) => normalizeAgentStepStatus(toolCall.status) === "error")) {
    return "error";
  }
  if (toolCalls.some((toolCall) => normalizeAgentStepStatus(toolCall.status) === "waiting")) {
    return "waiting";
  }
  if (toolCalls.some((toolCall) => normalizeAgentStepStatus(toolCall.status) === "active")) {
    return "active";
  }
  if (toolCalls.length && toolCalls.every((toolCall) => normalizeAgentStepStatus(toolCall.status) === "success")) {
    return "success";
  }
  return "pending";
}

function resolveCurrentAgentStepIndex(toolCalls: ToolCallSummary[]): number {
  const activeIndex = toolCalls.findIndex((toolCall) => normalizeAgentStepStatus(toolCall.status) === "active");
  if (activeIndex >= 0) {
    return activeIndex;
  }
  const waitingIndex = toolCalls.findIndex((toolCall) => normalizeAgentStepStatus(toolCall.status) === "waiting");
  if (waitingIndex >= 0) {
    return waitingIndex;
  }
  return -1;
}

function normalizeAgentStepStatus(status: string): AgentStepStatus {
  switch (status.toLowerCase()) {
    case "complete":
    case "completed":
    case "success":
    case "succeeded":
      return "success";
    case "running":
    case "active":
      return "active";
    case "blocked":
      return "waiting";
    case "failed":
    case "error":
    case "cancelled":
    case "canceled":
      return "error";
    default:
      return status ? "pending" : "pending";
  }
}

function formatAgentStepStatus(status: string, t: TFunction<"chat">): string {
  switch (normalizeAgentStepStatus(status)) {
    case "active": return t("steps.status.active");
    case "success": return t("steps.status.success");
    case "waiting": return t("steps.status.waiting");
    case "error": return status.toLowerCase().includes("cancel") ? t("steps.status.cancelled") : t("steps.status.error");
    default: return t("steps.status.pending");
  }
}

function reasoningDurationMs(step: ChatStep): number | undefined {
  if (!step.startedAt || !step.completedAt) {
    return undefined;
  }
  const duration = Date.parse(step.completedAt) - Date.parse(step.startedAt);
  return Number.isFinite(duration) && duration >= 0 ? duration : undefined;
}

function formatThinkingLabel(durationMs: number | undefined, t: TFunction<"chat">): string {
  if (durationMs === undefined) {
    return t("reasoning.label");
  }
  if (durationMs < 1000) {
    return t("reasoning.underSecond");
  }
  return t("reasoning.seconds", { count: Math.max(1, Math.round(durationMs / 1000)) });
}

function PlainMessageText({ text }: { text: string }) {
  if (!text.trim()) {
    return null;
  }
  return (
    <div className="react-message-plain-text">
      <p>{text}</p>
    </div>
  );
}

function displaySessionTitle(title: string, t: TFunction<"chat">): string {
  return isDefaultSessionTitle(title) ? t("shell.newChat") : title;
}

function deriveSessionTitle(prompt: string, t: TFunction<"chat">): string {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  return normalized.length > 28 ? `${normalized.slice(0, 28)}…` : normalized || t("shell.newChat");
}

function isDefaultSessionTitle(title: string): boolean {
  return /^(new (chat|session)|新(建)?会话|未命名)/i.test(title.trim());
}

function failedPlanStep(turn: ChatTurn): string {
  for (const step of turn.steps) {
    const failed = step.plan?.steps.find((planStep) => planStep.status === "failed" || planStep.status === "in_progress");
    if (failed) {
      return failed.step;
    }
  }
  return "";
}

function completedPlanStepCount(turn: ChatTurn): number {
  return turn.steps.reduce((count, step) => (
    count + (step.plan?.steps.filter((planStep) => planStep.status === "completed").length ?? 0)
  ), 0);
}

function completedPlanSteps(turn: ChatTurn): string[] {
  return turn.steps.flatMap((step) => (
    step.plan?.steps.filter((planStep) => planStep.status === "completed").map((planStep) => planStep.step) ?? []
  ));
}

function canonicalErrorInfo(step: ChatStep, t: TFunction<"chat">): { code: string; message: string } {
  const error = step.error && typeof step.error === "object" ? step.error as Record<string, unknown> : {};
  return {
    code: typeof error.code === "string" && error.code ? error.code : "runtime_error",
    message: typeof error.message === "string" && error.message ? error.message : step.summary || t("friendlyError.taskFailed"),
  };
}

function displayToolName(name: string, t?: TFunction<"chat">): string {
  return name === "update_plan" ? t?.("tool.updatePlan") ?? name : name;
}

function friendlyErrorMessage(code: string, message: string, t: TFunction<"chat">): string {
  if (code === "max_iterations" || message.toLowerCase().includes("max iterations")) {
    return t("friendlyError.maxIterations");
  }
  if (code.includes("cancel") || message.toLowerCase().includes("cancel")) {
    return t("friendlyError.cancelled");
  }
  return message;
}

function formatFailureDetails(step: ChatStep, turn: ChatTurn, t: TFunction<"chat">): string {
  const error = canonicalErrorInfo(step, t);
  return [
    `${t("details.task")}: ${turn.userMessage.text}`,
    `${t("details.status")}: ${turn.status}`,
    `${t("details.errorCode")}: ${error.code}`,
    `${t("details.errorMessage")}: ${error.message}`,
    failedPlanStep(turn) ? `${t("details.interruptedAt")}: ${failedPlanStep(turn)}` : "",
  ].filter(Boolean).join("\n");
}

function ErrorDetails({ step, turn }: { step: ChatStep; turn: ChatTurn }) {
  const { t } = useTranslation("chat");
  const error = canonicalErrorInfo(step, t);
  return (
    <div className="react-error-detail">
      <dl>
        <div><dt>{t("details.turnId")}</dt><dd><code>{turn.id}</code></dd></div>
        <div><dt>{t("details.status")}</dt><dd>{turn.status}</dd></div>
        <div><dt>{t("details.stopReason")}</dt><dd><code>{error.code}</code></dd></div>
        {failedPlanStep(turn) ? <div><dt>{t("details.interruptedAt")}</dt><dd>{failedPlanStep(turn)}</dd></div> : null}
        <div><dt>{t("details.originalTask")}</dt><dd>{turn.userMessage.text}</dd></div>
      </dl>
      <section>
        <h3>{t("details.originalError")}</h3>
        <pre>{error.message}</pre>
      </section>
    </div>
  );
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
