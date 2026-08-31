import { lazy, Suspense, useCallback, useEffect, useEffectEvent, useMemo, useReducer, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";
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
import type { ChatEvent, ChatInput, ChatModelOption, ChatStore, ProjectGroupStore, SessionStore, SessionSummary, SettingsStore, SkillSummary, ToolSummary, ToolsStore, WorkspaceStore } from "../services";
import { createDesktopCompactCommand, createDesktopTurnSubmitCommand } from "../../app-core/chat/desktopCommand";
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
  sessionWorkspaceName,
} from "./sessionWorkspaces";
import {
  applyLoadedDelegatedAgentTrace,
  projectLoadedArtifactDetail,
} from "../../app-core/chat/chatProjection";
import type {
  ArtifactRef,
  DelegatedAgentState,
  LoadedArtifactDetail,
} from "../../app-core/chat/chatTurnContracts";
import {
  resolveOfficeArtifactKind,
  type OfficeArtifactSource,
  type SpreadsheetCellChangeRequest,
} from "../../app-core/chat/officeArtifact";
import { logRendererEvent } from "../../app-core/native/rendererLogger";
import type { ChatTimelineSnapshot } from "../../app-core/chat/agentTimelineModel";
import type {
  NativeBrowserSession,
  NativeBrowserSnapshot,
} from "../../app-core/native/nativeBrowserSnapshot";
import {
  THREAD_COMMAND_ACK_TIMEOUT_MS,
  canonicalThreadCommandAcknowledgement,
  canonicalThreadCommandCompletion,
  createThreadAgentCancelCommand,
  createThreadFormCancelCommand,
  createThreadFormSubmitCommand,
  isThreadCommandInFlight,
  reduceThreadCommandLifecycle,
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
  prepareChatSubmission,
  type QueuedComposerInput,
  type SpreadsheetComposerAnnotation,
} from "./chatSubmission";
import { ChatTimeline } from "./ChatTimeline";
import { FloatingPlanStatus } from "./FloatingPlanStatus";
import { AssistantMarkdown } from "./AssistantMarkdown";
import {
  AssistantFileLinkError,
  assistantFileArtifact,
  assistantFileLinkTitle,
  resolveAssistantFileLink,
  type AssistantFileLink,
} from "./assistantFileLinks";
import {
  ChatSessionWorkspace,
  type ProjectSessionContext,
} from "./ChatSessionWorkspace";
import {
  deriveSessionTitle,
  displaySessionTitle,
  isDefaultSessionTitle,
} from "./sessionTitle";
import { projectTinybotMascotMood, type TinybotMascotMood } from "./TinybotMascot";
import { Sidecar } from "../sidecar/Sidecar";
import { SidecarBrowser } from "../sidecar/SidecarBrowser";
import { OfficeArtifactPreview } from "../sidecar/OfficeArtifactPreview";
import {
  activeSidecarTab,
  createInitialSidecarState,
  DEFAULT_SIDECAR_WORKSPACE_ID,
  readPersistedSidecarWidth,
  reduceSidecarState,
  sidecarArtifactTabId,
  visibleSidecarTabs,
  writePersistedSidecarWidth,
  type SidecarArtifactTab,
  type SidecarBrowserTab,
  type SidecarTab,
  type SidecarTerminalTab,
} from "../sidecar/sidecarModel";

export type ChatPageProps = {
  chatStore: ChatStore;
  sessionStore: SessionStore;
  projectGroupStore?: ProjectGroupStore;
  settingsStore?: SettingsStore;
  toolsStore?: Partial<Pick<ToolsStore, "installPluginMigration" | "loadCatalog">>;
  workspaceStore?: Pick<WorkspaceStore, "readThreadFile" | "readThreadFileBytes">;
  createSessionSignal?: number;
  activateSessionRequest?: { sessionId: string; signal: number } | null;
  sessionSidebarCollapsed?: boolean;
  onSessionSidebarCollapsedChange?: (collapsed: boolean) => void;
  onStopGenerationTargetChange?: (sessionId: string) => void;
  onMascotMoodChange?: (mood: TinybotMascotMood) => void;
  onOpenFiles?: () => void;
  onOpenSettings?: () => void;
  onStartupSessionHydrated?: () => void;
  startInNewSession?: boolean;
  now?: () => number;
};

type DrawerState =
  | { kind: "tool"; title: string; toolCall: ToolCallSummary }
  | { kind: "subagent"; title: string; delegate: DelegatedAgentState; loading: boolean; error?: string }
  | null;

type ArtifactSidecarContent = {
  artifact: ArtifactRef;
  detail?: LoadedArtifactDetail;
  error?: string;
  loading: boolean;
  notice?: string;
  office?: OfficeArtifactSource;
};

type BrowserSnapshot = NativeBrowserSnapshot<NativeBrowserSession>;

const LazySidecarTerminal = lazy(async () => {
  const module = await import("../sidecar/SidecarTerminal");
  return { default: module.SidecarTerminal };
});

type ConversationViewState = {
  scrollTop: number;
  stickToLatest: boolean;
};

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
  return tools.map((tool) => ({
    description: tool.description,
    disabled: !tool.available,
    enabled: tool.enabled && tool.available,
    id: tool.id,
    name: tool.displayName || tool.name,
  }));
}

const SESSION_DELETE_DISSOLVE_MS = 180;
const EMPTY_OPTIMISTIC_MESSAGES: ReactChatMessage[] = [];

function latestTurnPlan(timeline: ChatTimelineSnapshot | null | undefined) {
  const turn = timeline?.turns[timeline.turns.length - 1];
  if (!turn) return undefined;
  const step = [...turn.steps].reverse().find((candidate) => candidate.kind === "plan" && candidate.plan);
  if (!step?.plan) return undefined;
  return {
    identityKey: `${turn.id}:${step.id}`,
    plan: step.plan,
    revisionKey: JSON.stringify({ plan: step.plan, status: step.status }),
  };
}

export function ChatPage({
  activateSessionRequest = null,
  chatStore,
  createSessionSignal = 0,
  now = Date.now,
  onOpenFiles,
  onOpenSettings,
  onMascotMoodChange,
  onSessionSidebarCollapsedChange,
  onStartupSessionHydrated,
  onStopGenerationTargetChange,
  sessionSidebarCollapsed,
  sessionStore,
  startInNewSession = false,
  projectGroupStore,
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
  const [optimisticMessagesBySession, setOptimisticMessagesBySession] = useState<Map<string, ReactChatMessage[]>>(
    () => new Map(),
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
  const [sidecar, dispatchSidecar] = useReducer(
    reduceSidecarState,
    undefined,
    () => createInitialSidecarState(readPersistedSidecarWidth(window.localStorage)),
  );
  const [artifactSidecarContent, setArtifactSidecarContent] = useState<Record<string, ArtifactSidecarContent>>({});
  const [composerFocusRequestId, setComposerFocusRequestId] = useState(0);
  const [browserProvisionErrors, setBrowserProvisionErrors] = useState<Record<string, string>>({});
  const [terminalErrors, setTerminalErrors] = useState<Record<string, string>>({});
  const [browserProvisionEpoch, setBrowserProvisionEpoch] = useState(0);
  const [commandLifecycle, dispatchCommandLifecycle] = useReducer(
    reduceThreadCommandLifecycle,
    { stage: "idle" } as ThreadCommandLifecycle,
  );
  const [compactingSessionId, setCompactingSessionId] = useState("");
  const [queuedInputsBySession, setQueuedInputsBySession] = useState<Map<string, QueuedComposerInput[]>>(() => new Map());
  const [queueMessage, setQueueMessage] = useState("");
  const [composerSessionMentionIds, setComposerSessionMentionIds] = useState<string[]>([]);
  const [composerSelectedSkillIds, setComposerSelectedSkillIds] = useState<string[]>([]);
  const [composerSpreadsheetAnnotations, setComposerSpreadsheetAnnotations] = useState<SpreadsheetComposerAnnotation[]>([]);
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
  const lastActivateSessionSignal = useRef<number | null>(null);
  const draftSessionCreatePromise = useRef<Promise<SessionSummary> | null>(null);
  const defaultModelSavePromise = useRef<Promise<void>>(Promise.resolve());
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
  const sidecarRef = useRef(sidecar);
  const browserProvisioningResourceIdRef = useRef("");
  const browserActivationTargetRef = useRef("");
  sidecarRef.current = sidecar;
  sessionTabsRef.current = sessionTabs;
  sessionsLoadedRef.current = sessionsLoaded;
  const activeSessionId = sessionTabs.activeSessionId;
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
  const displayedSessions = useMemo(
    () => [...draftSessions, ...sessions],
    [draftSessions, sessions],
  );
  const activeDisplaySession = activeSession ?? activeDraftSession;
  const activePersistedSessionId = activeSession?.id ?? "";
  const sessionRuntime = useChatSessionRuntime({
    chatStore,
    onEffect: handleChatSessionRuntimeEffect,
    sessionId: activePersistedSessionId,
  });
  const {
    agentUiForms,
    browserError,
    browserSnapshot,
    error: timelineError,
    hookResults,
    timeline,
  } = sessionRuntime.state;
  const {
    acceptBrowserSnapshot,
    clearBrowserError,
    clearBrowserSnapshot,
    clearError: clearTimelineError,
    reload: reloadSessionRuntime,
    reportError: reportTimelineError,
  } = sessionRuntime.actions;
  const composerDraft = sessionTabDraft(sessionTabs, activeSessionId);
  const optimisticMessages = optimisticMessagesBySession.get(activeSessionId) ?? EMPTY_OPTIMISTIC_MESSAGES;

  const resolvedSessionSidebarCollapsed = sessionSidebarCollapsed ?? localSessionSidebarCollapsed;
  const composerSkillOptions = useMemo(
    () => buildComposerSkillOptions(composerSkills, t),
    [composerSkills, t],
  );
  const composerToolOptions = useMemo(
    () => buildComposerToolOptions(composerTools),
    [composerTools],
  );
  const composerSpreadsheetContextReferences = useMemo<ComposerContextReference[]>(() => (
    composerSpreadsheetAnnotations.map((annotation) => ({
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
    }))
  ), [composerSpreadsheetAnnotations, t]);
  const sidecarTabs = useMemo(() => visibleSidecarTabs(sidecar), [sidecar]);
  const sidecarActiveTab = useMemo(() => activeSidecarTab(sidecar), [sidecar]);
  const explicitWorkspaceId = activeDisplaySession?.workingDirectory?.trim() ?? "";
  const activeWorkspaceId = activeDisplaySession
    ? explicitWorkspaceId || DEFAULT_SIDECAR_WORKSPACE_ID
    : "";
  const activeWorkspaceLabel = explicitWorkspaceId
    ? sessionWorkspaceName(explicitWorkspaceId)
    : activeDisplaySession ? t("shell.generalSessions") : "";

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
  const unboundBrowserResource = useMemo(() => sidecar.tabs.find((tab): tab is SidecarBrowserTab => (
    tab.kind === "browser"
      && tab.threadId === activeSession?.id
      && !tab.nativeTabId
  )), [activeSession?.id, sidecar.tabs]);
  const retainedBrowserResource = useMemo(() => sidecar.tabs.find((tab): tab is SidecarBrowserTab => (
    tab.kind === "browser"
      && tab.threadId === activeSession?.id
      && Boolean(tab.browserSessionId)
      && Boolean(tab.nativeTabId)
  )), [activeSession?.id, sidecar.tabs]);

  const synchronizeBrowserSnapshot = useCallback((snapshot: BrowserSnapshot, acceptForActiveThread = true) => {
    if (acceptForActiveThread && snapshot.data.sessionId === activeSessionId) {
      acceptBrowserSnapshot(snapshot);
    }
    dispatchSidecar({
      browserSessionId: snapshot.data.browserSessionId,
      tabs: snapshot.data.tabs.map((tab) => ({
        nativeTabId: tab.tabId,
        title: browserResourceTitle(tab.title, tab.url, t("sidecar.browser")),
      })),
      threadId: snapshot.data.sessionId,
      type: "tab.syncBrowserSession",
    });
  }, [acceptBrowserSnapshot, activeSessionId, t]);

  useEffect(() => {
    dispatchSidecar({
      threadId: activeSession?.id ?? "",
      type: "scope.changed",
      workspaceId: activeWorkspaceId,
    });
  }, [activeSession?.id, activeWorkspaceId]);

  useEffect(() => {
    if (browserSnapshot) synchronizeBrowserSnapshot(browserSnapshot, false);
  }, [browserSnapshot, synchronizeBrowserSnapshot]);

  useEffect(() => {
    const resource = retainedBrowserResource;
    const browserRuntime = chatStore.browserRuntime;
    if (!resource?.browserSessionId
      || !browserRuntime
      || browserSnapshot?.data.browserSessionId === resource.browserSessionId) return;
    let cancelled = false;
    void browserRuntime.snapshot(resource.browserSessionId)
      .then((snapshot) => {
        if (cancelled) return;
        if (snapshot.data.sessionId !== resource.threadId) {
          throw new Error(
            `Browser snapshot session ${snapshot.data.sessionId} does not match resource thread ${resource.threadId}.`,
          );
        }
        synchronizeBrowserSnapshot(snapshot);
      })
      .catch((error) => {
        if (!cancelled) {
          setBrowserProvisionErrors((current) => ({ ...current, [resource.id]: errorMessage(error) }));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    browserProvisionEpoch,
    browserSnapshot?.data.browserSessionId,
    chatStore.browserRuntime,
    retainedBrowserResource,
    synchronizeBrowserSnapshot,
  ]);

  useEffect(() => {
    const resource = unboundBrowserResource;
    const browserRuntime = chatStore.browserRuntime;
    if (!resource
      || browserProvisionErrors[resource.id]
      || browserProvisioningResourceIdRef.current) return;
    browserProvisioningResourceIdRef.current = resource.id;
    void (async () => {
      try {
        if (!browserRuntime) throw new Error(t("sidecar.browserBuildUnavailable"));
        let snapshot = await browserRuntime.createSession({ ownerSessionId: resource.threadId });

        const currentResources = sidecarRef.current.tabs.filter((tab): tab is SidecarBrowserTab => (
          tab.kind === "browser" && tab.threadId === resource.threadId
        ));
        const currentResource = currentResources.find((tab) => tab.id === resource.id);
        const resourceStillExists = Boolean(currentResource);
        const resourceAlreadyBound = Boolean(
          currentResource?.browserSessionId === snapshot.data.browserSessionId
            && currentResource.nativeTabId
            && snapshot.data.tabs.some((tab) => tab.tabId === currentResource.nativeTabId),
        );
        const boundNativeTabIds = new Set(currentResources.flatMap((tab) => tab.nativeTabId ? [tab.nativeTabId] : []));
        const hasUnboundNativeTab = snapshot.data.tabs.some((tab) => !boundNativeTabIds.has(tab.tabId));
        let createdNativeTabId = "";
        if (resourceStillExists && !resourceAlreadyBound && !hasUnboundNativeTab) {
          const previousNativeTabIds = new Set(snapshot.data.tabs.map((tab) => tab.tabId));
          snapshot = await browserRuntime.createTab(snapshot.data.browserSessionId);
          createdNativeTabId = snapshot.data.tabs.find((tab) => !previousNativeTabIds.has(tab.tabId))?.tabId ?? "";
        }

        if (!sidecarRef.current.tabs.some((tab) => tab.id === resource.id)) {
          if (createdNativeTabId && snapshot.data.tabs.length > 1) {
            await browserRuntime.closeTab(snapshot.data.browserSessionId, createdNativeTabId);
          }
          return;
        }
        synchronizeBrowserSnapshot(snapshot);
      } catch (error) {
        if (sidecarRef.current.tabs.some((tab) => tab.id === resource.id)) {
          setBrowserProvisionErrors((current) => ({ ...current, [resource.id]: errorMessage(error) }));
        }
      } finally {
        if (browserProvisioningResourceIdRef.current === resource.id) {
          browserProvisioningResourceIdRef.current = "";
        }
        setBrowserProvisionEpoch((current) => current + 1);
      }
    })();
  }, [
    browserProvisionEpoch,
    browserProvisionErrors,
    chatStore.browserRuntime,
    synchronizeBrowserSnapshot,
    t,
    unboundBrowserResource,
  ]);

  useEffect(() => {
    const resource = sidecarActiveTab?.kind === "browser" ? sidecarActiveTab : undefined;
    const browserRuntime = chatStore.browserRuntime;
    if (!resource?.browserSessionId
      || !resource.nativeTabId
      || !browserRuntime
      || browserSnapshot?.data.browserSessionId !== resource.browserSessionId) return;
    const activationTarget = `${resource.browserSessionId}:${resource.nativeTabId}`;
    if (browserSnapshot.data.activeTabId === resource.nativeTabId) {
      if (browserActivationTargetRef.current === activationTarget) {
        browserActivationTargetRef.current = "";
      }
      return;
    }
    if (browserActivationTargetRef.current === activationTarget) return;
    browserActivationTargetRef.current = activationTarget;
    void browserRuntime.activateTab(resource.browserSessionId, resource.nativeTabId)
      .then((snapshot) => synchronizeBrowserSnapshot(snapshot))
      .catch((error) => {
        if (browserActivationTargetRef.current === activationTarget) {
          browserActivationTargetRef.current = "";
        }
        setBrowserProvisionErrors((current) => ({ ...current, [resource.id]: errorMessage(error) }));
      });
  }, [browserSnapshot, chatStore.browserRuntime, sidecarActiveTab, synchronizeBrowserSnapshot]);

  useEffect(() => {
    writePersistedSidecarWidth(window.localStorage, sidecar.width);
  }, [sidecar.width]);

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
  const cancelCapability = threadCapabilities.capabilities.agent.cancel;
  const capabilityTargetsActiveTurn = !threadCapabilities.evaluatedTurnId
    || threadCapabilities.evaluatedTurnId === activeTurn?.id;
  const canCancelTurn = Boolean(
    activeSession
    && activeTurn
    && threadCapabilities.threadId === activeSession.id
    && capabilityTargetsActiveTurn
    && cancelCapability.available
  );
  const cancelUnavailableReason = !capabilityTargetsActiveTurn
    ? t("runtime.staleCapabilities")
    : cancelCapability.reason || t("runtime.cancelUnavailable");
  const cancelInFlight = isThreadCommandInFlight(commandLifecycle);
  const compactingActiveSession = Boolean(activeSession && compactingSessionId === activeSession.id);
  const showCommandLifecycleStatus = commandLifecycle.stage !== "idle"
    && commandLifecycle.command.kind !== "agent.cancel";
  const submittingFormId = commandLifecycle.stage !== "idle"
    && (commandLifecycle.command.kind === "form.submit" || commandLifecycle.command.kind === "form.cancel")
    && isThreadCommandInFlight(commandLifecycle)
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
    dispatchCommandLifecycle({ type: "reset" });
  }, [activeSessionId]);

  useEffect(() => {
    if (!timeline || commandLifecycle.stage === "idle" || commandLifecycle.stage === "completed") return;
    if (commandLifecycle.stage === "acknowledged") {
      const completion = canonicalThreadCommandCompletion(
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
    const acknowledgement = canonicalThreadCommandAcknowledgement(
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
    }, Math.max(0, THREAD_COMMAND_ACK_TIMEOUT_MS - elapsed));
    return () => window.clearTimeout(timer);
  }, [commandLifecycle, now]);

  useEffect(() => {
    if (commandLifecycle.stage === "idle") return;
    if (commandLifecycle.command.kind === "operation.retry"
      && (commandLifecycle.stage === "rejected" || commandLifecycle.stage === "timed_out")) {
      reportTimelineError(`Retry failed: ${commandLifecycle.error}`);
      return;
    }
    if ((commandLifecycle.command.kind === "form.submit" || commandLifecycle.command.kind === "form.cancel")
      && (commandLifecycle.stage === "rejected" || commandLifecycle.stage === "timed_out")) {
      reportTimelineError(`Form ${commandLifecycle.command.kind === "form.cancel" ? "cancellation" : "submission"} failed: ${commandLifecycle.error}`);
    }
  }, [commandLifecycle, reportTimelineError]);

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
    const createLocalDraft = (input: DraftSessionCreateInput): DraftSession => {
      const createdAtMs = now();
      return {
        id: `draft:${createdAtMs}:${++draftSessionSequence.current}`,
        createdAtMs,
        createInput: input,
      };
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

  async function dispatchTurn(
    sessionId: string,
    input: ChatInput,
    control: string,
    optimisticText?: string,
  ): Promise<void> {
    const command = createDesktopTurnSubmitCommand({
      message: input,
      sessionId,
      source: { control, surface: "chat" },
    });
    if (optimisticText) {
      setOptimisticMessagesBySession((current) => updateSessionMessages(
        current,
        sessionId,
        (messages) => [...messages, {
          createdAtMs: now(),
          id: command.commandId,
          role: "user",
          status: "complete",
          text: optimisticText,
        }],
      ));
    }
    try {
      await chatStore.dispatch(command);
    } catch (error) {
      if (optimisticText) {
        setOptimisticMessagesBySession((current) => updateSessionMessages(
          current,
          sessionId,
          (messages) => messages.filter((message) => message.id !== command.commandId),
        ));
      }
      throw error;
    }
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
      selectedSkillIds: composerSelectedSkillIds,
      selectedSessionIds: composerSessionMentionIds,
      sessions: sessionsRef.current.map((session) => ({
        id: session.id,
        title: displaySessionTitle(session.title, t),
        updatedAtMs: session.updatedAtMs,
      })),
      spreadsheetAnnotations: composerSpreadsheetAnnotations,
      t,
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
    await defaultModelSavePromise.current;
    const materializingDraft = !activeSession;
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
    await dispatchTurn(
      sendSession.id,
      prepared.turnInput,
      "composer-send",
      materializingDraft ? visibleText : undefined,
    );
    await handleSessionStoreRefresh(optimisticSession);
    if (materializingDraft) {
      dispatchSessionTabs({ type: "draft.changed", sessionId: sendSession.id, value: "" });
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
    const command = createThreadAgentCancelCommand({
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

  async function handleStopGeneration(session: SessionSummary) {
    if (cancelInFlight) return;
    if (!canCancelTurn) {
      reportTimelineError(`Cannot cancel: ${cancelUnavailableReason}`);
      return;
    }
    if (!activeTurn) {
      reportTimelineError(t("runtime.cancelActiveTurnUnavailable"));
      return;
    }
    const command = createThreadAgentCancelCommand({
      sessionId: session.id,
      source: { control: "stop-response", surface: "chat" },
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
    const tabId = sidecarArtifactTabId(activeSession.id, artifact.id);
    dispatchSidecar({
      artifactId: artifact.id,
      threadId: activeSession.id,
      title: artifact.title,
      type: "tab.openArtifact",
    });
    if (artifact.kind === "data_view") {
      setArtifactSidecarContent((current) => ({
        ...current,
        [tabId]: {
          artifact,
          ...(artifact.dataView ? { detail: { id: artifact.id, title: artifact.title, mimeType: artifact.mimeType, dataView: artifact.dataView } } : {}),
          loading: false,
          ...(artifact.dataViewError ? { error: artifact.dataViewError } : {}),
        },
      }));
      return;
    }
    setArtifactSidecarContent((current) => ({
      ...current,
      [tabId]: { artifact, loading: Boolean(chatStore.loadArtifact) },
    }));
    if (!chatStore.loadArtifact) {
      return;
    }
    try {
      const payload = await chatStore.loadArtifact({
        artifactId: artifact.id,
        sessionKey: activeSession.id,
      });
      const detail = projectLoadedArtifactDetail(artifact, payload);
      setArtifactSidecarContent((current) => current[tabId]
        ? { ...current, [tabId]: { ...current[tabId], detail, loading: false } }
        : current);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setArtifactSidecarContent((current) => current[tabId]
        ? { ...current, [tabId]: { ...current[tabId], error: message, loading: false } }
        : current);
    }
  }

  async function handleOpenAssistantFileLink(link: AssistantFileLink) {
    if (!activeSession) {
      return;
    }

    let artifact: ArtifactRef;
    try {
      artifact = assistantFileArtifact(resolveAssistantFileLink(link.href, activeSession.workingDirectory));
    } catch (error) {
      artifact = assistantFileArtifact({ path: link.href, title: assistantFileLinkTitle(link.href) });
      const tabId = sidecarArtifactTabId(activeSession.id, artifact.id);
      dispatchSidecar({
        artifactId: artifact.id,
        threadId: activeSession.id,
        title: artifact.title,
        type: "tab.openArtifact",
      });
      const message = error instanceof AssistantFileLinkError && error.code === "outside_workspace"
        ? t("details.fileOutsideWorkspace")
        : errorMessage(error);
      console.error("[artifact-preview] workspace file link resolution failed", {
        error,
        href: link.href,
        sessionId: activeSession.id,
        workspaceRoot: activeSession.workingDirectory,
      });
      setArtifactSidecarContent((current) => ({
        ...current,
        [tabId]: { artifact, error: message, loading: false },
      }));
      return;
    }

    const tabId = sidecarArtifactTabId(activeSession.id, artifact.id);
    dispatchSidecar({
      artifactId: artifact.id,
      threadId: activeSession.id,
      title: artifact.title,
      type: "tab.openArtifact",
    });
    if (!workspaceStore) {
      const message = t("details.filePreviewUnavailable");
      console.error("[artifact-preview] workspace file API unavailable", {
        path: artifact.fetchPath,
        sessionId: activeSession.id,
      });
      setArtifactSidecarContent((current) => ({
        ...current,
        [tabId]: { artifact, error: message, loading: false },
      }));
      return;
    }

    setArtifactSidecarContent((current) => ({
      ...current,
      [tabId]: { artifact, loading: true },
    }));
    try {
      const file = await workspaceStore.readThreadFile({
        path: artifact.fetchPath!,
        threadId: activeSession.id,
      });
      const officeKind = resolveOfficeArtifactKind({
        mimeType: artifact.mimeType,
        path: artifact.fetchPath,
        title: artifact.title,
      });
      if (file.contentType === "binary" && officeKind) {
        if (!workspaceStore.readThreadFileBytes) {
          throw new Error(t("details.filePreviewUnavailable"));
        }
        logRendererEvent("info", "artifact.office.bytes.started", {
          format: officeKind,
          sizeBytes: file.sizeBytes,
        });
        const bytes = await workspaceStore.readThreadFileBytes({
          expectedRevision: file.revision,
          path: artifact.fetchPath!,
          threadId: activeSession.id,
        });
        logRendererEvent("info", "artifact.office.bytes.completed", {
          format: officeKind,
          sizeBytes: bytes.byteLength,
        });
        setArtifactSidecarContent((current) => current[tabId]
          ? {
              ...current,
              [tabId]: {
                ...current[tabId],
                loading: false,
                office: { bytes, kind: officeKind, title: artifact.title },
              },
            }
          : current);
        return;
      }
      if (file.contentType !== "text") {
        throw new Error(t("details.binaryFilePreviewUnsupported"));
      }
      const detail: LoadedArtifactDetail = {
        id: artifact.id,
        mimeType: artifact.mimeType,
        textContent: file.content ?? "",
        title: artifact.title,
      };
      setArtifactSidecarContent((current) => current[tabId]
        ? {
            ...current,
            [tabId]: {
              ...current[tabId],
              detail,
              loading: false,
              ...(file.nextCursor ? { notice: t("details.filePreviewTruncated") } : {}),
            },
          }
        : current);
    } catch (error) {
      const message = errorMessage(error);
      logRendererEvent("error", "artifact.workspace_file.read.failed", {
        error: message.slice(0, 512),
        mimeType: artifact.mimeType,
      });
      console.error("[artifact-preview] workspace file read failed", {
        error,
        path: artifact.fetchPath,
        sessionId: activeSession.id,
      });
      setArtifactSidecarContent((current) => current[tabId]
        ? { ...current, [tabId]: { ...current[tabId], error: message, loading: false } }
        : current);
    }
  }

  async function handleCloseSidecarTab(tab: SidecarTab) {
    if (tab.kind === "browser") {
      setBrowserProvisionErrors((current) => omitRecordKey(current, tab.id));
      const browserRuntime = chatStore.browserRuntime;
      if (!browserRuntime || !tab.browserSessionId || !tab.nativeTabId) {
        dispatchSidecar({ tabId: tab.id, type: "tab.close" });
        return;
      }
      try {
        let snapshot = await browserRuntime.snapshot(tab.browserSessionId);
        const remainingResources = sidecarRef.current.tabs.filter((candidate) => (
          candidate.kind === "browser"
            && candidate.threadId === tab.threadId
            && candidate.id !== tab.id
        ));
        if (snapshot.data.tabs.length === 1 && remainingResources.length) {
          snapshot = await browserRuntime.createTab(snapshot.data.browserSessionId);
        }
        if (snapshot.data.tabs.length === 1) {
          await browserRuntime.closeSession(snapshot.data.browserSessionId);
          clearBrowserSnapshot(snapshot.data.browserSessionId);
          dispatchSidecar({ tabId: tab.id, type: "tab.close" });
          return;
        }
        const next = await browserRuntime.closeTab(snapshot.data.browserSessionId, tab.nativeTabId);
        dispatchSidecar({ tabId: tab.id, type: "tab.close" });
        synchronizeBrowserSnapshot(next);
      } catch (error) {
        setBrowserProvisionErrors((current) => ({ ...current, [tab.id]: errorMessage(error) }));
      }
      return;
    }

    if (tab.kind === "terminal") {
      setTerminalErrors((current) => omitRecordKey(current, tab.id));
      try {
        await chatStore.terminalRuntime?.terminate(tab.id);
      } catch (error) {
        setTerminalErrors((current) => ({ ...current, [tab.id]: errorMessage(error) }));
        return;
      }
      dispatchSidecar({ tabId: tab.id, type: "tab.close" });
      return;
    }

    dispatchSidecar({ tabId: tab.id, type: "tab.close" });
    if (tab.kind === "artifact") {
      setArtifactSidecarContent((current) => omitRecordKey(current, tab.id));
    }
  }

  function renderSidecarArtifact(tab: SidecarArtifactTab) {
    const content = artifactSidecarContent[tab.id];
    if (!content) {
      return <p className="react-empty-state">{t("details.noPreview")}</p>;
    }
    return (
      <ArtifactDetails
        artifact={content.artifact}
        detail={content.detail}
        error={content.error}
        loading={content.loading}
        notice={content.notice}
        office={content.office}
        onAskForSpreadsheetChange={handleSpreadsheetAskForChange}
        onOpenFileLink={handleOpenAssistantFileLink}
      />
    );
  }

  function renderSidecarBrowser(tab: SidecarBrowserTab, surfaceVisible: boolean) {
    return (
      <SidecarBrowser
        browserRuntime={chatStore.browserRuntime}
        externalError={browserProvisionErrors[tab.id] || browserError}
        snapshot={browserSnapshot?.data.sessionId === tab.threadId ? browserSnapshot : undefined}
        surfaceVisible={surfaceVisible && !drawer}
        tab={tab}
        onHandoffComplete={() => handleBrowserHandoffComplete(tab)}
        onRetryProvision={() => {
          clearBrowserError();
          setBrowserProvisionErrors((current) => omitRecordKey(current, tab.id));
          setBrowserProvisionEpoch((current) => current + 1);
        }}
        onSnapshot={synchronizeBrowserSnapshot}
      />
    );
  }

  function renderSidecarTerminal(tab: SidecarTerminalTab) {
    return (
      <Suspense fallback={(
        <div aria-busy="true" className="react-sidecar__deferred" role="status">
          <Loader2 aria-hidden="true" size={18} />
          <span>{t("sidecar.terminalStarting")}</span>
        </div>
      )}>
        <LazySidecarTerminal
          externalError={terminalErrors[tab.id]}
          tab={tab}
          terminalRuntime={chatStore.terminalRuntime}
          workspaceLabel={activeWorkspaceLabel}
        />
      </Suspense>
    );
  }

  async function handleBrowserHandoffComplete(tab: SidecarBrowserTab) {
    if (!activeSession || activeSession.id !== tab.threadId) return;
    try {
      await dispatchTurn(activeSession.id, { text: t("browserHandoffContinue") }, "browser-handoff-complete");
      await handleSessionStoreRefresh(activeSession);
    } catch (error) {
      reportTimelineError(t("sidecar.browserHandoffFailed", { message: errorMessage(error) }));
    }
  }

  async function handleSubmitAgentUiForm(
    form: AgentUiForm,
    values: Record<string, unknown>,
  ) {
    if (!activeSession || isThreadCommandInFlight(commandLifecycle)) {
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
    const command = createThreadFormSubmitCommand({
      formId: form.form_id,
      sessionId: activeSession.id,
      source: { control: "chat-form", surface: "chat" },
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

  async function handleCancelAgentUiForm(form: AgentUiForm) {
    if (!activeSession || isThreadCommandInFlight(commandLifecycle)) {
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
    const command = createThreadFormCancelCommand({
      formId: form.form_id,
      sessionId: activeSession.id,
      source: { control: "chat-form", surface: "chat" },
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

  function handleSpreadsheetAskForChange(
    artifact: ArtifactRef,
    request: SpreadsheetCellChangeRequest,
  ): void {
    const id = `spreadsheet:${artifact.id}:${request.sheet}:${request.address}`;
    const annotation: SpreadsheetComposerAnnotation = {
      filePath: artifact.fetchPath || artifact.title,
      fileTitle: artifact.title,
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
        sessions={displayedSessions}
      >
      <div
        className="react-chat-workspace"
        data-sidecar-presentation={sidecar.presentation}
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
            onCreate={() => void handleCreateSession()}
            showCreate={resolvedSessionSidebarCollapsed}
          />
          <div className="react-chat-header__actions">
            <button
              aria-label={sidecar.presentation === "closed" ? t("sidecar.show") : t("sidecar.hide")}
              aria-pressed={sidecar.presentation !== "closed"}
              title={sidecar.presentation === "closed" ? t("sidecar.show") : t("sidecar.hide")}
              type="button"
              onClick={() => dispatchSidecar({
                type: sidecar.presentation === "closed" ? "presentation.show" : "presentation.hide",
              })}
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
              onOpenTool: (toolCall) => setDrawer({ kind: "tool", title: toolCall.name, toolCall }),
            }}
            error={timelineError}
            hookResults={hookResults}
            interactiveFormIds={interactiveFormIds}
            latestFailedTurnId={latestFailedTurnId}
            optimisticMessages={optimisticMessages}
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
            {threadCommandLifecycleLabel(commandLifecycle, t)}
          </p>
        ) : null}
        <div className="react-composer-drop-target">
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
            contextReferences={composerSpreadsheetContextReferences}
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
              const saveDefault = settingsStore?.saveDefaultChatModel;
              const persistence = defaultModelSavePromise.current
                .catch(() => undefined)
                .then(() => {
                  if (!saveDefault || !selected.providerId) {
                    throw new Error("Native default Provider/model persistence is unavailable.");
                  }
                  return saveDefault({
                    modelId: selectedModelId,
                    providerId: selected.providerId,
                  });
                });
              defaultModelSavePromise.current = persistence;
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
          onClearContextReferences={() => setComposerSpreadsheetAnnotations([])}
          onClearSkills={() => setComposerSelectedSkillIds([])}
          onRemoveContextReference={(id) => setComposerSpreadsheetAnnotations((current) => (
            current.filter((annotation) => annotation.id !== id)
          ))}
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

      {sidecar.presentation !== "closed" ? (
        <Sidecar
          activeTabId={sidecarActiveTab?.id ?? ""}
          canCreateBrowser={Boolean(activeSession)}
          canCreateTerminal={Boolean(activeWorkspaceId)}
          presentation={sidecar.presentation}
          renderArtifact={renderSidecarArtifact}
          renderBrowser={renderSidecarBrowser}
          renderTerminal={renderSidecarTerminal}
          tabs={sidecarTabs}
          width={sidecar.width}
          onActivateTab={(tabId) => dispatchSidecar({ tabId, type: "tab.activate" })}
          onCloseTab={handleCloseSidecarTab}
          onCreateBrowser={() => dispatchSidecar({ type: "tab.newBrowser" })}
          onCreateTerminal={(shell) => dispatchSidecar({ shell, type: "tab.newTerminal" })}
          onHide={() => dispatchSidecar({ type: "presentation.hide" })}
          onResize={(width, maxWidth) => dispatchSidecar({ maxWidth, type: "presentation.resize", width })}
          onToggleExpanded={() => dispatchSidecar({ type: "presentation.toggleExpanded" })}
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
            ) : (
              <SubagentDetails delegate={drawer.delegate} error={drawer.error} loading={drawer.loading} />
            )}
          </div>
        </aside>
      ) : null}
      </div>
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

function agentUiFormCorrelationString(form: AgentUiForm, key: string): string {
  const value = form.correlation[key];
  return typeof value === "string" ? value : "";
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
    supportsImageInput: model.supportsImageInput,
    ...(model.supportsImageInput ? { badge: t("composer.imageInput") } : {}),
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
  notice,
  office,
  onAskForSpreadsheetChange,
  onOpenFileLink,
}: {
  artifact: ArtifactRef;
  detail?: LoadedArtifactDetail;
  error?: string;
  loading: boolean;
  notice?: string;
  office?: OfficeArtifactSource;
  onAskForSpreadsheetChange: (artifact: ArtifactRef, request: SpreadsheetCellChangeRequest) => void;
  onOpenFileLink: (link: AssistantFileLink) => void;
}) {
  const { t } = useTranslation("chat");
  const markdown = isMarkdownArtifact(artifact, detail);
  const markdownContent = detail?.textContent && markdown
    ? { text: detail.textContent, title: detail.title }
    : undefined;
  return (
    <div className="react-artifact-detail" data-content={markdown || office?.kind === "document" ? "document" : "preview"}>
      {!markdown && !office ? (
        <dl>
          <div><dt>{t("details.id")}</dt><dd>{artifact.id}</dd></div>
          {detail?.mimeType || artifact.mimeType ? <div><dt>{t("details.type")}</dt><dd>{detail?.mimeType || artifact.mimeType}</dd></div> : null}
        </dl>
      ) : null}
      {loading ? <p aria-live="polite">{t("details.loadingArtifact")}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <p className="react-artifact-detail__notice">{notice}</p> : null}
      {detail?.imageDataUrl ? <img alt={detail.title} src={detail.imageDataUrl} /> : null}
      {detail?.dataView ? <DataViewCard artifact={{ ...artifact, dataView: detail.dataView }} expanded /> : null}
      {office ? (
        <OfficeArtifactPreview
          onAskForChange={(selection) => onAskForSpreadsheetChange(artifact, selection)}
          source={office}
        />
      ) : null}
      {markdownContent ? (
        <article aria-label={markdownContent.title} className="react-artifact-detail__document" role="document">
          <AssistantMarkdown
            onOpenFileLink={onOpenFileLink}
            streaming={false}
            text={markdownContent.text}
          />
        </article>
      ) : detail?.textContent ? <pre className="react-artifact-detail__text">{detail.textContent}</pre> : null}
      {!loading && !error && !office && !detail?.dataView && !detail?.imageDataUrl && !detail?.textContent ? <p>{t("details.noPreview")}</p> : null}
    </div>
  );
}

function isMarkdownArtifact(artifact: ArtifactRef, detail?: LoadedArtifactDetail): boolean {
  const mimeType = (detail?.mimeType || artifact.mimeType || "").split(";", 1)[0].trim().toLowerCase();
  return artifact.kind.toLowerCase() === "markdown" || mimeType === "text/markdown";
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

function browserResourceTitle(title: string, url: string, fallback: string): string {
  const normalizedTitle = title.trim();
  if (normalizedTitle && normalizedTitle !== "about:blank" && normalizedTitle !== "New tab") {
    return normalizedTitle;
  }
  if (!url || url === "about:blank") return fallback;
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
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

function omitRecordKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

function boundedSpreadsheetSelectionValue(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 160 ? `${normalized.slice(0, 159)}…` : normalized;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
