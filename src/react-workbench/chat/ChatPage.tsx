import { useEffect, useId, useMemo, useReducer, useRef, useState, type CSSProperties } from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Circle,
  Copy,
  FolderOpen,
  GitBranch,
  Loader2,
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
import {
  MAX_QUEUED_INPUTS,
  deleteQueuedInput,
  dispatchNextQueuedInput,
  pauseQueuedInputs,
  resumeNextQueuedInput,
  submitComposerText,
  type SubmitComposerTextResult,
} from "../../app-core/chat/chatInputState";
import type { QueuedInput } from "../../app-core/chat/chatUiProjection";
import {
  ClaudeStyleAiInput,
  type ComposerContextReference,
  type ComposerSendOptions,
  type ComposerToolOption,
  type FileWithPreview,
  type ModelOption,
  type PastedContent,
} from "../../components/ui/claude-style-ai-input";
import { TextType } from "../../components/ui/TextType";
import { formatRelativeUpdatedTime } from "../lib/relativeTime";
import type { ApprovalAction, ChatEvent, ChatInput, ChatModelOption, ChatStore, SessionStore, SessionSummary, SettingsStore, WorkspaceStore } from "../services";
import { reduceSessionDeleteState } from "../sessions/sessionDeleteState";
import { canBranchFromMessage, canCopyMessage, type ContextReferenceSummary, type ReactChatMessage, type ToolCallSummary } from "./messageActions";
import type { AgentUiForm } from "../../app-core/agent-ui/agentUiEvents";
import { AgentUiFormCard } from "./AgentUiFormCard";
import { AssistantMarkdown } from "./AssistantMarkdown";
import { clampTinyOsWidth, LiveCanvas, type LiveCanvasEntry, type LiveCanvasMode } from "./LiveCanvas";
import {
  applyLoadedDelegatedAgentTrace,
  projectLoadedArtifactDetail,
  type ArtifactRef,
  type ChatStep,
  type ChatTurn,
  type DelegatedAgentState,
  type LoadedArtifactDetail,
  type TokenUsage,
  type ToolCallState,
} from "../../app-core/chat/chatRunModel";
import type { ChatTimelineSnapshot } from "../../app-core/chat/agentTimelineModel";
import type { NativeChatReference } from "../../app-core/chat/nativeChat";
import type { TinyOsContextReference } from "../../app-core/chat/tinyOsUiState";
import { useTinyOsFilesController } from "./useTinyOsFilesController";
import {
  TINYOS_COMMAND_ACK_TIMEOUT_MS,
  canonicalTinyOsCommandAcknowledgement,
  canonicalTinyOsCommandCompletion,
  createTinyOsAgentCancelCommand,
  createTinyOsApprovalResolveCommand,
  createTinyOsFormCancelCommand,
  createTinyOsFormSubmitCommand,
  isTinyOsCommandInFlight,
  reduceTinyOsCommandLifecycle,
  type TinyOsCommandLifecycle,
} from "../../app-core/chat/tinyOsCommandGateway";
import {
  unavailableTinyOsEffectiveCapabilities,
  type TinyOsEffectiveCapabilities,
} from "../../app-core/chat/tinyOsCapabilities";

export type ChatPageProps = {
  chatStore: ChatStore;
  sessionStore: SessionStore;
  settingsStore?: SettingsStore;
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

type LiveCanvasState = {
  mode: LiveCanvasMode;
  selection?: { itemId: string; turnId: string };
  surface: "panel" | "expanded";
  visibility: "closed" | "open";
};

type LiveCanvasAction =
  | { type: "close" }
  | { type: "expand_toggle" }
  | { type: "return_live" }
  | { type: "select"; itemId: string; turnId: string }
  | { type: "toggle" };

const INITIAL_LIVE_CANVAS_STATE: LiveCanvasState = {
  mode: "live_follow",
  surface: "panel",
  visibility: "closed",
};

function reduceLiveCanvasState(state: LiveCanvasState, action: LiveCanvasAction): LiveCanvasState {
  switch (action.type) {
    case "close":
      return state.visibility === "closed" ? state : { ...state, visibility: "closed" };
    case "expand_toggle":
      return { ...state, surface: state.surface === "expanded" ? "panel" : "expanded", visibility: "open" };
    case "return_live":
      return { ...state, mode: "live_follow", visibility: "open" };
    case "select":
      return { ...state, mode: "history", selection: { itemId: action.itemId, turnId: action.turnId }, visibility: "open" };
    case "toggle":
      return state.visibility === "open"
        ? { ...state, visibility: "closed" }
        : { ...state, mode: "live_follow", visibility: "open" };
  }
}

type RecoveryAction = "continue" | "retry" | "restart";

type QueuedComposerInput = QueuedInput & Pick<ChatInput, "model" | "references" | "usePersistentRag">;

function shouldFrameBatchTimeline(timeline: ChatTimelineSnapshot): boolean {
  return timeline.turns[timeline.turns.length - 1]?.status === "running";
}

function readStoredTinyOsWidth(): number {
  if (typeof window === "undefined") return 480;
  const stored = Number(window.localStorage.getItem(TINYOS_WIDTH_STORAGE_KEY));
  return Number.isFinite(stored) && stored > 0 ? clampTinyOsWidth(stored) : 480;
}

const COMPOSER_TOOLS: ComposerToolOption[] = [
  {
    id: "knowledge-rag",
    name: "Knowledge RAG",
    description: "Use uploaded files and knowledge base material",
    enabled: true,
  },
];

const EMPTY_CHAT_PROMPTS = [
  "规划一个任务并列出执行步骤",
  "分析当前项目并提出改进建议",
  "整理资料并形成一份简短摘要",
  "检查方案中可能遗漏的问题",
] as const;

const SESSION_DELETE_DISSOLVE_MS = 760;
const SESSION_DELETE_PARTICLE_COUNT = 220;
const TINYOS_WIDTH_STORAGE_KEY = "tinybot.ui.tinyos.width";

type SessionDeleteParticle = {
  id: number;
  originX: number;
  originY: number;
  x: number;
  y: number;
  size: number;
  delay: number;
};

const SESSION_DELETE_PARTICLES: SessionDeleteParticle[] = Array.from(
  { length: SESSION_DELETE_PARTICLE_COUNT },
  (_, index) => {
    const angle = (index / SESSION_DELETE_PARTICLE_COUNT) * Math.PI * 2 + ((index % 7) - 3) * 0.018;
    const distance = 30 + (index % 9) * 7 + (Math.floor(index / 9) % 4) * 5;

    return {
      id: index,
      originX: 12 + (index * 17) % 76,
      originY: 18 + (index * 11) % 60,
      x: Math.round(Math.cos(angle) * distance * 1.45),
      y: Math.round(Math.sin(angle) * distance * 0.95),
      size: 0.62 + (index % 6) * 0.11,
      delay: (index % 22) * 2.5,
    };
  },
);

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
  settingsStore,
  workspaceStore,
}: ChatPageProps) {
  const tinyOsUiScope = useId();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState("");
  const [timeline, setTimeline] = useState<ChatTimelineSnapshot | null>(null);
  const [optimisticMessages, setOptimisticMessages] = useState<ReactChatMessage[]>([]);
  const [timelineError, setTimelineError] = useState("");
  const [tinyOsCapabilities, setTinyOsCapabilities] = useState<TinyOsEffectiveCapabilities>(() => (
    unavailableTinyOsEffectiveCapabilities("", "loading", "Loading effective capabilities.")
  ));
  const [composerModels, setComposerModels] = useState<ModelOption[]>([]);
  const [defaultComposerModel, setDefaultComposerModel] = useState("");
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  const [sessionSearchOpen, setSessionSearchOpen] = useState(false);
  const [localSessionSidebarCollapsed, setLocalSessionSidebarCollapsed] = useState(false);
  const [drawer, setDrawer] = useState<DrawerState>(null);
  const [liveCanvas, dispatchLiveCanvas] = useReducer(reduceLiveCanvasState, INITIAL_LIVE_CANVAS_STATE);
  const [commandLifecycle, dispatchCommandLifecycle] = useReducer(
    reduceTinyOsCommandLifecycle,
    { stage: "idle" } as TinyOsCommandLifecycle,
  );
  const [tinyOsWidth, setTinyOsWidth] = useState(readStoredTinyOsWidth);
  const [resolvingApprovalId, setResolvingApprovalId] = useState("");
  const [agentUiForms, setAgentUiForms] = useState<AgentUiForm[]>([]);
  const [queuedInputsBySession, setQueuedInputsBySession] = useState<Map<string, QueuedComposerInput[]>>(() => new Map());
  const [queueMessage, setQueueMessage] = useState("");
  const [composerDraft, setComposerDraft] = useState("");
  const [tinyOsContextReferences, setTinyOsContextReferences] = useState<TinyOsContextReference[]>([]);
  const [recoveringTurnId, setRecoveringTurnId] = useState("");
  const [showBackToLatest, setShowBackToLatest] = useState(false);
  const [dissolvingSessionIds, setDissolvingSessionIds] = useState<Set<string>>(() => new Set());
  const [deleteState, dispatchDelete] = useReducer(reduceSessionDeleteState, { confirmingSessionId: "" });
  const sessionsRef = useRef<SessionSummary[]>([]);
  const queuedInputsRef = useRef<Map<string, QueuedComposerInput[]>>(new Map());
  const queuedInputSequence = useRef(0);
  const deleteDissolveTimers = useRef<number[]>([]);
  const lastCreateSessionSignal = useRef(createSessionSignal);
  const draftSessionCreatePromise = useRef<Promise<SessionSummary> | null>(null);
  const optimisticSessionTitlesRef = useRef<Map<string, string>>(new Map());
  const conversationRef = useRef<HTMLDivElement | null>(null);
  const conversationEndRef = useRef<HTMLDivElement | null>(null);
  const liveCanvasHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const liveCanvasToggleRef = useRef<HTMLButtonElement | null>(null);
  const liveCanvasWasOpenRef = useRef(false);
  const stickToLatestRef = useRef(true);
  const resolvedSessionSidebarCollapsed = sessionSidebarCollapsed ?? localSessionSidebarCollapsed;
  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId) ?? sessions[0],
    [activeSessionId, sessions],
  );
  const tinyOsFiles = useTinyOsFilesController(activeSession?.id ?? "draft", workspaceStore, liveCanvas.visibility === "open");
  const draftNewSession = sessionsLoaded && !activeSession;
  const timelineLoaded = Boolean(activeSession) && timeline?.sessionId === activeSession?.id;
  const emptyActiveSession = draftNewSession || (timelineLoaded && timeline.turns.length === 0 && optimisticMessages.length === 0);
  const sessionRunning = activeSession?.status === "running" || activeSession?.status === "waiting_approval";
  const sessionResponding = sessionRunning && !emptyActiveSession;
  const activeRun = useMemo(() => [...(timeline?.turns ?? [])].reverse().find((turn) => (
    turn.status === "pending"
    || turn.status === "running"
    || turn.status === "awaiting_approval"
    || turn.status === "awaiting_user"
  )), [timeline]);
  const cancelCapability = tinyOsCapabilities.capabilities.agent.cancel;
  const capabilityTargetsActiveRun = !tinyOsCapabilities.evaluatedRunId
    || tinyOsCapabilities.evaluatedRunId === activeRun?.id;
  const canCancelRun = Boolean(
    activeSession
    && activeRun
    && tinyOsCapabilities.sessionId === activeSession.id
    && capabilityTargetsActiveRun
    && cancelCapability.available
  );
  const cancelUnavailableReason = !capabilityTargetsActiveRun
    ? "Effective capabilities are stale for the current Agent run."
    : cancelCapability.reason || "Cancellation is unavailable for this Agent run.";
  const cancelInFlight = isTinyOsCommandInFlight(commandLifecycle);
  const submittingFormId = commandLifecycle.stage !== "idle"
    && (commandLifecycle.command.kind === "form.submit" || commandLifecycle.command.kind === "form.cancel")
    && isTinyOsCommandInFlight(commandLifecycle)
    ? commandLifecycle.command.form.formId
    : "";
  const activeQueuedInputs = activeSession ? queuedInputsBySession.get(activeSession.id) ?? [] : [];
  const activeContextUsage = useMemo(() => latestTimelineUsage(timeline?.turns ?? []), [timeline]);
  const latestFailedTurnId = useMemo(() => (
    [...(timeline?.turns ?? [])].reverse().find((turn) => turn.status === "failed" || turn.status === "interrupted")?.id ?? ""
  ), [timeline]);
  const liveCanvasOpen = liveCanvas.visibility === "open";
  const liveCanvasEntries = useMemo<LiveCanvasEntry[]>(() => (
    (timelineLoaded ? timeline?.turns ?? [] : []).flatMap((turn) => (
      (turn.executionItems ?? turn.steps).map((step) => ({ step, turnId: turn.id }))
    ))
  ), [timeline, timelineLoaded]);
  const latestLiveCanvasEntry = liveCanvasEntries[liveCanvasEntries.length - 1];
  const latestLiveCanvasAttention = useMemo(() => [...liveCanvasEntries].reverse().find(({ step }) => (
    step.kind === "error"
      || step.status === "failed"
      || step.status === "cancelled"
      || ((step.kind === "approval" || step.kind === "form") && step.status !== "completed")
  )), [liveCanvasEntries]);
  const selectedLiveCanvasEntry = liveCanvas.mode === "live_follow"
    ? latestLiveCanvasEntry
    : liveCanvasEntries.find((entry) => entry.turnId === liveCanvas.selection?.turnId && entry.step.id === liveCanvas.selection.itemId);

  const openLiveCanvasItem = (turnId: string, step: ChatStep) => {
    dispatchLiveCanvas({ type: "select", itemId: step.id, turnId });
  };

  const handleAttachTinyOsContext = (reference: TinyOsContextReference) => {
    const id = tinyOsContextReferenceId(reference);
    setTinyOsContextReferences((current) => [
      ...current.filter((candidate) => tinyOsContextReferenceId(candidate) !== id),
      reference,
    ]);
  };

  useEffect(() => {
    if (liveCanvasOpen && !liveCanvasWasOpenRef.current) {
      liveCanvasHeadingRef.current?.focus();
    } else if (!liveCanvasOpen && liveCanvasWasOpenRef.current) {
      liveCanvasToggleRef.current?.focus();
    }
    liveCanvasWasOpenRef.current = liveCanvasOpen;
  }, [liveCanvasOpen]);

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    if (!activeSessionId) {
      setTinyOsCapabilities(unavailableTinyOsEffectiveCapabilities("", "no_session", "No session is selected."));
      return;
    }
    let cancelled = false;
    setTinyOsCapabilities(unavailableTinyOsEffectiveCapabilities(
      activeSessionId,
      "loading",
      "Loading effective capabilities.",
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
  }, [activeRun?.id, activeRun?.status, activeSessionId, chatStore]);

  useEffect(() => {
    setTinyOsContextReferences([]);
    dispatchCommandLifecycle({ type: "reset" });
  }, [activeSession?.id]);

  useEffect(() => {
    if (!timeline || commandLifecycle.stage === "idle" || commandLifecycle.stage === "completed") return;
    if (commandLifecycle.stage === "acknowledged") {
      const completion = canonicalTinyOsCommandCompletion(
        timeline.turns,
        commandLifecycle.command.commandId,
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
    if (commandLifecycle.command.kind === "approval.resolve") {
      if (commandLifecycle.stage === "rejected" || commandLifecycle.stage === "timed_out") {
        setResolvingApprovalId("");
        setTimelineError(`Approval failed: ${commandLifecycle.error}`);
        return;
      }
      if (commandLifecycle.stage === "completed") {
        setResolvingApprovalId("");
      }
      return;
    }
    if ((commandLifecycle.command.kind === "form.submit" || commandLifecycle.command.kind === "form.cancel")
      && (commandLifecycle.stage === "rejected" || commandLifecycle.stage === "timed_out")) {
      setTimelineError(`Form ${commandLifecycle.command.kind === "form.cancel" ? "cancellation" : "submission"} failed: ${commandLifecycle.error}`);
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
      setActiveSessionId((current) => current || nextSessions[0]?.id || "");
    });
    return () => {
      cancelled = true;
    };
  }, [sessionStore]);

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
      setOptimisticMessages([]);
      setTimelineError("");
      return;
    }
    setTimeline(null);
    setOptimisticMessages([]);
    setTimelineError("");
    setAgentUiForms([]);
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
      setOptimisticMessages((current) => current.filter((message) => !nextTimeline.turns.some((turn) => (
        turn.userMessage.clientEventId === message.id
      ))));
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
      if (event.command && event.type === "command.dispatched") {
        pauseQueuedInputsForSession(event.command.target.sessionId);
        dispatchCommandLifecycle({ command: event.command, nowMs: now(), type: "dispatch" });
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
        dispatchCommandLifecycle({ commandId: event.commandId, error: event.error || "Command rejected", type: "rejected" });
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
        setOptimisticMessages((current) => (
          current.some((message) => message.id === nextMessage.id)
            ? current.map((message) => (
              message.id === nextMessage.id ? { ...message, ...nextMessage } : message
            ))
            : [...current, nextMessage]
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
      const nextModels = models.map(toComposerModelOption);
      setComposerModels(nextModels);
      setDefaultComposerModel(models.find((model) => model.default)?.id ?? nextModels[0]?.id ?? "");
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
    onStopGenerationTargetChange?.(activeSession && sessionResponding ? activeSession.id : "");
  }, [activeSession?.id, onStopGenerationTargetChange, sessionResponding]);

  useEffect(() => {
    if (stickToLatestRef.current) {
      conversationEndRef.current?.scrollIntoView({ block: "end" });
    }
  }, [timeline, optimisticMessages, agentUiForms.length]);

  async function handleCreateSession() {
    const created = await sessionStore.create();
    activateCreatedSession(created);
  }

  async function handleCreateSessionFromSearch() {
    await handleCreateSession();
    setSessionSearchOpen(false);
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
        setActiveSessionId((current) => current === session.id ? remaining[0]?.id ?? "" : current);
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
    if (missingOptimisticSessions.length === 1 && replacementCandidates.length === 1) {
      const pendingSession = missingOptimisticSessions[0];
      const replacementSession = replacementCandidates[0];
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
    setActiveSessionId((current) => {
      if (preserveSession && current === preserveSession.id) {
        return preserveSession.id;
      }
      if (!nextSessions.length) {
        return "";
      }
      return nextSessions.some((session) => session.id === current) ? current : nextSessions[0]?.id ?? "";
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
    const nextTitle = window.prompt("Rename conversation", session.title)?.trim();
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
    setSessions(remaining);
    if (activeSessionId === session.id) {
      setActiveSessionId(remaining[0]?.id ?? "");
    }
    setHeaderMenuOpen(false);
  }

  async function handleBranchFromMessage(session: SessionSummary, messageId: string) {
    const branched = await chatStore.branchFromMessage(session.id, messageId);
    setSessions((current) => [branched, ...current.filter((item) => item.id !== branched.id)]);
    setActiveSessionId(branched.id);
  }

  async function handleComposerSend(
    message: string,
    files: FileWithPreview[],
    pastedContent: PastedContent[],
    options: ComposerSendOptions,
  ) {
    const references = tinyOsContextReferences.map(nativeReferenceFromTinyOs);
    const text = formatComposerMessage(
      message || (references.length ? "Use the attached TinyOS context." : ""),
      files,
      pastedContent,
    );
    const sendSession = activeSession ?? await createSessionForDraft();
    if (!text || !sendSession) {
      return;
    }
    const queuedResult = submitComposerText({
      approvals: [],
      content: text,
      isRunning: isQueueableRunningSession(sendSession, emptyActiveSession),
      now: nextQueuedInputTimestamp(),
      queuedInputs: activeQueuedInputs,
    });
    if (queuedResult.kind !== "send_message") {
      handleQueuedComposerResult(sendSession.id, queuedResult, options, references);
      return;
    }
    const optimisticSession = isDefaultSessionTitle(sendSession.title)
      ? { ...sendSession, title: deriveSessionTitle(queuedResult.content) }
      : sendSession;
    if (optimisticSession !== sendSession) {
      optimisticSessionTitlesRef.current.set(sendSession.id, optimisticSession.title);
      setSessions((current) => current.map((session) => session.id === sendSession.id ? optimisticSession : session));
    }
    await chatStore.send(sendSession.id, {
      text: queuedResult.content,
      ...(options.model ? { model: options.model } : {}),
      ...(references.length ? { references } : {}),
      ...(typeof options.usePersistentRag === "boolean" ? { usePersistentRag: options.usePersistentRag } : {}),
    });
    await handleSessionStoreRefresh(optimisticSession);
  }

  async function handleRecoverTurn(turn: ChatTurn, action: RecoveryAction): Promise<void> {
    if (!activeSession || recoveringTurnId) {
      return;
    }
    const failedStep = failedPlanStep(turn);
    setRecoveringTurnId(turn.id);
    try {
      if (action === "restart") {
        const created = await sessionStore.create({ title: deriveSessionTitle(turn.userMessage.text) });
        activateCreatedSession(created);
        await chatStore.send(created.id, { text: turn.userMessage.text });
        await handleSessionStoreRefresh(created);
        return;
      }
      const text = action === "retry"
        ? `请重新执行刚才失败的步骤${failedStep ? `“${failedStep}”` : ""}，保留已经完成的工作，然后继续完成任务。`
        : "请从刚才中断的位置继续，沿用现有上下文和计划；先确认当前进度，再完成剩余任务。";
      await chatStore.send(activeSession.id, { text });
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
    stickToLatestRef.current = nearBottom;
    setShowBackToLatest(!nearBottom);
  }

  function handleBackToLatest(): void {
    stickToLatestRef.current = true;
    setShowBackToLatest(false);
    conversationEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }

  function handleQueuedComposerResult(
    sessionId: string,
    result: Exclude<SubmitComposerTextResult, { kind: "send_message" }>,
    options: ComposerSendOptions,
    references: NativeChatReference[],
  ) {
    if (result.kind === "queue_limit_reached") {
      setQueueMessage("Already have 5 queued messages. Wait for processing or delete one before sending more.");
      return;
    }
    if (result.kind === "reject_approval_with_guidance") {
      return;
    }
    setQueueMessage("");
    updateQueuedInputsBySession((current) => {
      const next = new Map(current);
      next.set(sessionId, [...(next.get(sessionId) ?? []), {
        ...result.input,
        ...(options.model ? { model: options.model } : {}),
        ...(references.length ? { references } : {}),
        ...(typeof options.usePersistentRag === "boolean" ? { usePersistentRag: options.usePersistentRag } : {}),
      }]);
      return next;
    });
  }

  async function createSessionForDraft(): Promise<SessionSummary | null> {
    if (!draftNewSession) {
      return null;
    }
    if (!draftSessionCreatePromise.current) {
      draftSessionCreatePromise.current = sessionStore.create()
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
    setActiveSessionId(created.id);
  }

  function handleDeleteQueuedInput(sessionId: string, inputId: string) {
    setQueueMessage("");
    updateQueuedInputsBySession((current) => {
      const next = new Map(current);
      const remaining = deleteQueuedInput(next.get(sessionId) ?? [], inputId);
      if (remaining.length) {
        next.set(sessionId, remaining);
      } else {
        next.delete(sessionId);
      }
      return next;
    });
  }

  async function handleStopGeneration(session: SessionSummary, surface: "chat" | "tinyos") {
    if (cancelInFlight) return;
    if (!canCancelRun) {
      setTimelineError(`Cannot cancel: ${cancelUnavailableReason}`);
      return;
    }
    if (!activeRun) {
      setTimelineError("Cannot cancel: canonical active run is not available.");
      return;
    }
    const command = createTinyOsAgentCancelCommand({
      runId: activeRun.id,
      sessionId: session.id,
      source: { control: surface === "tinyos" ? "system-bar-cancel" : "stop-response", surface },
      threadId: activeRun.canonicalItems?.find((item) => item.threadId)?.threadId,
      turnId: activeRun.id,
    });
    pauseQueuedInputsForSession(session.id);
    dispatchCommandLifecycle({ command, nowMs: now(), type: "dispatch" });
    try {
      await chatStore.dispatchCommand(command);
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

  async function handleResumeQueuedInputs(sessionId: string) {
    await sendNextQueuedInput(sessionId, "manual_resume");
  }

  async function sendNextQueuedInput(sessionId: string, mode: "normal_completion" | "manual_resume") {
    const inputs = queuedInputsRef.current.get(sessionId) ?? [];
    const result = mode === "manual_resume" ? resumeNextQueuedInput(inputs) : dispatchNextQueuedInput(inputs);
    if (!result.nextInput) {
      return;
    }
    await chatStore.send(sessionId, toChatInput(result.nextInput as QueuedComposerInput));
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

  async function handleResolveApproval(approvalId: string, action: ApprovalAction, surface: "chat" | "tinyos") {
    if (!activeSession || !approvalId) {
      return;
    }
    if (isTinyOsCommandInFlight(commandLifecycle)) {
      return;
    }
    if (!activeRun) {
      setTimelineError("Cannot resolve approval: canonical active run is not available.");
      return;
    }
    const command = createTinyOsApprovalResolveCommand({
      action,
      approvalId,
      runId: activeRun.id,
      sessionId: activeSession.id,
      source: { control: surface === "tinyos" ? "inspector-approval" : "tool-approval", surface },
      threadId: activeRun.canonicalItems?.find((item) => item.threadId)?.threadId,
      turnId: activeRun.id,
    });
    setResolvingApprovalId(approvalId);
    setTimelineError("");
    dispatchCommandLifecycle({ command, nowMs: now(), type: "dispatch" });
    try {
      await chatStore.dispatchCommand(command);
    } catch (error) {
      dispatchCommandLifecycle({
        commandId: command.commandId,
        error: error instanceof Error ? error.message : String(error),
        type: "rejected",
      });
    }
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
    if (!activeRun) {
      setTimelineError("Cannot submit form: canonical active run is not available.");
      return;
    }
    const formRunId = agentUiFormCorrelationString(form, "run_id") || form.run_id || activeRun.id;
    if (formRunId !== activeRun.id) {
      setTimelineError(`Cannot submit form: request targets stale run ${formRunId}.`);
      return;
    }
    const command = createTinyOsFormSubmitCommand({
      formId: form.form_id,
      runId: activeRun.id,
      sessionId: activeSession.id,
      source: { control: surface === "tinyos" ? "system-form" : "chat-form", surface },
      threadId: agentUiFormCorrelationString(form, "thread_id")
        || activeRun.canonicalItems?.find((item) => item.threadId)?.threadId,
      turnId: activeRun.id,
      values,
    });
    setTimelineError("");
    dispatchCommandLifecycle({ command, nowMs: now(), type: "dispatch" });
    try {
      await chatStore.dispatchCommand(command);
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
    if (!activeRun) {
      setTimelineError("Cannot cancel form: canonical active run is not available.");
      return;
    }
    const formRunId = agentUiFormCorrelationString(form, "run_id") || form.run_id || activeRun.id;
    if (formRunId !== activeRun.id) {
      setTimelineError(`Cannot cancel form: request targets stale run ${formRunId}.`);
      return;
    }
    const command = createTinyOsFormCancelCommand({
      formId: form.form_id,
      runId: activeRun.id,
      sessionId: activeSession.id,
      source: { control: surface === "tinyos" ? "system-form" : "chat-form", surface },
      threadId: agentUiFormCorrelationString(form, "thread_id")
        || activeRun.canonicalItems?.find((item) => item.threadId)?.threadId,
      turnId: activeRun.id,
    });
    setTimelineError("");
    dispatchCommandLifecycle({ command, nowMs: now(), type: "dispatch" });
    try {
      await chatStore.dispatchCommand(command);
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
    setActiveSessionId(session.id);
    setSessionSearchOpen(false);
  }

  const visibleAgentUiForms = agentUiForms.filter(isVisibleAgentUiForm);
  const interactiveFormIds = new Set(visibleAgentUiForms.map((form) => form.form_id));
  const headerTitle = activeSession ? displaySessionTitle(activeSession.title) : draftNewSession ? "新会话" : "未选择会话";

  return (
    <section
      className="react-chat-page"
      data-live-canvas-expanded={liveCanvasOpen && liveCanvas.surface === "expanded" ? "true" : undefined}
      aria-label="Chat"
      data-live-canvas-open={liveCanvasOpen ? "true" : undefined}
      data-session-sidebar-collapsed={resolvedSessionSidebarCollapsed}
      style={{ "--tinyos-width": `${tinyOsWidth}px` } as CSSProperties}
    >
      <aside className="react-session-list" aria-label="Sessions" data-collapsed={resolvedSessionSidebarCollapsed}>
        <div className="react-session-list__header">
          <div className="react-session-list__title-row">
            <h2>会话</h2>
            <div className="react-session-list__title-actions">
              <button
                aria-label="Search chats"
                className="react-session-list__search"
                title="Search chats"
                type="button"
                onClick={() => setSessionSearchOpen(true)}
              >
                <Search aria-hidden="true" size={15} />
              </button>
              <button
                aria-label={resolvedSessionSidebarCollapsed ? "Expand session sidebar" : "Collapse session sidebar"}
                className="react-session-list__collapse"
                title={resolvedSessionSidebarCollapsed ? "Expand session sidebar" : "Collapse session sidebar"}
                type="button"
                onClick={() => handleSessionSidebarCollapsedChange(!resolvedSessionSidebarCollapsed)}
              >
                <ChevronLeft aria-hidden="true" data-direction={resolvedSessionSidebarCollapsed ? "expand" : "collapse"} size={16} />
              </button>
            </div>
          </div>
          <button aria-label="New Chat" className="react-session-list__new" type="button" onClick={handleCreateSession}>
            <Plus aria-hidden="true" size={15} />
            <span>新会话</span>
          </button>
        </div>
        <div className="react-session-list__rows" aria-label="Session list rows" data-motion="animated-list">
          {sessions.length ? sessions.map((session, index) => {
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
                    setActiveSessionId(session.id);
                  }}
                >
                  <span className="react-session-row__avatar" aria-hidden="true">{sessionTitleInitial(displaySessionTitle(session.title))}</span>
                  <span className="react-session-row__title">{displaySessionTitle(session.title)}</span>
                  <small>{formatRelativeUpdatedTime(session.updatedAtMs, now())}</small>
                </button>
                <button
                  aria-label={`${confirming ? "Confirm delete" : "Delete"} ${session.title}`}
                  className="react-session-row__delete"
                  data-confirming={confirming}
                  type="button"
                  disabled={dissolving}
                  onClick={() => void handleDeleteSession(session)}
                >
                  <Trash2 aria-hidden="true" size={15} />
                </button>
                {dissolving ? (
                  <span className="react-session-row__particles" aria-hidden="true">
                    {SESSION_DELETE_PARTICLES.map((particle) => (
                      <span
                        className="react-session-row__particle"
                        key={particle.id}
                        style={{
                          "--particle-delay": `${particle.delay}ms`,
                          "--particle-origin-x": `${particle.originX}%`,
                          "--particle-origin-y": `${particle.originY}%`,
                          "--particle-size": `${particle.size}px`,
                          "--particle-x": `${particle.x}px`,
                          "--particle-y": `${particle.y}px`,
                        } as CSSProperties}
                      />
                    ))}
                  </span>
                ) : null}
              </div>
            );
          }) : resolvedSessionSidebarCollapsed ? null : <EmptyStateText text="No sessions yet." />}
        </div>
      </aside>

      <main className="react-chat-surface" data-empty-session={emptyActiveSession ? "true" : undefined}>
        <header className="react-chat-header">
          <h1>{headerTitle}</h1>
          <div className="react-chat-header__actions">
            <button
              ref={liveCanvasToggleRef}
              aria-controls="tinybot-live-canvas"
              aria-expanded={liveCanvasOpen}
              aria-label={liveCanvasOpen
                ? "Close Live Canvas"
                : latestLiveCanvasAttention
                  ? "Open Live Canvas, attention required"
                  : liveCanvasEntries.length
                    ? "Open Live Canvas, Agent activity available"
                    : "Open Live Canvas"}
              className="react-live-canvas-toggle"
              data-active={liveCanvasOpen ? "true" : undefined}
              data-attention={latestLiveCanvasAttention ? "true" : undefined}
              data-has-activity={liveCanvasEntries.length ? "true" : undefined}
              title={liveCanvasOpen ? "Close Live Canvas" : "Open Live Canvas"}
              type="button"
              onClick={() => dispatchLiveCanvas({ type: "toggle" })}
            >
              {liveCanvasOpen ? <PanelRightClose aria-hidden="true" size={18} /> : <PanelRightOpen aria-hidden="true" size={18} />}
              {!liveCanvasOpen && liveCanvasEntries.length ? <span aria-hidden="true" className="react-live-canvas-toggle__status" /> : null}
            </button>
            <button
              aria-label="Open conversation menu"
              title="Open conversation menu"
              type="button"
              onClick={() => setHeaderMenuOpen((open) => !open)}
            >
              <MoreHorizontal aria-hidden="true" size={18} />
            </button>
            {headerMenuOpen ? (
              <div className="react-menu" role="menu">
                <button aria-label={activeSession?.pinned ? "Unpin conversation" : "Pin conversation"} role="menuitem" type="button" onClick={() => activeSession && void handlePinConversation(activeSession)}>
                  {activeSession?.pinned ? "取消置顶" : "置顶会话"}
                </button>
                <button aria-label="Rename conversation" role="menuitem" type="button" onClick={() => activeSession && void handleRenameConversation(activeSession)}>重命名会话</button>
                <button aria-label="Copy ID" role="menuitem" type="button" onClick={() => activeSession && void handleCopyId(activeSession)}>复制 ID</button>
                <button aria-label="Copy Markdown" role="menuitem" type="button" onClick={() => activeSession && void handleCopyMarkdown(activeSession)}>复制 Markdown</button>
                <button aria-label="Archive conversation" role="menuitem" type="button" onClick={() => activeSession && void handleArchiveConversation(activeSession)}>归档会话</button>
                <button disabled role="menuitem" type="button">Open side chat</button>
                <button disabled role="menuitem" type="button">Branch <ChevronDown aria-hidden="true" size={14} /></button>
                <button disabled role="menuitem" type="button">Open in new window</button>
              </div>
            ) : null}
          </div>
        </header>

        <div ref={conversationRef} className="react-conversation-view" aria-label="Conversation" aria-live="polite" onScroll={handleConversationScroll}>
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
              onOpenError={(step) => setDrawer({ kind: "error", title: "错误详情", step, turn })}
              onRecover={(action) => void handleRecoverTurn(turn, action)}
            />
          )) : emptyActiveSession ? <EmptyChatStart onSelectPrompt={setComposerDraft} /> : activeSession ? null : <EmptyStateText text="Select or create a session." />}
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
          {visibleAgentUiForms.length ? (
            <div className="react-agent-ui-forms" aria-label="Agent forms">
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
          <button className="react-back-to-latest" type="button" onClick={handleBackToLatest}>回到最新消息</button>
        ) : null}

        {activeSession && activeQueuedInputs.length ? (
          <QueuedInputsPanel
            inputs={activeQueuedInputs}
            onDelete={(inputId) => handleDeleteQueuedInput(activeSession.id, inputId)}
            onResume={() => void handleResumeQueuedInputs(activeSession.id)}
          />
        ) : null}
        {queueMessage ? <p className="react-queued-inputs__message">{queueMessage}</p> : null}
        {commandLifecycle.stage !== "idle" ? (
          <p
            aria-live="polite"
            className="react-agent-command-status"
            data-stage={commandLifecycle.stage}
            role={commandLifecycle.stage === "rejected" || commandLifecycle.stage === "timed_out" ? "alert" : "status"}
          >
            {tinyOsCommandLifecycleLabel(commandLifecycle)}
          </p>
        ) : null}
        <ClaudeStyleAiInput
          className={["react-composer", emptyActiveSession ? "react-composer--raised" : ""].filter(Boolean).join(" ")}
          contextReferences={tinyOsContextReferences.map(composerReferenceFromTinyOs)}
          disabled={!activeSession && !draftNewSession}
          disabledReason={!sessionsLoaded ? "正在加载会话…" : !activeSession && !draftNewSession ? "请先创建或选择一个会话" : undefined}
          defaultModel={defaultComposerModel}
          contextUsage={activeContextUsage}
          models={composerModels}
          responding={sessionResponding}
          canStopResponding={canCancelRun}
          stopUnavailableReason={cancelUnavailableReason}
          placeholder={emptyActiveSession ? "输入任务，或粘贴/拖入文件" : "输入消息给 Tinybot"}
          tools={COMPOSER_TOOLS}
          value={composerDraft}
          onClearContextReferences={() => setTinyOsContextReferences([])}
          onRemoveContextReference={(id) => setTinyOsContextReferences((current) => current.filter((reference) => tinyOsContextReferenceId(reference) !== id))}
          onValueChange={setComposerDraft}
          onSendMessage={(message, files, pastedContent, options) => handleComposerSend(message, files, pastedContent, options)}
          onStopResponding={() => activeSession && handleStopGeneration(activeSession, "chat")}
        />
      </main>

      {liveCanvasOpen ? (
        <LiveCanvas
          agentUiForms={visibleAgentUiForms}
          entries={liveCanvasEntries}
          expanded={liveCanvas.surface === "expanded"}
          headingRef={liveCanvasHeadingRef}
          mode={liveCanvas.mode}
          canCancelRun={canCancelRun}
          cancelUnavailableReason={activeRun && !canCancelRun ? cancelUnavailableReason : undefined}
          commandLifecycle={commandLifecycle}
          resolvingApprovalId={resolvingApprovalId}
          selection={selectedLiveCanvasEntry}
          sessionKey={`${tinyOsUiScope}:${activeSession?.id ?? "draft"}`}
          widthPx={tinyOsWidth}
          filesController={tinyOsFiles}
          onAttachContext={handleAttachTinyOsContext}
          onCancelForm={(form) => void handleCancelAgentUiForm(form, "tinyos")}
          onCancelRun={() => activeSession && void handleStopGeneration(activeSession, "tinyos")}
          onClose={() => dispatchLiveCanvas({ type: "close" })}
          onExpandedChange={() => dispatchLiveCanvas({ type: "expand_toggle" })}
          onOpenArtifact={(artifact) => void handleOpenArtifact(artifact)}
          onResolveApproval={(approvalId, action) => void handleResolveApproval(approvalId, action, "tinyos")}
          onReturnToLive={() => dispatchLiveCanvas({ type: "return_live" })}
          onSelectEntry={(entry) => openLiveCanvasItem(entry.turnId, entry.step)}
          onSubmitForm={(form, values) => void handleSubmitAgentUiForm(form, values, "tinyos")}
          onWidthChange={(widthPx) => {
            setTinyOsWidth(widthPx);
            window.localStorage.setItem(TINYOS_WIDTH_STORAGE_KEY, String(widthPx));
          }}
        />
      ) : null}

      {drawer ? (
        <aside className="react-right-drawer" aria-label="Details drawer" data-motion="fade-content" data-state="open">
          <div>
            <h2>{drawer.title}</h2>
            <button aria-label="Close details drawer" type="button" onClick={() => setDrawer(null)}>
              <X aria-hidden="true" size={16} />
            </button>
          </div>
          {drawer.kind === "tool" ? (
            <ToolCallDetails
              resolvingApprovalId={resolvingApprovalId}
              toolCall={drawer.toolCall}
              onResolveApproval={(toolCall, action) => toolCall.approvalId && void handleResolveApproval(toolCall.approvalId, action, "chat")}
            />
          ) : drawer.kind === "subagent" ? (
            <SubagentDetails delegate={drawer.delegate} error={drawer.error} loading={drawer.loading} />
          ) : drawer.kind === "artifact" ? (
            <ArtifactDetails artifact={drawer.artifact} detail={drawer.detail} error={drawer.error} loading={drawer.loading} />
          ) : (
            <ErrorDetails step={drawer.step} turn={drawer.turn} />
          )}
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
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const filteredSessions = normalizedQuery
    ? sessions.filter((session) => [session.title, session.chatId ?? "", session.id]
      .some((value) => value.toLowerCase().includes(normalizedQuery)))
    : sessions;
  const recommendations = [
    {
      id: "new-chat",
      label: "New Chat",
      shortcut: "Ctrl+N",
      icon: Plus,
      run: onCreateSession,
    },
    ...(onOpenFiles ? [{
      id: "open-files",
      label: "Open folder",
      shortcut: "Ctrl+O",
      icon: FolderOpen,
      run: () => {
        onOpenFiles();
        onClose();
      },
    }] : []),
    ...(onOpenSettings ? [{
      id: "open-settings",
      label: "Settings",
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
      <section aria-label="Chat search" className="react-command-palette react-session-search-dialog" role="dialog">
        <div className="react-session-search__input-row">
          <Search aria-hidden="true" size={18} />
          <input
            aria-label="Search chats or commands"
            autoFocus
            placeholder="搜索聊天或运行命令"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </div>
        <div className="react-session-search__section">
          <p>聊天</p>
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
                <span className="react-session-search__meta">tinybot</span>
                <kbd>{`Ctrl+${index + 1}`}</kbd>
                <small>{formatRelativeUpdatedTime(session.updatedAtMs, now())}</small>
              </button>
            )) : <span className="react-session-search__empty">No matching chats.</span>}
          </div>
        </div>
        <div className="react-session-search__section">
          <p>推荐</p>
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
  return (
    <section aria-label="Start a new chat" className="react-empty-chat-start" data-empty-session="true">
      <h2>想让 Tinybot 做什么？</h2>
      <p>选择一个建议，或直接在下方描述你的任务。</p>
      <div className="react-empty-chat-prompts" aria-label="Prompt suggestions">
        {EMPTY_CHAT_PROMPTS.map((prompt) => (
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

function shouldDispatchQueuedInputForChatEvent(event: ChatEvent): boolean {
  return event.type === "agent.event" && event.eventType === "agent.turn.completed";
}

function shouldPauseQueuedInputsForChatEvent(event: ChatEvent): boolean {
  return event.type === "interrupted"
    || (event.type === "agent.event" && (
      event.eventType === "agent.turn.failed" || event.eventType === "agent.turn.interrupted"
    ));
}

function canDispatchQueuedInputForSession(session: SessionSummary | undefined): boolean {
  return session?.status !== "running" && session?.status !== "waiting_approval" && session?.status !== "failed";
}

function latestTimelineUsage(turns: ChatTurn[]): TokenUsage | undefined {
  return [...turns].reverse().find((turn) => turn.usage)?.usage;
}

function isQueueableRunningSession(session: SessionSummary, emptyActiveSession: boolean): boolean {
  return session.status === "running" && !emptyActiveSession && !session.id.startsWith("pending:");
}

function toChatInput(input: QueuedComposerInput): ChatInput {
  return {
    text: input.content,
    ...(input.model ? { model: input.model } : {}),
    ...(input.references?.length ? { references: input.references } : {}),
    ...(typeof input.usePersistentRag === "boolean" ? { usePersistentRag: input.usePersistentRag } : {}),
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

function tinyOsCommandLifecycleLabel(lifecycle: TinyOsCommandLifecycle): string {
  const commandKind = lifecycle.stage === "idle" ? "agent.cancel" : lifecycle.command.kind;
  const operation = commandKind === "agent.cancel"
    ? "Cancel"
    : commandKind === "approval.resolve"
      ? "Approval"
      : commandKind === "form.cancel" ? "Form cancellation" : "Form submission";
  const completionOperation = commandKind === "agent.cancel" ? "Cancellation" : operation;
  switch (lifecycle.stage) {
    case "idle":
      return "";
    case "sending":
      return `Sending ${operation.toLowerCase()} command…`;
    case "waiting_for_canonical":
      return `${operation} delivered. Waiting for runtime confirmation…`;
    case "acknowledged":
      return `${operation} acknowledged by canonical item ${lifecycle.acknowledgement.itemId}. Waiting for completion.`;
    case "completed":
      return `${completionOperation} ${lifecycle.completion.status} at canonical item ${lifecycle.completion.itemId}.`;
    case "rejected":
    case "timed_out":
      return lifecycle.error;
  }
}

function agentUiFormCorrelationString(form: AgentUiForm, key: string): string {
  const value = form.correlation[key];
  return typeof value === "string" ? value : "";
}

function tinyOsReferenceLabel(reference: TinyOsContextReference): string {
  const lineRange = reference.startLine
    ? `L${reference.startLine}${reference.endLine && reference.endLine !== reference.startLine ? `–${reference.endLine}` : ""}`
    : "selection";
  return reference.kind === "file" ? `${reference.path} · ${lineRange}` : `${reference.command} · ${lineRange}`;
}

function composerReferenceFromTinyOs(reference: TinyOsContextReference): ComposerContextReference {
  return {
    detail: reference.kind === "file" ? "TinyOS file selection" : "TinyOS terminal output",
    id: tinyOsContextReferenceId(reference),
    kind: reference.kind,
    label: tinyOsReferenceLabel(reference),
  };
}

function nativeReferenceFromTinyOs(reference: TinyOsContextReference): NativeChatReference {
  const canonical = reference.kind === "terminal"
    ? { sourceItemId: reference.sourceItemId, turnId: reference.turnId }
    : reference.provenance.kind === "canonical"
      ? reference.provenance
      : undefined;
  const scope = canonical?.turnId ?? (reference.kind === "file" && reference.provenance.kind === "workspace_read"
    ? reference.provenance.workspaceKey
    : undefined);
  return {
    detail: reference.kind === "file" ? "TinyOS file selection" : "TinyOS terminal output selection",
    evidenceId: canonical?.sourceItemId,
    kind: "reference",
    scope,
    sourceEndLine: reference.endLine,
    sourceLine: reference.startLine,
    sourceText: reference.selectedText,
    title: tinyOsReferenceLabel(reference),
    type: reference.kind === "file" ? "tinyos.file" : "tinyos.terminal",
    ...(reference.kind === "file" ? {
      rawLine: reference.startLine,
      rawPath: reference.path,
      revision: reference.revision,
      sourcePath: reference.path,
    } : {}),
  };
}

function isVisibleAgentUiForm(form: AgentUiForm): boolean {
  return form.status !== "submitted" && form.status !== "cancelled" && form.status !== "expired";
}

async function writeClipboardText(value: string): Promise<void> {
  await navigator.clipboard?.writeText(value);
}

function formatComposerMessage(message: string, files: FileWithPreview[], pastedContent: PastedContent[]): string {
  const segments = [message.trim()].filter(Boolean);
  for (const pasted of pastedContent) {
    segments.push(`Pasted content:\n${pasted.content}`);
  }
  if (files.length) {
    segments.push([
      "Attached files:",
      ...files.map((item) => `- ${item.file.name} (${formatComposerFileSize(item.file.size)})`),
    ].join("\n"));
  }
  return segments.join("\n\n");
}

function formatComposerFileSize(bytes: number): string {
  if (bytes === 0) {
    return "0 Bytes";
  }
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${Number.parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

function toComposerModelOption(model: ChatModelOption): ModelOption {
  return {
    id: model.id,
    name: model.label || model.id,
    description: model.description || model.providerLabel || "Configured model",
    ...(model.default ? { badge: "Default" } : {}),
  };
}

function QueuedInputsPanel({
  inputs,
  onDelete,
  onResume,
}: {
  inputs: QueuedInput[];
  onDelete: (inputId: string) => void;
  onResume: () => void;
}) {
  const hasPausedInput = inputs.some((input) => input.status === "paused");
  return (
    <section aria-label="Queued inputs" className="react-queued-inputs">
      <div className="react-queued-inputs__header">
        <h2>Queued inputs</h2>
        <div>
          <span>{inputs.length}/{MAX_QUEUED_INPUTS}</span>
          {hasPausedInput ? <button type="button" onClick={onResume}>Resume queue</button> : null}
        </div>
      </div>
      <ol>
        {inputs.map((input) => (
          <li className="react-queued-input" data-status={input.status} key={input.id}>
            <span>{queuedInputStatusLabel(input)}</span>
            <p>{input.content}</p>
            {input.status === "queued" || input.status === "paused" ? (
              <button type="button" onClick={() => onDelete(input.id)}>Delete queued input</button>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
}

function queuedInputStatusLabel(input: QueuedInput): string {
  switch (input.status) {
    case "guided":
      return "Guided";
    case "paused":
      return "Paused";
    case "sent":
      return "Sent";
    default:
      return "Waiting";
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
  const executionItems = turn.executionItems ?? turn.steps;
  const finalAnswer = turn.finalAnswer ?? turn.finalMessage;
  const hasToolSteps = executionItems.some((step) => step.kind === "tool_call");
  const reasoningSteps = turn.steps.filter((step) => step.kind === "reasoning");
  const planSteps = turn.steps.filter((step) => step.kind === "plan");
  const errorSteps = turn.steps.filter((step) => step.kind === "error");
  const legacyProcessSteps = turn.steps.filter((step) => (
    step.kind !== "reasoning"
    && step.kind !== "plan"
    && step.kind !== "error"
    && !(step.kind === "form" && step.form && interactiveFormIds.has(step.form.formId))
  ));
  return (
    <section aria-label="Chat turn" className="react-canonical-turn" data-status={turn.status}>
      <CanonicalMessage
        messageId={turn.userMessage.id}
        role="user"
        text={turn.userMessage.text}
      />
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
                <AgentSteps onOpenTool={onOpenTool} toolCalls={group.map((step) => toolCallSummaryFromStep(step, step.toolCall!))} />
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
          onBranch={turn.status === "completed" && !hasToolSteps ? () => onBranch(finalAnswer.id) : undefined}
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
  const contentId = useId();
  const timelineRef = useRef<HTMLElement | null>(null);
  const abnormal = executionItems.some((step) => step.status === "failed" || step.status === "cancelled" || step.status === "blocked")
    || turn.status === "failed"
    || turn.status === "interrupted"
    || turn.status === "awaiting_approval"
    || turn.status === "awaiting_user";
  const hasFinalAnswer = Boolean(turn.finalAnswer ?? turn.finalMessage);
  const [foldIntent, setFoldIntent] = useState<ExecutionFoldIntent>("untouched");
  const [open, setOpen] = useState(() => abnormal || !hasFinalAnswer);
  const errorItems = executionItems.filter((step) => step.kind === "error");

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

  const summary = executionTimelineSummary(turn, executionItems, abnormal);
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
        <span className="react-execution-timeline__status"><AgentStepIcon status={abnormal ? "error" : hasFinalAnswer ? "success" : "active"} /></span>
        <span className="react-execution-timeline__heading">
          <strong>Execution details</strong>
          <small aria-live="polite">{summary}</small>
        </span>
        <ChevronDown aria-hidden="true" className="react-execution-timeline__chevron" size={18} />
      </button>
      <div className="react-execution-timeline__content" hidden={!open} id={contentId}>
        {executionItems.map((step) => (
          <div className="react-execution-timeline__item" data-kind={step.kind} data-status={step.status} key={step.id}>
            {step.kind === "tool_call" || step.kind === "approval" ? null : (
              <button
                aria-label={`View ${step.title} in Live Canvas`}
                className="react-execution-timeline__canvas-button"
                title="View in Live Canvas"
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

function executionTimelineSummary(turn: ChatTurn, items: ChatStep[], abnormal: boolean): string {
  const plan = [...items].reverse().find((step) => step.plan)?.plan;
  const durationMs = turn.completedAt
    ? Math.max(0, Date.parse(turn.completedAt) - Date.parse(turn.startedAt))
    : undefined;
  const parts = [executionStatusLabel(turn.status), `${items.length} ${items.length === 1 ? "item" : "items"}`];
  if (plan) {
    parts.push(`plan ${plan.completed}/${plan.total}`);
  }
  if (durationMs !== undefined && Number.isFinite(durationMs)) {
    parts.push(formatExecutionDuration(durationMs));
  }
  if (abnormal) {
    const blocked = items.find((step) => step.status === "failed" || step.status === "cancelled" || step.status === "blocked");
    parts.push(blocked?.title || "attention required");
  }
  return parts.join(" · ");
}

function executionStatusLabel(status: ChatTurn["status"]): string {
  switch (status) {
    case "completed": return "Completed";
    case "failed": return "Failed";
    case "interrupted": return "Interrupted";
    case "awaiting_approval": return "Awaiting approval";
    case "awaiting_user": return "Awaiting input";
    default: return "Running";
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
  references?: NativeChatReference[];
  role: "user" | "assistant";
  streaming?: boolean;
  text: string;
}) {
  return (
    <article className="react-message" data-actions-placement="bottom" data-role={role} data-testid={`message-${messageId}`}>
      <div className="react-message__body">
        {reasoning.map((step) => (
          <MessageReasoning durationMs={reasoningDurationMs(step)} key={step.id} streaming={step.status === "running"} text={step.summary ?? ""} />
        ))}
        {role === "assistant" ? <AssistantMarkdown streaming={streaming} text={text} /> : <PlainMessageText text={text} />}
        {references?.length ? <MessageContext references={references.map(canonicalReferenceSummary)} /> : null}
        {streaming ? <span aria-label="Agent is responding" className="react-message__streaming" /> : null}
      </div>
      {allowActions && text.trim() ? (
        <div className="react-message__actions" data-align={role === "user" ? "right" : "left"}>
          <button aria-label="Copy message" type="button" onClick={() => void writeClipboardText(text)}>
            <Copy aria-hidden="true" size={14} />
          </button>
          {onBranch ? (
            <button aria-label="Branch from here" type="button" onClick={onBranch}>
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
    return <AgentSteps flat onOpenTool={onOpenLiveCanvas ? () => onOpenLiveCanvas(step) : onOpenTool} toolCalls={[toolCallSummaryFromStep(step, step.toolCall)]} />;
  }
  if (step.kind === "approval" && step.approval) {
    const approval = step.approval;
    return (
      <AgentSteps
        flat
        onOpenTool={onOpenLiveCanvas ? () => onOpenLiveCanvas(step) : onOpenTool}
        toolCalls={[{
          id: step.id,
          name: step.title,
          status: step.status,
          summary: step.summary,
          approvalId: approval.approvalId,
          approvalStatus: step.status,
        }]}
      />
    );
  }
  if (step.kind === "form" && step.form) {
    const values = canonicalFormEntries(step.form.values);
    const errors = Object.entries(step.form.errors ?? {});
    const resolution = step.form.action === "submit"
      ? "Submitted"
      : step.form.action === "cancel"
        ? "Cancelled"
        : step.status === "completed"
          ? "Resolved"
          : "Waiting for input";
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
            <ul aria-label="Form errors" role="alert">
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
          aria-label={`Open details for ${step.title}`}
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
      <details className="react-canonical-step" data-kind={step.kind}>
        <summary>{step.title}</summary>
        {step.summary ? <p>{step.summary}</p> : null}
        {compaction ? (
          <ul aria-label="Compaction details">
            {compaction.estimatedTokensBefore !== undefined ? <li>Before: {compaction.estimatedTokensBefore.toLocaleString("en-US")} tokens</li> : null}
            {compaction.estimatedTokensAfter !== undefined ? <li>After: {compaction.estimatedTokensAfter.toLocaleString("en-US")} tokens</li> : null}
            <li>Dropped items: {compaction.droppedItemCount.toLocaleString("en-US")}</li>
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
  const cardRef = useRef<HTMLElement | null>(null);
  const error = canonicalErrorInfo(step);
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
      aria-label="任务执行失败"
      className="react-error-recovery"
      role="alert"
      tabIndex={-1}
    >
      <div className="react-error-recovery__heading">
        <AlertTriangle aria-hidden="true" size={18} />
        <div>
          <strong>{turn.status === "interrupted" ? "任务已取消" : "任务已中断"}</strong>
          <p>{friendlyErrorMessage(error.code, error.message)}</p>
        </div>
      </div>
      <dl className="react-error-recovery__summary">
        {failedStep ? <div><dt>中断位置</dt><dd>{failedStep}</dd></div> : null}
        <div><dt>计划进度</dt><dd>已完成 {completedSteps} 个步骤</dd></div>
      </dl>
      {completedPlanSteps(turn).length ? (
        <div className="react-error-recovery__valid-results">
          <strong>仍然有效的结果</strong>
          <ul>{completedPlanSteps(turn).map((item) => <li key={item}>{item}</li>)}</ul>
        </div>
      ) : null}
      <div className="react-error-recovery__actions" aria-label="错误恢复操作">
        <button disabled={recovering} type="button" onClick={() => onRecover("continue")}><Play aria-hidden="true" size={15} />继续执行</button>
        <button disabled={recovering} type="button" onClick={() => onRecover("retry")}><RotateCcw aria-hidden="true" size={15} />重试当前步骤</button>
        <button disabled={recovering} type="button" onClick={() => onRecover("restart")}><RefreshCw aria-hidden="true" size={15} />重新开始</button>
        <button type="button" onClick={onOpenDetails}>查看详情</button>
        <button type="button" onClick={() => void writeClipboardText(formatFailureDetails(step, turn))}><Copy aria-hidden="true" size={15} />复制错误</button>
      </div>
    </section>
  );
}

function CanonicalPlanCard({ step }: { step: ChatStep }) {
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
    <section aria-label="执行计划" aria-live="polite" className="react-canonical-step" data-kind={step.kind} data-status={step.status}>
      <span className="react-canonical-step__icon"><AgentStepIcon status={canonicalStepIconStatus(step)} /></span>
      <div className="react-canonical-plan">
        <button
          aria-controls={contentId}
          aria-expanded={expanded}
          className="react-canonical-plan__heading"
          type="button"
          onClick={() => setExpanded((open) => !open)}
        >
          <strong>执行计划</strong>
          <span>已完成 {completed}/{plan.total}</span>
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
                  <small>{formatPlanStepStatus(planStep.status)}</small>
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
  switch (status) {
    case "completed": return <Check aria-label="已完成" size={14} />;
    case "in_progress": return <Loader2 aria-label="执行中" size={14} />;
    case "failed": return <AlertTriangle aria-label="失败" size={14} />;
    case "cancelled": return <X aria-label="已取消" size={14} />;
    default: return <Circle aria-label="待执行" size={12} />;
  }
}

function PlanStepLabel({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const canExpand = text.length > 72;
  return (
    <span className="react-canonical-plan__step-label">
      <span data-expanded={expanded ? "true" : undefined}>{text}</span>
      {canExpand ? (
        <button aria-expanded={expanded} type="button" onClick={() => setExpanded((open) => !open)}>
          {expanded ? "收起" : "展开"}
        </button>
      ) : null}
    </span>
  );
}

function formatPlanStepStatus(status: PlanStepStatus): string {
  switch (status) {
    case "completed": return "已完成";
    case "in_progress": return "执行中";
    case "failed": return "失败";
    case "cancelled": return "已取消";
    default: return "待执行";
  }
}

function CanonicalArtifacts({ artifacts, onOpen }: { artifacts: ArtifactRef[]; onOpen: (artifact: ArtifactRef) => void }) {
  if (!artifacts.length) {
    return null;
  }
  return (
    <ul aria-label="Artifacts" className="react-canonical-artifacts">
      {artifacts.map((artifact) => (
        <li key={artifact.id}>
          <button aria-label={`Preview ${artifact.title}`} type="button" onClick={() => onOpen(artifact)}>{artifact.title}</button>
        </li>
      ))}
    </ul>
  );
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

function canonicalReferenceSummary(reference: NativeChatReference, index: number): ContextReferenceSummary {
  return {
    id: reference.noteId || reference.evidenceId || `${reference.kind}:${index}`,
    kind: reference.kind,
    title: reference.title,
    detail: reference.detail,
    sourcePath: reference.sourcePath,
    sourceLine: reference.sourceLine,
  };
}

function toolCallSummaryFromStep(step: ChatStep, toolCall: ToolCallState): ToolCallSummary {
  return {
    id: toolCall.id,
    name: displayToolName(toolCall.name),
    status: step.status,
    summary: toolCall.resultPreview || step.summary,
    ...(toolCall.approvalId ? { approvalId: toolCall.approvalId } : {}),
    ...(toolCall.approvalStatus ? { approvalStatus: toolCall.approvalStatus } : {}),
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
        {message.status === "streaming" ? <span className="react-message__streaming" aria-label="Agent is responding" /> : null}
      </div>
      {showCopyAction || showBranchAction ? (
        <div className="react-message__actions" data-align={actionAlignment}>
          {showCopyAction ? (
            <button aria-label="Copy message" type="button" onClick={onCopy}>
              <Copy aria-hidden="true" size={14} />
            </button>
          ) : null}
          {showBranchAction ? (
            <button aria-label="Branch from here" type="button" onClick={onBranch}>
              <GitBranch aria-hidden="true" size={14} />
            </button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function MessageReasoning({ durationMs, streaming, text }: { durationMs?: number; streaming: boolean; text: string }) {
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
    <section className="react-message-reasoning" aria-label="思考过程">
      <button
        aria-controls={contentId}
        aria-expanded={expanded}
        className="react-message-reasoning__trigger"
        type="button"
        onClick={() => setExpanded((open) => !open)}
      >
        <span>{streaming ? "正在思考" : formatThinkingLabel(durationMs)}</span>
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
  return (
    <section className="react-message-context" aria-label="Context">
      <h3>Context</h3>
      <ul>
        {references.map((reference) => (
          <li key={reference.id}>
            <span>{reference.title}</span>
            {reference.detail ? <small>{reference.detail}</small> : null}
            {reference.sourcePath ? (
              <small>
                {reference.sourcePath}{typeof reference.sourceLine === "number" ? `:${reference.sourceLine}` : ""}
              </small>
            ) : null}
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
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  const overallStatus = resolveAgentStepsStatus(toolCalls);
  const countLabel = `${toolCalls.length} 个步骤`;
  const accessibleCountLabel = `${toolCalls.length} ${toolCalls.length === 1 ? "step" : "steps"}`;
  const currentStepIndex = resolveCurrentAgentStepIndex(toolCalls);
  return (
    <section className="react-agent-steps" data-flat={flat ? "true" : undefined} data-status={overallStatus} data-stepper="true">
      {!flat ? (
        <button
          aria-controls={listId}
          aria-expanded={expanded}
          aria-label={`Agent steps, ${accessibleCountLabel}`}
          className="react-agent-steps__header"
          type="button"
          onClick={() => setExpanded((open) => !open)}
        >
          <span className="react-agent-steps__header-icon" data-status={overallStatus}>
            <AgentStepIcon status={overallStatus} />
          </span>
          <span className="react-agent-steps__title">执行详情</span>
          <small>{countLabel}</small>
          {expanded ? <ChevronDown aria-hidden="true" size={15} /> : <ChevronRight aria-hidden="true" size={15} />}
        </button>
      ) : null}

      {flat || expanded ? (
        <ol aria-label="Agent steps" className="react-agent-steps__list" id={listId}>
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
                  aria-label={`Open details for ${toolCall.name}`}
                  className="react-agent-step"
                  type="button"
                  onClick={() => onOpenTool(toolCall)}
                >
                  <span className="react-agent-step__content">
                    <span>{toolCall.name}</span>
                    {toolCall.summary ? <small>{toolCall.summary}</small> : null}
                  </span>
                  <small className="react-agent-step__status">{formatAgentStepStatus(toolCall.status)}</small>
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
    case "waiting_approval":
    case "awaiting_approval":
    case "approval_required":
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

function formatAgentStepStatus(status: string): string {
  switch (normalizeAgentStepStatus(status)) {
    case "active": return "执行中";
    case "success": return "已完成";
    case "waiting": return "等待确认";
    case "error": return status.toLowerCase().includes("cancel") ? "已取消" : "失败";
    default: return "待执行";
  }
}

function reasoningDurationMs(step: ChatStep): number | undefined {
  if (!step.startedAt || !step.completedAt) {
    return undefined;
  }
  const duration = Date.parse(step.completedAt) - Date.parse(step.startedAt);
  return Number.isFinite(duration) && duration >= 0 ? duration : undefined;
}

function formatThinkingLabel(durationMs?: number): string {
  if (durationMs === undefined) {
    return "思考过程";
  }
  if (durationMs < 1000) {
    return "思考了不到 1 秒";
  }
  return `思考了 ${Math.max(1, Math.round(durationMs / 1000))} 秒`;
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

function sessionTitleInitial(title: string): string {
  return title.trim().charAt(0).toUpperCase() || "C";
}

function displaySessionTitle(title: string): string {
  return isDefaultSessionTitle(title) ? "新会话" : title;
}

function deriveSessionTitle(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  return normalized.length > 28 ? `${normalized.slice(0, 28)}…` : normalized || "新会话";
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

function canonicalErrorInfo(step: ChatStep): { code: string; message: string } {
  const error = step.error && typeof step.error === "object" ? step.error as Record<string, unknown> : {};
  return {
    code: typeof error.code === "string" && error.code ? error.code : "runtime_error",
    message: typeof error.message === "string" && error.message ? error.message : step.summary || "任务执行失败",
  };
}

function displayToolName(name: string): string {
  return name === "update_plan" ? "更新执行计划" : name;
}

function friendlyErrorMessage(code: string, message: string): string {
  if (code === "max_iterations" || message.toLowerCase().includes("max iterations")) {
    return "执行达到迭代上限，已保留当前计划和上下文。";
  }
  if (code.includes("cancel") || message.toLowerCase().includes("cancel")) {
    return "执行已取消，已完成的内容仍然保留。";
  }
  return message;
}

function formatFailureDetails(step: ChatStep, turn: ChatTurn): string {
  const error = canonicalErrorInfo(step);
  return [
    `任务：${turn.userMessage.text}`,
    `状态：${turn.status}`,
    `错误代码：${error.code}`,
    `错误信息：${error.message}`,
    failedPlanStep(turn) ? `中断位置：${failedPlanStep(turn)}` : "",
  ].filter(Boolean).join("\n");
}

function ErrorDetails({ step, turn }: { step: ChatStep; turn: ChatTurn }) {
  const error = canonicalErrorInfo(step);
  return (
    <div className="react-error-detail">
      <dl>
        <div><dt>Run ID</dt><dd><code>{turn.id}</code></dd></div>
        <div><dt>状态</dt><dd>{turn.status}</dd></div>
        <div><dt>停止原因</dt><dd><code>{error.code}</code></dd></div>
        {failedPlanStep(turn) ? <div><dt>中断位置</dt><dd>{failedPlanStep(turn)}</dd></div> : null}
        <div><dt>原始任务</dt><dd>{turn.userMessage.text}</dd></div>
      </dl>
      <section>
        <h3>原始错误信息</h3>
        <pre>{error.message}</pre>
      </section>
    </div>
  );
}

function ToolCallDetails({
  resolvingApprovalId = "",
  toolCall,
  onResolveApproval,
}: {
  resolvingApprovalId?: string;
  toolCall: ToolCallSummary;
  onResolveApproval?: (toolCall: ToolCallSummary, action: ApprovalAction) => void;
}) {
  const sections = toolCallDetailSections(toolCall);
  if (!sections.length) {
    return <p>Details unavailable.</p>;
  }
  const showApprovalActions = isPendingApprovalToolCall(toolCall) && Boolean(onResolveApproval);
  const resolving = Boolean(toolCall.approvalId && resolvingApprovalId === toolCall.approvalId);
  return (
    <div className="react-tool-detail">
      {showApprovalActions ? (
        <section className="react-tool-detail__approval-actions" aria-label="Approval actions">
          <h3>Approval actions</h3>
          <div>
            <button disabled={resolving} type="button" onClick={() => onResolveApproval?.(toolCall, "approveOnce")}>Approve once</button>
            <button disabled={resolving} type="button" onClick={() => onResolveApproval?.(toolCall, "approveSession")}>Allow for session</button>
            <button disabled={resolving} type="button" onClick={() => onResolveApproval?.(toolCall, "deny")}>Deny</button>
          </div>
        </section>
      ) : null}
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
  return (
    <div className="react-subagent-detail">
      <dl>
        <div><dt>ID</dt><dd>{delegate.id}</dd></div>
        <div><dt>Status</dt><dd>{delegate.status}</dd></div>
        {delegate.traceRef ? <div><dt>Trace</dt><dd>{delegate.traceRef}</dd></div> : null}
        {delegate.childRunId ? <div><dt>Child run</dt><dd>{delegate.childRunId}</dd></div> : null}
      </dl>
      {delegate.task ? <p>{delegate.task}</p> : null}
      {delegate.latestActivity ? <p>{delegate.latestActivity}</p> : null}
      {loading ? <p aria-live="polite">Loading trace...</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {delegate.trace?.steps.length ? (
        <ol aria-label="Subagent trace">
          {delegate.trace.steps.map((step) => (
            <li data-status={step.status} key={step.id}>
              <strong>{step.title}</strong>
              {step.summary ? <p>{step.summary}</p> : null}
            </li>
          ))}
        </ol>
      ) : null}
      {delegate.finalOutput ? <section><h3>Final output</h3><p>{delegate.finalOutput}</p></section> : null}
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
  return (
    <div className="react-artifact-detail">
      <dl>
        <div><dt>ID</dt><dd>{artifact.id}</dd></div>
        {detail?.mimeType || artifact.mimeType ? <div><dt>Type</dt><dd>{detail?.mimeType || artifact.mimeType}</dd></div> : null}
      </dl>
      {loading ? <p aria-live="polite">Loading artifact...</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {detail?.imageDataUrl ? <img alt={detail.title} src={detail.imageDataUrl} /> : null}
      {detail?.textContent ? <pre>{detail.textContent}</pre> : null}
      {!loading && !error && !detail?.imageDataUrl && !detail?.textContent ? <p>No preview content is available.</p> : null}
    </div>
  );
}

function isPendingApprovalToolCall(toolCall: ToolCallSummary): boolean {
  if (!toolCall.approvalId) {
    return false;
  }
  const status = normalizeAgentStepStatus(toolCall.approvalStatus || toolCall.status);
  return status === "waiting";
}

function toolCallDetailSections(toolCall: ToolCallSummary): Array<{ label: string; value: string }> {
  return [
    { label: "Status", value: toolCall.status },
    { label: "Summary", value: toolCall.summary ?? "" },
    { label: "Arguments", value: toolCall.argsText ?? "" },
    { label: "Response", value: toolCall.responseText ?? "" },
    { label: "Approval", value: formatDetailLines([
      ["ID", toolCall.approvalId],
      ["Status", toolCall.approvalStatus],
    ]) },
    { label: "Delegate", value: formatDetailLines([
      ["Title", toolCall.delegateTitle],
      ["Type", toolCall.delegateType],
      ["Task", toolCall.delegateTask],
      ["ID", toolCall.delegateId],
    ]) },
    { label: "Trace", value: formatDetailLines([
      ["Trace", toolCall.traceRef],
      ["Child run", toolCall.childRunId],
      ["Parent run", toolCall.parentRunId],
      ["Parent turn", toolCall.parentTurnId],
      ["Session", toolCall.sessionKey],
    ]) },
    { label: "Final output", value: toolCall.finalOutput ?? "" },
  ].filter((section) => section.value.trim());
}

function formatDetailLines(rows: Array<[string, string | undefined]>): string {
  return rows
    .filter(([, value]) => Boolean(value?.trim()))
    .map(([label, value]) => `${label}: ${value}`)
    .join("\n");
}
