import { useEffect, useMemo, useReducer, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import {
  Activity,
  AlertTriangle,
  Archive,
  Bell,
  Bot,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Circle,
  Copy,
  Command,
  FileCode2,
  FileText,
  Folder,
  FolderOpen,
  Globe2,
  Info,
  ListChecks,
  LayoutGrid,
  Maximize2,
  MemoryStick,
  MessageCircleQuestion,
  Minus,
  MonitorDot,
  Pause,
  Paperclip,
  PencilLine,
  Play,
  Search,
  ShieldCheck,
  TerminalSquare,
  RotateCcw,
  X,
} from "lucide-react";
import type { AgentUiForm } from "../../app-core/agent-ui/agentUiEvents";
import type { ArtifactRef, ChatStep, ChatStepStatus } from "../../app-core/chat/chatRunModel";
import type { TinyOsBrowserAction, TinyOsCommandLifecycle } from "../../app-core/chat/tinyOsCommandGateway";
import { validateTinyOsBrowserInteractionTarget } from "../../app-core/chat/tinyOsBrowserSession";
import { createTinyOsShellCommandRegistry, defineTinyOsShellCommand, type TinyOsShellCommand, type TinyOsShellCommandId, type TinyOsShellCommandInput, type TinyOsShellCommandRegistry } from "../../app-core/chat/tinyOsShellCommandRegistry";
import { readTinyOsReferenceTransfer, tinyOsReferenceAcceptedBy, TINYOS_REFERENCE_MIME, writeTinyOsReferenceTransfer } from "../../app-core/chat/tinyOsReferenceTransfer";
import type { TinyOsKernelSnapshot, TinyOsResource, TinyOsSimulationCursor } from "../../app-core/chat/tinyOsKernelModel";
import { resourceValue, tinyOsWorkspaceResourceId } from "../../app-core/chat/tinyOsFilesModel";
import type {
  TinyOsAppId,
  TinyOsDesktopSnapshot,
  TinyOsTimelineEntry,
  TinyOsWindow,
} from "../../app-core/chat/tinyOsDesktopModel";
import {
  createTinyOsUiState,
  loadTinyOsLayout,
  reduceTinyOsUiState,
  saveTinyOsLayout,
  type TinyOsAgentRequestIntent,
  type TinyOsAgentRequestReference,
  type TinyOsLayoutMode,
  type TinyOsContextReference,
  type TinyOsWindowRect,
} from "../../app-core/chat/tinyOsUiState";
import type { ApprovalAction } from "../services";
import { AgentUiFormCard } from "./AgentUiFormCard";
import { TinyOsFilesExplorer } from "./TinyOsFilesExplorer";
import { TinyOsSystemMonitor, type TinyOsSystemMonitorControls } from "./TinyOsSystemMonitor";
import type { TinyOsFilesController } from "./useTinyOsFilesController";

const APP_ICONS = {
  artifacts: Archive,
  browser: Globe2,
  files: Folder,
  inspector: Info,
  memory: MemoryStick,
  plan: ListChecks,
  subagents: Bot,
  system_monitor: Activity,
  terminal: TerminalSquare,
} satisfies Record<TinyOsAppId, typeof Folder>;

const APP_LABELS: Record<TinyOsAppId, string> = {
  artifacts: "Artifacts",
  browser: "Browser",
  files: "Files",
  inspector: "Inspector",
  memory: "Memory",
  plan: "Plan",
  subagents: "Subagents",
  system_monitor: "System Monitor",
  terminal: "Terminal",
};

const APP_ORDER: TinyOsAppId[] = ["files", "terminal", "system_monitor", "browser", "plan", "memory", "subagents", "artifacts", "inspector"];
const tinyOsSessionUiState = new Map<string, ReturnType<typeof createTinyOsUiState>>();
type TinyOsShellOverlay = "notifications" | "overview" | "palette" | "switcher";
type TinyOsContextMenuState = { commandIds: TinyOsShellCommandId[]; label: string; x: number; y: number };
type TinyOsFileSaveInput = { baseRevision?: string; content: string; createOnly: boolean; path: string };
type TinyOsFileMoveInput = { baseRevision: string; path: string; targetPath: string };
type TinyOsFileDeleteInput = { baseRevision: string; path: string };
type TinyOsTerminalExecuteInput = { command: string; cwd?: string };
type TinyOsPinnedEvidence = {
  cursor: TinyOsSimulationCursor;
  entry: TinyOsTimelineEntry;
  id: string;
  resources: TinyOsResource[];
};

export function TinyOsShell({
  agentUiForms,
  canCancelTerminal = false,
  canDirectEdit = false,
  canExecuteTerminal = false,
  canInteractBrowser = false,
  canRequestChange,
  canRetryRun,
  canSaveFile = false,
  filesController,
  history = false,
  commandLifecycle,
  onCancelForm,
  onAttachContext,
  onOpenArtifact,
  onAgentRequest,
  onCancelTerminal = async () => undefined,
  onBrowserInteract = async () => undefined,
  onDeleteFile = async () => undefined,
  onExecuteTerminal = async () => undefined,
  onMoveFile = async () => undefined,
  onResolveApproval,
  onRetryOperation,
  onSelectEntry,
  onSubmitForm,
  onSaveFile = async () => undefined,
  resolvingApprovalId,
  requestChangeUnavailableReason,
  directEditUnavailableReason,
  retryRunId,
  retryUnavailableReason,
  runtimeCommandRegistry,
  saveFileUnavailableReason,
  terminalCancelUnavailableReason,
  terminalExecuteUnavailableReason,
  browserInteractUnavailableReason,
  runningTerminalRunId,
  sessionKey,
  submittingFormId,
  snapshot,
  layoutMode,
  workspaceKey,
}: {
  agentUiForms: AgentUiForm[];
  canCancelTerminal?: boolean;
  canDirectEdit?: boolean;
  canExecuteTerminal?: boolean;
  canInteractBrowser?: boolean;
  canRequestChange: boolean;
  canRetryRun: boolean;
  canSaveFile?: boolean;
  filesController?: TinyOsFilesController;
  history?: boolean;
  commandLifecycle: TinyOsCommandLifecycle;
  onCancelForm: (form: AgentUiForm) => void;
  onAttachContext: (reference: TinyOsContextReference) => void;
  onOpenArtifact: (artifact: ArtifactRef) => void;
  onAgentRequest: (reference: TinyOsAgentRequestReference, intent: TinyOsAgentRequestIntent) => void;
  onCancelTerminal?: () => Promise<void>;
  onBrowserInteract?: (input: { action: TinyOsBrowserAction; browserSessionId: string; captureId: string; tabId: string }) => Promise<void>;
  onDeleteFile?: (input: TinyOsFileDeleteInput) => Promise<void>;
  onExecuteTerminal?: (input: TinyOsTerminalExecuteInput) => Promise<void>;
  onMoveFile?: (input: TinyOsFileMoveInput) => Promise<void>;
  onResolveApproval: (approvalId: string, action: ApprovalAction) => void;
  onRetryOperation: (entry: TinyOsTimelineEntry) => void;
  onSelectEntry: (entry: TinyOsTimelineEntry) => void;
  onSubmitForm: (form: AgentUiForm, values: Record<string, unknown>) => void;
  onSaveFile?: (input: TinyOsFileSaveInput) => Promise<void>;
  resolvingApprovalId: string;
  requestChangeUnavailableReason?: string;
  directEditUnavailableReason?: string;
  retryRunId?: string;
  retryUnavailableReason?: string;
  runtimeCommandRegistry: TinyOsShellCommandRegistry;
  saveFileUnavailableReason?: string;
  terminalCancelUnavailableReason?: string;
  terminalExecuteUnavailableReason?: string;
  browserInteractUnavailableReason?: string;
  runningTerminalRunId?: string;
  sessionKey?: string;
  submittingFormId?: string;
  snapshot: TinyOsDesktopSnapshot;
  layoutMode: TinyOsLayoutMode;
  workspaceKey: string;
}) {
  const desktopRef = useRef<HTMLElement>(null);
  const overlayReturnFocusRef = useRef<HTMLElement | null>(null);
  const [overlay, setOverlay] = useState<TinyOsShellOverlay | null>(null);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [readNotificationIds, setReadNotificationIds] = useState<Set<string>>(() => new Set());
  const [switcherAppId, setSwitcherAppId] = useState<TinyOsAppId | undefined>(undefined);
  const [transferMessage, setTransferMessage] = useState<{ kind: "error" | "success"; text: string }>();
  const [contextMenu, setContextMenu] = useState<TinyOsContextMenuState>();
  const [pinnedEvidence, setPinnedEvidence] = useState<TinyOsPinnedEvidence[]>([]);
  const appWindows = useMemo(() => {
    const windows = [...snapshot.windows];
    if (filesController && !windows.some(({ appId }) => appId === "files")) {
      windows.unshift({ appId: "files", entries: [], id: "tinyos-window-files", sourceItemIds: [], title: "Files" });
    }
    if (snapshot.kernel && !windows.some(({ appId }) => appId === "system_monitor")) {
      windows.push({
        appId: "system_monitor",
        entries: [],
        id: "tinyos-window-system-monitor",
        sourceItemIds: snapshot.kernel.processes.flatMap((process) => process.correlation.itemId ? [process.correlation.itemId] : []),
        title: "System Monitor",
      });
    }
    if (sessionKey && !windows.some(({ appId }) => appId === "terminal")) {
      windows.push({ appId: "terminal", entries: [], id: "tinyos-window-terminal", sourceItemIds: [], title: "Terminal" });
    }
    if (snapshot.kernel?.browserSessions.length && !windows.some(({ appId }) => appId === "browser")) {
      windows.push({ appId: "browser", entries: [], id: "tinyos-window-browser", sourceItemIds: [], title: "Browser" });
    }
    return windows;
  }, [filesController, sessionKey, snapshot.kernel, snapshot.windows]);
  const initialAppIds = appWindows.map((window) => window.appId);
  const seenFileOperations = useRef(new Set<string>());
  const revealedCursorItemId = useRef<string | undefined>(undefined);
  const previousHistoryMode = useRef(history);
  const sessionUiKey = sessionKey ? `${workspaceKey}:${sessionKey}` : undefined;
  const [uiState, dispatchUi] = useReducer(reduceTinyOsUiState, undefined, () => {
    const cached = sessionUiKey ? tinyOsSessionUiState.get(sessionUiKey) : undefined;
    if (cached) {
      return reduceTinyOsUiState(cached, {
        appIds: initialAppIds,
        bounds: cached.bounds,
        layoutMode,
        preferredActiveAppId: cached.focusedAppId,
        type: "sync",
      });
    }
    let restoredLayout;
    try {
      restoredLayout = loadTinyOsLayout(typeof window === "undefined" ? undefined : window.localStorage, workspaceKey, layoutMode);
    } catch (error) {
      console.error("TinyOS could not restore its saved layout; the deterministic layout will be used.", error);
    }
    return createTinyOsUiState({
      appIds: initialAppIds,
      bounds: { height: 560, width: layoutMode === "compact" ? 420 : 640 },
      layoutMode,
      preferredActiveAppId: snapshot.activeAppId,
      restoredLayout,
    });
  });

  useEffect(() => {
    const returningToLive = previousHistoryMode.current && !history;
    previousHistoryMode.current = history;
    dispatchUi({
      appIds: appWindows.map((window) => window.appId),
      bounds: uiState.bounds,
      layoutMode,
      preferredActiveAppId: history || returningToLive ? snapshot.activeAppId : uiState.focusedAppId,
      type: "sync",
    });
  }, [appWindows.length, history, layoutMode, snapshot.activeAppId, snapshot.cursorItemId, snapshot.cursorTurnId]);

  useEffect(() => {
    const desktop = desktopRef.current;
    if (!desktop || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const width = Math.round(entry.contentRect.width);
      const height = Math.round(entry.contentRect.height);
      if (width < 1 || height < 1) return;
      dispatchUi({
        appIds: appWindows.map((window) => window.appId),
        bounds: { height, width },
        layoutMode,
        preferredActiveAppId: uiState.focusedAppId,
        type: "sync",
      });
    });
    observer.observe(desktop);
    return () => observer.disconnect();
  }, [appWindows.length, layoutMode, uiState.focusedAppId]);

  useEffect(() => {
    if (!filesController) return;
    snapshot.windows.find(({ appId }) => appId === "files")?.entries.forEach((entry) => {
      if (seenFileOperations.current.has(entry.step.id)) return;
      seenFileOperations.current.add(entry.step.id);
      if (isFileMutation(entry.step)) filesController.markStale(filePath(entry.step));
    });
  }, [filesController, snapshot.cursorItemId, snapshot.cursorTurnId, snapshot.windows]);

  useEffect(() => {
    if (!history || !filesController?.queryAvailable || snapshot.activeAppId !== "files") return;
    if (!snapshot.cursorItemId || revealedCursorItemId.current === snapshot.cursorItemId) return;
    const entry = snapshot.windows.find(({ appId }) => appId === "files")?.entries.find(({ step }) => step.id === snapshot.cursorItemId);
    if (entry) {
      revealedCursorItemId.current = snapshot.cursorItemId;
      void filesController.revealFile(filePath(entry.step));
    }
  }, [filesController, history, snapshot.activeAppId, snapshot.cursorItemId, snapshot.windows]);

  useEffect(() => {
    saveTinyOsLayout(typeof window === "undefined" ? undefined : window.localStorage, workspaceKey, uiState);
  }, [uiState.layoutMode, uiState.windowLayout, workspaceKey]);

  useEffect(() => {
    if (sessionUiKey) tinyOsSessionUiState.set(sessionUiKey, uiState);
  }, [sessionUiKey, uiState]);

  useEffect(() => {
    if (snapshot.dialog && overlay) closeShellOverlay();
  }, [overlay, snapshot.dialog?.id]);

  const windows = useMemo(() => {
    const visible = appWindows.filter((window) => (
      !uiState.minimizedAppIds.includes(window.appId)
      && (uiState.layoutMode !== "compact" || window.appId === uiState.focusedAppId)
    ));
    return visible.sort((left, right) => uiState.zOrder.indexOf(left.appId) - uiState.zOrder.indexOf(right.appId));
  }, [appWindows, uiState.focusedAppId, uiState.layoutMode, uiState.minimizedAppIds, uiState.zOrder]);
  const availableApps = new Set(appWindows.map((window) => window.appId));
  const allEntries = snapshot.windows.flatMap((window) => window.entries);
  const distinctEntries = [...new Map(allEntries.map((entry) => [entry.step.id, entry])).values()];
  const workspaceDocuments = filesController
    ? Object.entries(filesController.state.documents).flatMap(([path, resource]) => {
        const document = resourceValue(resource);
        return document ? [{ document, path }] : [];
      })
    : [];
  const shellOverlayAvailability = snapshot.dialog
    ? { available: false as const, reason: "Finish the active TinyOS system request before opening another shell overlay." }
    : { available: true as const };
  const retryAvailability = history
    ? { available: false as const, reason: "History snapshots are read-only.", reasonCode: "history_read_only" }
    : canRetryRun
      ? { available: true as const }
      : { available: false as const, reason: retryUnavailableReason || "The backend reports that retry is unavailable." };
  const terminalExecuteAvailability = history
    ? { available: false as const, reason: "Direct host actions are disabled while viewing History.", reasonCode: "history_read_only" }
    : canExecuteTerminal
      ? { available: true as const }
      : { available: false as const, reason: terminalExecuteUnavailableReason || "Terminal execution is unavailable." };
  const terminalCancelAvailability = history
    ? { available: false as const, reason: "Direct host actions are disabled while viewing History.", reasonCode: "history_read_only" }
    : canCancelTerminal && runningTerminalRunId
      ? { available: true as const }
      : { available: false as const, reason: terminalCancelUnavailableReason || "There is no running Terminal execution to cancel." };
  const browserSession = snapshot.kernel?.browserSessions[0];
  const browserCommandAvailability = (kind: "click" | "navigate" | "type") => history
    ? { available: false as const, reason: "Direct host actions are disabled while viewing History.", reasonCode: "history_read_only" }
    : !canInteractBrowser
      ? { available: false as const, reason: browserInteractUnavailableReason || "Browser interaction is unavailable." }
      : !browserSession
        ? { available: false as const, reason: "No compatible native browser session snapshot is available." }
        : browserSession.interaction[kind]
          ? { available: true as const }
          : { available: false as const, reason: `The native browser session does not allow ${kind}.` };
  const shellCommandRegistry = createTinyOsShellCommandRegistry([
    ...runtimeCommandRegistry.commands,
    defineTinyOsShellCommand({
      availability: terminalExecuteAvailability,
      category: "process",
      dispatch: (_target, input) => {
        if (!input || typeof input === "string") throw new Error("Terminal execution requires structured input.");
        return onExecuteTerminal({
          command: input.command,
          ...(input.cwd?.trim() ? { cwd: input.cwd.trim() } : {}),
        });
      },
      id: "terminal.execute",
      input: {
        fields: [
          { label: "command", name: "command", required: true },
          { label: "working directory", name: "cwd", required: false },
        ],
        kind: "fields",
      },
      keywords: ["terminal", "run", "command", "shell"],
      label: "Run Terminal command",
      scope: "runtime",
      target: { kind: "shell" },
    }),
    defineTinyOsShellCommand({
      availability: terminalCancelAvailability,
      category: "process",
      dispatch: () => onCancelTerminal(),
      id: "terminal.cancel",
      input: { kind: "none" },
      keywords: ["terminal", "cancel", "stop", "interrupt"],
      label: "Cancel Terminal execution",
      scope: "runtime",
      target: { kind: "run", runId: runningTerminalRunId ?? "no-active-terminal" },
    }),
    ...(["navigate", "click", "type"] as const).map((kind) => defineTinyOsShellCommand({
      availability: browserCommandAvailability(kind),
      category: "resource",
      dispatch: (_target, input) => {
        const commandInput = browserInteractionCommandInput(input);
        const session = snapshot.kernel?.browserSessions.find(({ browserSessionId }) => (
          browserSessionId === commandInput.browserSessionId
        ));
        const validation = validateTinyOsBrowserInteractionTarget(session, commandInput);
        if (validation.status === "rejected") throw new Error(validation.reason);
        return onBrowserInteract({
          action: browserActionFromCommandInput(kind, commandInput),
          browserSessionId: commandInput.browserSessionId,
          captureId: commandInput.captureId,
          tabId: commandInput.tabId,
        });
      },
      id: `browser.${kind}` as const,
      input: {
        fields: [
          { label: "browser session id", name: "browserSessionId", required: true },
          { label: "browser tab id", name: "tabId", required: true },
          { label: "browser capture id", name: "captureId", required: true },
          ...(kind === "navigate" ? [{ label: "URL", name: "url", required: true }] : []),
          ...(kind === "type" ? [{ label: "text", name: "text", required: true }] : []),
          ...(kind === "click" ? [
            { label: "x coordinate", name: "x", required: true },
            { label: "y coordinate", name: "y", required: true },
          ] : []),
        ],
        kind: "fields",
      },
      keywords: ["browser", kind, "capture", "session"],
      label: `${kind[0].toUpperCase()}${kind.slice(1)} in Browser`,
      scope: "runtime",
      target: { kind: "resource", resourceId: browserSession ? `browser-session:${browserSession.browserSessionId}` : "browser-session:unavailable" },
    })),
    defineTinyOsShellCommand({
      availability: { available: true },
      category: "system",
      dispatch: () => dispatchUi({ type: "reset" }),
      id: "shell.reset_layout",
      input: { kind: "none" },
      keywords: ["reset", "layout", "windows"],
      label: "Reset TinyOS layout",
      scope: "local_presentation",
      target: { kind: "shell" },
    }),
    defineTinyOsShellCommand({
      availability: appWindows.length && shellOverlayAvailability.available
        ? { available: true }
        : !shellOverlayAvailability.available
          ? shellOverlayAvailability
        : { available: false, reason: "No TinyOS applications are available." },
      category: "system",
      dispatch: () => openShellOverlay("overview"),
      id: "shell.overview",
      input: { kind: "none" },
      keywords: ["overview", "windows", "applications"],
      label: "Open window Overview",
      scope: "local_presentation",
      target: { kind: "shell" },
    }),
    defineTinyOsShellCommand({
      availability: shellOverlayAvailability,
      category: "system",
      dispatch: () => {
        setPaletteQuery("");
        openShellOverlay("palette");
      },
      id: "shell.palette",
      input: { kind: "text", label: "Search commands", required: false },
      keywords: ["command", "palette", "search"],
      label: "Open command palette",
      scope: "local_presentation",
      target: { kind: "shell" },
    }),
    defineTinyOsShellCommand({
      availability: snapshot.notifications.length && shellOverlayAvailability.available
        ? { available: true }
        : !shellOverlayAvailability.available
          ? shellOverlayAvailability
          : { available: false, reason: "No derived notifications are available." },
      category: "system",
      dispatch: () => openShellOverlay("notifications"),
      id: "shell.notification_center",
      input: { kind: "none" },
      keywords: ["notifications", "history", "alerts"],
      label: "Open notification center",
      scope: "local_presentation",
      target: { kind: "shell" },
    }),
    ...appWindows.flatMap((window) => [
      defineTinyOsShellCommand({
        availability: { available: true },
        category: "application",
        dispatch: () => focusApp(window.appId),
        id: `app.open:${window.appId}` as const,
        input: { kind: "none" },
        keywords: [window.title, "open", "application"],
        label: `Open ${window.title}`,
        scope: "local_presentation",
        target: { appId: window.appId, kind: "application" },
      }),
      defineTinyOsShellCommand({
        availability: { available: true },
        category: "window",
        dispatch: () => focusApp(window.appId),
        id: `window.focus:${window.appId}` as const,
        input: { kind: "none" },
        keywords: [window.title, "focus", "restore"],
        label: `Focus ${window.title}`,
        scope: "local_presentation",
        target: { appId: window.appId, kind: "window" },
      }),
      defineTinyOsShellCommand({
        availability: { available: true },
        category: "window",
        dispatch: () => dispatchUi({ appId: window.appId, type: "maximize_toggle" }),
        id: `window.maximize:${window.appId}` as const,
        input: { kind: "none" },
        keywords: [window.title, "maximize", "restore"],
        label: `Maximize ${window.title}`,
        scope: "local_presentation",
        target: { appId: window.appId, kind: "window" },
      }),
      defineTinyOsShellCommand({
        availability: { available: true },
        category: "window",
        dispatch: () => minimizeApp(window.appId),
        id: `window.minimize:${window.appId}` as const,
        input: { kind: "none" },
        keywords: [window.title, "minimize"],
        label: `Minimize ${window.title}`,
        scope: "local_presentation",
        target: { appId: window.appId, kind: "window" },
      }),
    ]),
    ...distinctEntries.flatMap((entry) => [
      defineTinyOsShellCommand({
        availability: { available: true },
        category: "operation",
        dispatch: () => pinEvidence(entry),
        id: `evidence.inspect:${entry.step.id}` as const,
        input: { kind: "none" },
        keywords: [entry.step.title, "inspect", "evidence"],
        label: `Inspect ${entry.step.title}`,
        scope: "local_presentation",
        target: { itemId: entry.step.id, kind: "evidence", turnId: entry.turnId },
      }),
      defineTinyOsShellCommand({
        availability: { available: true },
        category: "history",
        dispatch: () => {
          const sourceWindow = appWindows.find(({ sourceItemIds }) => sourceItemIds.includes(entry.step.id));
          if (sourceWindow) focusApp(sourceWindow.appId);
          onSelectEntry(entry);
        },
        id: `history.select:${entry.step.id}` as const,
        input: { kind: "none" },
        keywords: [entry.step.title, "history", "show"],
        label: `Show ${entry.step.title}`,
        scope: "local_presentation",
        target: { itemId: entry.step.id, kind: "history", turnId: entry.turnId },
      }),
    ]),
    ...distinctEntries.map((entry) => defineTinyOsShellCommand({
      availability: retryAvailability,
      category: "operation",
      dispatch: () => onRetryOperation(entry),
      id: `operation.retry:${entry.step.id}` as const,
      input: { kind: "none" },
      keywords: [entry.step.title, "retry", "operation"],
      label: `Retry ${entry.step.title}`,
      scope: "runtime",
      target: { itemId: entry.step.id, kind: "operation", runId: entry.turnId, turnId: entry.turnId },
    })),
    ...snapshot.notifications.flatMap((notification) => [
      defineTinyOsShellCommand({
        availability: { available: true },
        category: "operation",
        dispatch: () => {
          const sourceWindow = snapshot.windows.find((candidate) => candidate.sourceItemIds.includes(notification.entry.step.id));
          if (sourceWindow) focusApp(sourceWindow.appId);
          pinEvidence(notification.entry);
        },
        id: `notification.open:${notification.id}` as const,
        input: { kind: "none" },
        keywords: [notification.title, notification.message, notification.kind, "notification"],
        label: `Open notification: ${notification.title}`,
        scope: "local_presentation",
        target: { itemId: notification.entry.step.id, kind: "evidence", turnId: notification.entry.turnId },
      }),
      defineTinyOsShellCommand({
        availability: readNotificationIds.has(notification.id)
          ? { available: false, reason: "This notification is already marked read." }
          : { available: true },
        category: "operation",
        dispatch: () => setReadNotificationIds((current) => new Set(current).add(notification.id)),
        id: `notification.read:${notification.id}` as const,
        input: { kind: "none" },
        keywords: [notification.title, "read", "notification"],
        label: `Mark ${notification.title} read`,
        scope: "local_presentation",
        target: { itemId: notification.entry.step.id, kind: "evidence", turnId: notification.entry.turnId },
      }),
    ]),
    ...(snapshot.kernel?.resources.map((resource) => {
      const appId = tinyOsAppForResourceKind(resource.kind);
      const revealable = Boolean(appId && availableApps.has(appId));
      return defineTinyOsShellCommand({
        availability: revealable
          ? { available: true }
          : { available: false, reason: "No TinyOS application can reveal this resource." },
        category: "resource",
        dispatch: () => {
          if (appId) focusApp(appId);
        },
        id: `resource.reveal:${resource.id}` as const,
        input: { kind: "none" },
        keywords: [resource.title, resource.path || "", resource.kind, resource.provenance.kind, "resource"],
        label: `Reveal ${resource.title}`,
        scope: "local_presentation",
        target: { kind: "resource", resourceId: resource.id },
      });
    }) ?? []),
    ...workspaceDocuments.flatMap(({ document, path }) => {
      const resourceId = tinyOsWorkspaceResourceId(filesController?.state.workspaceKey ?? workspaceKey, path);
      return [
        defineTinyOsShellCommand({
          availability: { available: true },
          category: "resource",
          dispatch: () => {
            focusApp("files");
            void filesController?.revealFile(path);
          },
          id: `resource.reveal:${resourceId}` as const,
          input: { kind: "none" },
          keywords: [path, fileName(path), document.provenance.kind, "workspace", "file"],
          label: `Open ${path} in Files`,
          scope: "local_presentation",
          target: { kind: "resource", resourceId },
        }),
        defineTinyOsShellCommand({
          availability: { available: true },
          category: "resource",
          dispatch: () => onAttachContext({
            kind: "file",
            path,
            provenance: { kind: "workspace_read", workspaceKey: filesController?.state.workspaceKey ?? workspaceKey },
            revision: document.revision,
          }),
          id: `reference.attach:${resourceId}` as const,
          input: { acceptedKinds: ["file"], kind: "reference" },
          keywords: [path, "attach", "chat", "reference"],
          label: `Attach ${path} to Chat`,
          scope: "local_presentation",
          target: { kind: "resource", resourceId },
        }),
      ];
    }),
    ...(snapshot.kernel?.processes.flatMap((process) => {
      const revealable = Boolean(process.applicationId && availableApps.has(process.applicationId as TinyOsAppId));
      const inspectable = Boolean(process.correlation.itemId && distinctEntries.some((entry) => entry.step.id === process.correlation.itemId));
      return [
        defineTinyOsShellCommand({
          availability: revealable ? { available: true } : { available: false, reason: "No related TinyOS application is available." },
          category: "process",
          dispatch: () => {
            if (process.applicationId) focusApp(process.applicationId as TinyOsAppId);
          },
          id: `process.reveal:${process.id}` as const,
          input: { kind: "none" },
          keywords: [process.title, "reveal", "application"],
          label: `Reveal ${process.title}`,
          scope: "local_presentation",
          target: { kind: "process", processId: process.id, runId: process.correlation.runId },
        }),
        defineTinyOsShellCommand({
          availability: inspectable ? { available: true } : { available: false, reason: "No correlated canonical item is available to inspect." },
          category: "process",
          dispatch: () => {
            const entry = distinctEntries.find((candidate) => candidate.step.id === process.correlation.itemId);
            if (entry) pinEvidence(entry);
          },
          id: `process.inspect:${process.id}` as const,
          input: { kind: "none" },
          keywords: [process.title, "inspect", "evidence"],
          label: `Inspect ${process.title}`,
          scope: "local_presentation",
          target: { kind: "process", processId: process.id, runId: process.correlation.runId },
        }),
      ];
    }) ?? []),
  ], { simulationMode: history ? "history" : "live" });
  const pauseCommand = requiredShellCommand(shellCommandRegistry, "agent.pause");
  const resumeCommand = requiredShellCommand(shellCommandRegistry, "agent.resume");
  const cancelCommand = requiredShellCommand(shellCommandRegistry, "agent.cancel");
  const activeRunId = pauseCommand.target.kind === "run" ? pauseCommand.target.runId : undefined;
  const systemMonitorControls: TinyOsSystemMonitorControls = {
    activeRunId,
    canCancelRun: cancelCommand.availability.available,
    canPauseRun: pauseCommand.availability.available,
    canResumeRun: resumeCommand.availability.available,
    canRetryRun,
    cancelUnavailableReason: cancelCommand.availability.available ? undefined : cancelCommand.availability.reason,
    commandLifecycle,
    history,
    inspectableItemIds: allEntries.map((entry) => entry.step.id),
    onCancelRun: () => void shellCommandRegistry.execute(cancelCommand.id),
    onInspect: (process) => {
      void shellCommandRegistry.execute(`process.inspect:${process.id}`);
    },
    onOpenProcessMenu: (process, clientX, clientY) => openContextMenuAt(clientX, clientY, `${process.title} process menu`, [
      `process.reveal:${process.id}`,
      `process.inspect:${process.id}`,
      ...(process.correlation.itemId ? [`operation.retry:${process.correlation.itemId}` as const] : []),
    ]),
    onOpenResourceMenu: (resource, clientX, clientY) => openContextMenuAt(clientX, clientY, `${resource.title} resource menu`, [
      `resource.reveal:${resource.id}`,
    ]),
    onPauseRun: () => void shellCommandRegistry.execute(pauseCommand.id),
    onResumeRun: () => void shellCommandRegistry.execute(resumeCommand.id),
    onRetry: (process) => {
      if (process.correlation.itemId) void shellCommandRegistry.execute(`operation.retry:${process.correlation.itemId}`);
    },
    onReveal: (process) => {
      void shellCommandRegistry.execute(`process.reveal:${process.id}`);
    },
    pauseUnavailableReason: pauseCommand.availability.available ? undefined : pauseCommand.availability.reason,
    resumeUnavailableReason: resumeCommand.availability.available ? undefined : resumeCommand.availability.reason,
    retryRunId,
    retryUnavailableReason,
    revealableApplicationIds: [...availableApps],
  };
  function pinEvidence(entry: TinyOsTimelineEntry) {
    const cursor = snapshot.kernel?.cursor ?? {
      boundary: {
        itemId: entry.step.id,
        runId: entry.turnId,
        sequence: entry.step.sequence,
        turnId: entry.turnId,
      },
      eventCount: allEntries.length,
      eventIndex: Math.max(0, entry.step.sequence),
      mode: history ? "history" as const : "live" as const,
    };
    const pin: TinyOsPinnedEvidence = {
      cursor,
      entry,
      id: `${cursor.eventIndex}:${entry.turnId}:${entry.step.id}`,
      resources: snapshot.kernel?.resources.filter(({ provenance }) => provenance.sourceId === entry.step.id) ?? [],
    };
    setPinnedEvidence((current) => [...current.filter(({ id }) => id !== pin.id), pin].slice(-2));
  }

  function openShellOverlay(nextOverlay: TinyOsShellOverlay) {
    if (!overlay && typeof document !== "undefined" && document.activeElement instanceof HTMLElement) {
      overlayReturnFocusRef.current = document.activeElement;
    }
    setOverlay(nextOverlay);
  }

  function closeShellOverlay() {
    setOverlay(null);
    setSwitcherAppId(undefined);
    const returnTarget = overlayReturnFocusRef.current;
    overlayReturnFocusRef.current = null;
    if (returnTarget?.isConnected) window.requestAnimationFrame(() => returnTarget.focus());
  }

  function openContextMenu(event: MouseEvent<HTMLElement>, label: string, commandIds: TinyOsShellCommandId[]) {
    event.preventDefault();
    event.stopPropagation();
    openContextMenuAt(event.clientX, event.clientY, label, commandIds);
  }

  function openContextMenuAt(clientX: number, clientY: number, label: string, commandIds: TinyOsShellCommandId[]) {
    const bounds = desktopRef.current?.getBoundingClientRect();
    const relativeX = clientX - (bounds?.left ?? 0);
    const relativeY = clientY - (bounds?.top ?? 0);
    setContextMenu({
      commandIds,
      label,
      x: Math.min(Math.max(8, relativeX), Math.max(8, (bounds?.width ?? 440) - 220)),
      y: Math.min(Math.max(8, relativeY), Math.max(8, (bounds?.height ?? 480) - commandIds.length * 38 - 20)),
    });
  }

  function focusApp(appId: TinyOsAppId) {
    if (!availableApps.has(appId)) return;
    dispatchUi({ appId, type: "focus" });
  }

  function minimizeApp(appId: TinyOsAppId) {
    dispatchUi({ appId, type: "minimize" });
  }

  function handleShellKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === "k") {
      event.preventDefault();
      void shellCommandRegistry.execute("shell.palette");
      return;
    }
    if (event.altKey && event.key === "Tab") {
      const orderedApps = [...uiState.zOrder].reverse().filter((appId) => availableApps.has(appId));
      if (orderedApps.length < 2) return;
      const current = switcherAppId ?? uiState.focusedAppId ?? orderedApps[0];
      const currentIndex = Math.max(0, orderedApps.indexOf(current));
      const direction = event.shiftKey ? -1 : 1;
      const nextAppId = orderedApps[(currentIndex + direction + orderedApps.length) % orderedApps.length];
      event.preventDefault();
      if (overlay !== "switcher") openShellOverlay("switcher");
      setSwitcherAppId(nextAppId);
      void shellCommandRegistry.execute(`window.focus:${nextAppId}`);
      return;
    }
    if (event.key === "Escape" && overlay) {
      event.preventDefault();
      closeShellOverlay();
      return;
    }
    const digit = event.altKey && !event.ctrlKey ? Number(event.key) : 0;
    if (digit >= 1 && digit <= APP_ORDER.length) {
      const appId = APP_ORDER[digit - 1];
      if (availableApps.has(appId)) {
        event.preventDefault();
        void shellCommandRegistry.execute(`app.open:${appId}`);
      }
      return;
    }
    if (!event.altKey || !event.ctrlKey || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
    const available = APP_ORDER.filter((appId) => availableApps.has(appId));
    if (!available.length) return;
    const current = Math.max(0, available.indexOf(uiState.focusedAppId ?? available[0]));
    const delta = event.key === "ArrowRight" ? 1 : -1;
    event.preventDefault();
    void shellCommandRegistry.execute(`window.focus:${available[(current + delta + available.length) % available.length]}`);
  }

  function handleShellKeyUp(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Alt" && overlay === "switcher") closeShellOverlay();
  }

  return (
    <div className="tinyos-shell" data-has-dialog={snapshot.dialog ? "true" : undefined} onKeyDown={handleShellKeyDown} onKeyUp={handleShellKeyUp}>
      <section
        aria-label="TinyOS desktop"
        className="tinyos-desktop"
        data-app-count={availableApps.size}
        data-layout-mode={uiState.layoutMode}
        ref={desktopRef}
        onContextMenu={(event) => openContextMenu(event, "Desktop menu", ["shell.overview", "shell.palette", "shell.reset_layout"])}
      >
        <div aria-hidden="true" className="tinyos-desktop__environment">
          <span className="tinyos-desktop__brand"><MonitorDot size={17} /><strong>TinyOS</strong><small>Agent workspace</small></span>
          <span className="tinyos-desktop__mode">{history ? "History snapshot" : "Live workspace"}</span>
        </div>
        <div aria-label="TinyOS system tools" className="tinyos-desktop__system-tools" role="toolbar">
          <button aria-label="Open window Overview" title="Overview" type="button" onClick={() => void shellCommandRegistry.execute("shell.overview")}><LayoutGrid aria-hidden="true" size={15} /></button>
          <button aria-label="Open command palette" title="Command palette · Ctrl+K" type="button" onClick={() => void shellCommandRegistry.execute("shell.palette")}><Command aria-hidden="true" size={15} /></button>
          <button
            aria-label="Open notification center"
            data-attention={snapshot.notifications.some((notification) => !readNotificationIds.has(notification.id)) ? "true" : undefined}
            disabled={!requiredShellCommand(shellCommandRegistry, "shell.notification_center").availability.available}
            title={snapshot.notifications.length ? "Notification center" : "No notifications"}
            type="button"
            onClick={() => void shellCommandRegistry.execute("shell.notification_center")}
          ><Bell aria-hidden="true" size={15} /></button>
        </div>

        <nav aria-label="TinyOS applications" className="tinyos-launcher">
          {APP_ORDER.map((appId, index) => {
            const Icon = APP_ICONS[appId];
            const available = availableApps.has(appId);
            const active = uiState.focusedAppId === appId && !uiState.minimizedAppIds.includes(appId);
            const window = appWindows.find((candidate) => candidate.appId === appId);
            const status = window?.entries[window.entries.length - 1]?.step.status;
            return (
              <button
                aria-label={`Open ${APP_LABELS[appId]}`}
                aria-pressed={active}
                className="tinyos-launcher__app"
                data-active={active ? "true" : undefined}
                data-available={available ? "true" : undefined}
                data-minimized={uiState.minimizedAppIds.includes(appId) ? "true" : undefined}
                data-status={status}
                disabled={!available}
                key={appId}
                title={available ? `${APP_LABELS[appId]} · Alt+${index + 1}` : `${APP_LABELS[appId]} has no activity yet`}
                type="button"
                onClick={() => void shellCommandRegistry.execute(`app.open:${appId}`)}
                onContextMenu={(event) => available && openContextMenu(event, `${APP_LABELS[appId]} menu`, [
                  `window.focus:${appId}`,
                  `window.maximize:${appId}`,
                  `window.minimize:${appId}`,
                ])}
              >
                <Icon aria-hidden="true" size={19} />
                <span>{APP_LABELS[appId]}</span>
                {available ? <Circle aria-hidden="true" className="tinyos-launcher__state" fill="currentColor" size={6} /> : null}
              </button>
            );
          })}
          <span aria-hidden="true" className="tinyos-launcher__divider" />
          <button aria-label="Reset TinyOS layout" className="tinyos-launcher__app tinyos-launcher__reset" title="Reset layout" type="button" onClick={() => void shellCommandRegistry.execute("shell.reset_layout")}>
            <RotateCcw aria-hidden="true" size={18} />
            <span>Reset</span>
          </button>
        </nav>

        {!windows.length ? <TinyOsDesktopEmpty /> : windows.map((window) => (
          <TinyOsAppWindow
            active={uiState.focusedAppId === window.appId}
            activeTabId={uiState.activeTabs[window.appId]}
            commandRegistry={shellCommandRegistry}
            canDirectEdit={canDirectEdit && !history}
            canRequestChange={canRequestChange}
            canSaveFile={canSaveFile && !history}
            key={window.id}
            kernel={snapshot.kernel}
            systemMonitorControls={systemMonitorControls}
            layout={uiState.windowLayout[window.appId]}
            zIndex={uiState.zOrder.indexOf(window.appId) + 2}
            window={window}
            filesController={filesController}
            layoutMode={layoutMode}
            onFocus={() => void shellCommandRegistry.execute(`window.focus:${window.appId}`)}
            onAttachContext={onAttachContext}
            onInspect={(entry) => void shellCommandRegistry.execute(`evidence.inspect:${entry.step.id}`)}
            onMaximize={() => void shellCommandRegistry.execute(`window.maximize:${window.appId}`)}
            onMinimize={() => void shellCommandRegistry.execute(`window.minimize:${window.appId}`)}
            onOpenContextMenu={(event) => openContextMenu(event, `${window.title} window menu`, [
              `window.focus:${window.appId}`,
              `window.maximize:${window.appId}`,
              `window.minimize:${window.appId}`,
              ...(window.entries.length ? [`evidence.inspect:${window.entries[window.entries.length - 1].step.id}` as const] : []),
            ])}
            onOpenArtifact={onOpenArtifact}
            onAgentRequest={onAgentRequest}
            onDeleteFile={onDeleteFile}
            onMoveFile={onMoveFile}
            onSaveFile={onSaveFile}
            onSetRect={(rect) => dispatchUi({ appId: window.appId, rect, type: "set_rect" })}
            onSnap={(edge) => dispatchUi({ appId: window.appId, edge, type: "snap" })}
            onTabChange={(tabId) => dispatchUi({ appId: window.appId, tabId, type: "set_active_tab" })}
            requestChangeUnavailableReason={requestChangeUnavailableReason}
            directEditUnavailableReason={history ? "Direct host actions are disabled while viewing History." : directEditUnavailableReason}
            saveFileUnavailableReason={history ? "Direct host actions are disabled while viewing History." : saveFileUnavailableReason}
            runningTerminalRunId={runningTerminalRunId}
          />
        ))}

        <TinyOsNotifications
          notifications={snapshot.notifications}
          onSelect={(notificationId) => void shellCommandRegistry.execute(`notification.open:${notificationId}`)}
        />

        {overlay ? (
          <TinyOsShellOverlay
            appWindows={appWindows}
            commandRegistry={shellCommandRegistry}
            minimizedAppIds={uiState.minimizedAppIds}
            notifications={snapshot.notifications}
            overlay={overlay}
            paletteQuery={paletteQuery}
            readNotificationIds={readNotificationIds}
            switcherAppId={switcherAppId}
            zOrder={uiState.zOrder}
            onClose={closeShellOverlay}
            onPaletteQueryChange={setPaletteQuery}
          />
        ) : null}
        {contextMenu ? <TinyOsContextMenu commandRegistry={shellCommandRegistry} menu={contextMenu} onClose={() => setContextMenu(undefined)} /> : null}

        {snapshot.dialog && history ? (
          <TinyOsHistoricalDialog dialog={snapshot.dialog} />
        ) : snapshot.dialog ? (
          <TinyOsSystemDialog
            agentUiForms={agentUiForms}
            dialog={snapshot.dialog}
            resolvingApprovalId={resolvingApprovalId}
            submittingFormId={submittingFormId}
            onCancelForm={onCancelForm}
            onResolveApproval={onResolveApproval}
            onSubmitForm={onSubmitForm}
          />
        ) : null}

        {pinnedEvidence.length ? (
          <TinyOsInspector
            evidence={pinnedEvidence}
            onClose={(pin) => setPinnedEvidence((current) => current.filter(({ id }) => id !== pin.id))}
            onOpenArtifact={onOpenArtifact}
            onReferenceDrop={(event) => {
              const parsed = readTinyOsReferenceTransfer(event.dataTransfer);
              if (parsed.status === "rejected") {
                setTransferMessage({ kind: "error", text: parsed.reason });
                return;
              }
              const accepted = tinyOsReferenceAcceptedBy(parsed.reference, "inspector");
              if (accepted.status === "rejected") {
                setTransferMessage({ kind: "error", text: accepted.reason });
                return;
              }
              void shellCommandRegistry.execute(`evidence.inspect:${accepted.reference.itemId}`);
              setTransferMessage({ kind: "success", text: `${accepted.reference.title} pinned in Inspector.` });
            }}
          />
        ) : null}
        {transferMessage ? <p className="tinyos-transfer-status" data-kind={transferMessage.kind} role={transferMessage.kind === "error" ? "alert" : "status"}>{transferMessage.text}</p> : null}
      </section>

      <TinyOsOperationShelf commandRegistry={shellCommandRegistry} operations={snapshot.operations} />
    </div>
  );
}

function TinyOsContextMenu({ commandRegistry, menu, onClose }: {
  commandRegistry: TinyOsShellCommandRegistry;
  menu: TinyOsContextMenuState;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => menuRef.current?.querySelector<HTMLElement>("button:not(:disabled)")?.focus(), []);

  async function execute(commandId: TinyOsShellCommandId) {
    const result = await commandRegistry.execute(commandId);
    if (result.status === "executed") onClose();
  }

  return (
    <div className="tinyos-context-menu-layer">
      <button aria-label={`Close ${menu.label}`} className="tinyos-context-menu-layer__backdrop" type="button" onClick={onClose} />
      <div aria-label={menu.label} className="tinyos-context-menu" ref={menuRef} role="menu" style={{ left: menu.x, top: menu.y }} onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        onClose();
      }}>
        {menu.commandIds.map((commandId) => {
          const command = requiredShellCommand(commandRegistry, commandId);
          return (
            <button
              disabled={!command.availability.available}
              key={command.id}
              role="menuitem"
              title={command.availability.available ? command.label : command.availability.reason}
              type="button"
              onClick={() => void execute(command.id)}
            ><span>{command.label}</span><small>{command.scope === "runtime" ? "Runtime" : "Local"}</small></button>
          );
        })}
      </div>
    </div>
  );
}

function TinyOsShellOverlay({
  appWindows,
  commandRegistry,
  minimizedAppIds,
  notifications,
  onClose,
  onPaletteQueryChange,
  overlay,
  paletteQuery,
  readNotificationIds,
  switcherAppId,
  zOrder,
}: {
  appWindows: TinyOsWindow[];
  commandRegistry: TinyOsShellCommandRegistry;
  minimizedAppIds: TinyOsAppId[];
  notifications: TinyOsDesktopSnapshot["notifications"];
  onClose: () => void;
  onPaletteQueryChange: (query: string) => void;
  overlay: TinyOsShellOverlay;
  paletteQuery: string;
  readNotificationIds: Set<string>;
  switcherAppId?: TinyOsAppId;
  zOrder: TinyOsAppId[];
}) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const orderedWindows = [...appWindows].sort((left, right) => zOrder.indexOf(right.appId) - zOrder.indexOf(left.appId));
  const normalizedQuery = paletteQuery.trim().toLocaleLowerCase();
  const paletteCommands = commandRegistry.commands.filter((command) => {
    if (command.input.kind === "fields") return false;
    if (!normalizedQuery) return command.id !== "shell.palette";
    const searchable = [command.id, command.label, command.category, command.scope, ...command.keywords].join(" ").toLocaleLowerCase();
    return searchable.includes(normalizedQuery);
  }).slice(0, 40);

  useEffect(() => {
    const overlayElement = overlayRef.current;
    if (!overlayElement) return;
    const preferred = overlayElement.querySelector<HTMLElement>("[data-autofocus='true']");
    const firstFocusable = overlayElement.querySelector<HTMLElement>("input, button:not(:disabled), [tabindex='0']");
    (preferred ?? firstFocusable)?.focus();
  }, [overlay]);

  async function executeAndClose(commandId: TinyOsShellCommandId) {
    const execution = await commandRegistry.execute(commandId);
    if (execution.status === "executed") onClose();
  }

  function handleOverlayKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...(overlayRef.current?.querySelectorAll<HTMLElement>("input, button:not(:disabled), [tabindex='0']") ?? [])];
    if (!focusable.length) return;
    const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
    const nextIndex = event.shiftKey
      ? (currentIndex <= 0 ? focusable.length - 1 : currentIndex - 1)
      : (currentIndex === focusable.length - 1 ? 0 : currentIndex + 1);
    event.preventDefault();
    focusable[nextIndex]?.focus();
  }

  return (
    <div className="tinyos-shell-overlay" data-overlay={overlay}>
      <button aria-label={`Close ${overlayLabel(overlay)}`} className="tinyos-shell-overlay__backdrop" type="button" onClick={onClose} />
      <div
        aria-label={overlayLabel(overlay)}
        aria-modal="true"
        className="tinyos-shell-overlay__panel"
        ref={overlayRef}
        role="dialog"
        onKeyDown={handleOverlayKeyDown}
      >
        {overlay === "switcher" ? (
          <>
            <header><span><Command aria-hidden="true" size={16} /><strong>Switch applications</strong></span><small>Release Alt to continue</small></header>
            <div aria-label="Available TinyOS applications" className="tinyos-window-switcher" role="listbox">
              {orderedWindows.map((window) => {
                const Icon = APP_ICONS[window.appId];
                const selected = window.appId === switcherAppId;
                return (
                  <button
                    aria-selected={selected}
                    data-autofocus={selected ? "true" : undefined}
                    data-selected={selected ? "true" : undefined}
                    key={window.id}
                    role="option"
                    type="button"
                    onClick={() => void executeAndClose(`window.focus:${window.appId}`)}
                  ><Icon aria-hidden="true" size={19} /><span><strong>{window.title}</strong><small>{minimizedAppIds.includes(window.appId) ? "Minimized · will restore" : "Available"}</small></span></button>
                );
              })}
            </div>
          </>
        ) : null}

        {overlay === "overview" ? (
          <>
            <header><span><LayoutGrid aria-hidden="true" size={16} /><strong>Window Overview</strong></span><button aria-label="Close window Overview" type="button" onClick={onClose}><X aria-hidden="true" size={15} /></button></header>
            <div className="tinyos-window-overview">
              {orderedWindows.map((window, index) => {
                const Icon = APP_ICONS[window.appId];
                const minimized = minimizedAppIds.includes(window.appId);
                return (
                  <button data-autofocus={index === 0 ? "true" : undefined} key={window.id} type="button" onClick={() => void executeAndClose(`window.focus:${window.appId}`)}>
                    <span className="tinyos-window-overview__preview"><Icon aria-hidden="true" size={24} /><small>{window.entries.length} canonical item{window.entries.length === 1 ? "" : "s"}</small></span>
                    <span><strong>{window.title}</strong><small>{minimized ? "Minimized · select to restore" : "Open"}</small></span>
                  </button>
                );
              })}
            </div>
          </>
        ) : null}

        {overlay === "palette" ? (
          <>
            <header className="tinyos-command-palette__search"><Search aria-hidden="true" size={16} /><input aria-label="Search TinyOS commands" autoComplete="off" data-autofocus="true" placeholder="Search apps, resources, processes, operations…" type="search" value={paletteQuery} onChange={(event) => onPaletteQueryChange(event.currentTarget.value)} /><kbd>Esc</kbd></header>
            <div aria-label="TinyOS command results" className="tinyos-command-palette__results" role="listbox">
              {paletteCommands.length ? paletteCommands.map((command) => (
                <button
                  aria-disabled={!command.availability.available}
                  disabled={!command.availability.available}
                  key={command.id}
                  role="option"
                  title={command.availability.available ? command.label : command.availability.reason}
                  type="button"
                  onClick={() => void executeAndClose(command.id)}
                >
                  <span><strong>{command.label}</strong><small>{command.category} · {command.scope === "runtime" ? "runtime" : "local"}</small></span>
                  <small>{command.availability.available ? command.id : command.availability.reason}</small>
                </button>
              )) : <p className="tinyos-shell-overlay__empty">No registered command matches “{paletteQuery}”.</p>}
            </div>
          </>
        ) : null}

        {overlay === "notifications" ? (
          <>
            <header><span><Bell aria-hidden="true" size={16} /><strong>Notification center</strong></span><button aria-label="Close notification center" type="button" onClick={onClose}><X aria-hidden="true" size={15} /></button></header>
            <div aria-label="Derived notification history" className="tinyos-notification-center">
              {[...notifications].reverse().map((notification, index) => {
                const read = readNotificationIds.has(notification.id);
                const readCommand = requiredShellCommand(commandRegistry, `notification.read:${notification.id}`);
                return (
                  <article data-read={read ? "true" : undefined} key={notification.id}>
                    <button data-autofocus={index === 0 ? "true" : undefined} type="button" onClick={() => void executeAndClose(`notification.open:${notification.id}`)}>
                      {notification.kind === "completed" ? <CheckCircle2 aria-hidden="true" size={16} /> : <AlertTriangle aria-hidden="true" size={16} />}
                      <span><strong>{notification.title}</strong><small>{notification.message}</small><code>canonical item · {notification.entry.step.id}</code></span>
                    </button>
                    <button disabled={!readCommand.availability.available} title={readCommand.availability.available ? readCommand.label : readCommand.availability.reason} type="button" onClick={() => void commandRegistry.execute(readCommand.id)}>{read ? "Read" : "Mark read"}</button>
                  </article>
                );
              })}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

function TinyOsDesktopEmpty() {
  return (
    <div className="tinyos-desktop__empty">
      <FileCode2 aria-hidden="true" size={26} />
      <strong>Your workspace is ready</strong>
      <span>Files, terminals, plans, and browser activity will open here as the Agent works.</span>
    </div>
  );
}

function TinyOsAppWindow({
  active,
  activeTabId,
  canDirectEdit,
  canRequestChange,
  canSaveFile,
  commandRegistry,
  directEditUnavailableReason,
  filesController,
  layout,
  layoutMode,
  kernel,
  onFocus,
  onAttachContext,
  onInspect,
  onMaximize,
  onMinimize,
  onOpenContextMenu,
  onOpenArtifact,
  onAgentRequest,
  onDeleteFile,
  onMoveFile,
  onSaveFile,
  onSetRect,
  onSnap,
  onTabChange,
  requestChangeUnavailableReason,
  runningTerminalRunId,
  saveFileUnavailableReason,
  systemMonitorControls,
  window,
  zIndex,
}: {
  active: boolean;
  activeTabId?: string;
  canDirectEdit: boolean;
  canRequestChange: boolean;
  canSaveFile: boolean;
  commandRegistry: TinyOsShellCommandRegistry;
  directEditUnavailableReason?: string;
  filesController?: TinyOsFilesController;
  layout?: TinyOsWindowRect & { maximized: boolean };
  layoutMode: TinyOsLayoutMode;
  kernel?: TinyOsKernelSnapshot;
  onFocus: () => void;
  onAttachContext: (reference: TinyOsContextReference) => void;
  onInspect: (entry: TinyOsTimelineEntry) => void;
  onMaximize: () => void;
  onMinimize: () => void;
  onOpenContextMenu: (event: MouseEvent<HTMLElement>) => void;
  onOpenArtifact: (artifact: ArtifactRef) => void;
  onAgentRequest: (reference: TinyOsAgentRequestReference, intent: TinyOsAgentRequestIntent) => void;
  onDeleteFile: (input: TinyOsFileDeleteInput) => Promise<void>;
  onMoveFile: (input: TinyOsFileMoveInput) => Promise<void>;
  onSaveFile: (input: TinyOsFileSaveInput) => Promise<void>;
  onSetRect: (rect: TinyOsWindowRect) => void;
  onSnap: (edge: "left" | "right") => void;
  onTabChange: (tabId: string) => void;
  requestChangeUnavailableReason?: string;
  runningTerminalRunId?: string;
  saveFileUnavailableReason?: string;
  systemMonitorControls: TinyOsSystemMonitorControls;
  window: TinyOsWindow;
  zIndex: number;
}) {
  const Icon = APP_ICONS[window.appId];
  const latest = window.entries[window.entries.length - 1];
  const pointerState = useRef<{
    kind: "move" | "resize";
    pointerId: number;
    startClientX: number;
    startClientY: number;
    startRect: TinyOsWindowRect;
  } | undefined>(undefined);
  const style = layout ? {
    height: `${layout.height}px`,
    left: `${layout.x}px`,
    top: `${layout.y}px`,
    width: `${layout.width}px`,
    zIndex,
  } satisfies CSSProperties : { zIndex };

  function startPointer(event: PointerEvent<HTMLElement>, kind: "move" | "resize") {
    if (!layout || event.button !== 0) return;
    if (kind === "move" && (event.target as Element).closest("button")) return;
    event.preventDefault();
    onFocus();
    pointerState.current = {
      kind,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startRect: layout,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function movePointer(event: PointerEvent<HTMLElement>) {
    const interaction = pointerState.current;
    if (!interaction || interaction.pointerId !== event.pointerId) return;
    const dx = event.clientX - interaction.startClientX;
    const dy = event.clientY - interaction.startClientY;
    onSetRect(interaction.kind === "move" ? {
      ...interaction.startRect,
      x: interaction.startRect.x + dx,
      y: interaction.startRect.y + dy,
    } : {
      ...interaction.startRect,
      height: interaction.startRect.height + dy,
      width: interaction.startRect.width + dx,
    });
  }

  function endPointer(event: PointerEvent<HTMLElement>) {
    if (pointerState.current?.pointerId !== event.pointerId) return;
    pointerState.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function handleWindowKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (!layout) return;
    if (event.altKey && event.key === "ArrowLeft") {
      event.preventDefault();
      onSnap("left");
      return;
    }
    if (event.altKey && event.key === "ArrowRight") {
      event.preventDefault();
      onSnap("right");
      return;
    }
    if (event.altKey && event.key === "ArrowUp") {
      event.preventDefault();
      onMaximize();
      return;
    }
    if (event.altKey && event.key === "ArrowDown") {
      event.preventDefault();
      onMinimize();
      return;
    }
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const deltaX = event.key === "ArrowLeft" ? -16 : event.key === "ArrowRight" ? 16 : 0;
    const deltaY = event.key === "ArrowUp" ? -16 : event.key === "ArrowDown" ? 16 : 0;
    onSetRect(event.shiftKey ? {
      ...layout,
      height: layout.height + deltaY,
      width: layout.width + deltaX,
    } : {
      ...layout,
      x: layout.x + deltaX,
      y: layout.y + deltaY,
    });
  }

  return (
    <article
      aria-label={`${window.title} window`}
      className="tinyos-window"
      data-active={active ? "true" : undefined}
      data-app={window.appId}
      data-maximized={layout?.maximized ? "true" : undefined}
      onMouseDown={onFocus}
      onContextMenu={onOpenContextMenu}
      style={style}
    >
      <header
        aria-label={`Move ${window.title} window`}
        className="tinyos-window__titlebar"
        tabIndex={0}
        title="Drag to move. Arrow keys move; Shift+Arrow resizes; Alt+Arrow snaps or maximizes."
        onDoubleClick={onMaximize}
        onKeyDown={handleWindowKeyDown}
        onPointerDown={(event) => startPointer(event, "move")}
        onPointerMove={movePointer}
        onPointerUp={endPointer}
      >
        <span><Icon aria-hidden="true" size={15} /><strong>{window.title}</strong></span>
        <span className="tinyos-window__source">{latest?.step.title ?? (window.appId === "system_monitor" ? `${kernel?.processes.length ?? 0} processes` : "Workspace Explorer")}</span>
        {latest ? <TinyOsStatus status={latest.step.status} /> : null}
        {latest ? <button aria-label={`Inspect ${window.title}`} title={`Inspect ${window.title}`} type="button" onClick={() => onInspect(latest)}><Info aria-hidden="true" size={14} /></button> : null}
        <button aria-label={`${layout?.maximized ? "Restore" : "Maximize"} ${window.title}`} title={layout?.maximized ? "Restore" : "Maximize"} type="button" onClick={onMaximize}><Maximize2 aria-hidden="true" size={14} /></button>
        <button aria-label={`Minimize ${window.title}`} title={`Minimize ${window.title}`} type="button" onClick={onMinimize}><Minus aria-hidden="true" size={15} /></button>
      </header>
      <div className="tinyos-window__content">
        <TinyOsAppContent
          activeTabId={activeTabId}
          canDirectEdit={canDirectEdit}
          canRequestChange={canRequestChange}
          canSaveFile={canSaveFile}
          commandLifecycle={systemMonitorControls.commandLifecycle}
          commandRegistry={commandRegistry}
          directEditUnavailableReason={directEditUnavailableReason}
          filesController={filesController}
          layoutMode={layoutMode}
          kernel={kernel}
          window={window}
          onAttachContext={onAttachContext}
          onOpenArtifact={onOpenArtifact}
          onAgentRequest={onAgentRequest}
          onDeleteFile={onDeleteFile}
          onMoveFile={onMoveFile}
          onSaveFile={onSaveFile}
          onTabChange={onTabChange}
          requestChangeUnavailableReason={requestChangeUnavailableReason}
          runningTerminalRunId={runningTerminalRunId}
          saveFileUnavailableReason={saveFileUnavailableReason}
          systemMonitorControls={systemMonitorControls}
        />
      </div>
      <div
        aria-label={`Resize ${window.title} window`}
        className="tinyos-window__resize-handle"
        role="separator"
        tabIndex={-1}
        onPointerDown={(event) => startPointer(event, "resize")}
        onPointerMove={movePointer}
        onPointerUp={endPointer}
      />
    </article>
  );
}

function TinyOsAppContent({ activeTabId, canDirectEdit, canRequestChange, canSaveFile, commandLifecycle, commandRegistry, directEditUnavailableReason, filesController, kernel, layoutMode, window, onAgentRequest, onAttachContext, onDeleteFile, onMoveFile, onOpenArtifact, onSaveFile, onTabChange, requestChangeUnavailableReason, runningTerminalRunId, saveFileUnavailableReason, systemMonitorControls }: {
  activeTabId?: string;
  canDirectEdit: boolean;
  canRequestChange: boolean;
  canSaveFile: boolean;
  commandLifecycle: TinyOsCommandLifecycle;
  commandRegistry: TinyOsShellCommandRegistry;
  directEditUnavailableReason?: string;
  filesController?: TinyOsFilesController;
  kernel?: TinyOsKernelSnapshot;
  layoutMode: TinyOsLayoutMode;
  onAgentRequest: (reference: TinyOsAgentRequestReference, intent: TinyOsAgentRequestIntent) => void;
  onAttachContext: (reference: TinyOsContextReference) => void;
  onDeleteFile: (input: TinyOsFileDeleteInput) => Promise<void>;
  onMoveFile: (input: TinyOsFileMoveInput) => Promise<void>;
  onOpenArtifact: (artifact: ArtifactRef) => void;
  onSaveFile: (input: TinyOsFileSaveInput) => Promise<void>;
  onTabChange: (tabId: string) => void;
  requestChangeUnavailableReason?: string;
  runningTerminalRunId?: string;
  saveFileUnavailableReason?: string;
  systemMonitorControls: TinyOsSystemMonitorControls;
  window: TinyOsWindow;
}) {
  switch (window.appId) {
    case "files": return filesController?.queryAvailable || !window.entries.length
      ? filesController
        ? <TinyOsFilesExplorer canDirectEdit={canDirectEdit} canRequestChange={canRequestChange} canSave={canSaveFile} commandLifecycle={commandLifecycle} commandRegistry={commandRegistry} controller={filesController} directEditUnavailableReason={directEditUnavailableReason} kernel={kernel} layoutMode={layoutMode} onAttachContext={onAttachContext} onDeleteFile={onDeleteFile} onMoveFile={onMoveFile} onRequestExplanation={(reference) => onAgentRequest(reference, "explain")} onRequestModification={(reference) => onAgentRequest(reference, "modify")} onSaveFile={onSaveFile} requestChangeUnavailableReason={requestChangeUnavailableReason} saveUnavailableReason={saveFileUnavailableReason} />
        : <EmptyCopy text="Workspace Explorer is unavailable." />
      : <TinyOsFiles activeTabId={activeTabId} canRequestChange={canRequestChange} window={window} onAgentRequest={onAgentRequest} onAttachContext={onAttachContext} onTabChange={onTabChange} requestChangeUnavailableReason={requestChangeUnavailableReason} />;
    case "terminal": return <div className="tinyos-terminal-host"><TinyOsTerminalHostControls commandLifecycle={commandLifecycle} commandRegistry={commandRegistry} runningRunId={runningTerminalRunId} />{window.entries.length ? <TinyOsTerminal activeTabId={activeTabId} canRequestChange={canRequestChange} kernel={kernel} window={window} onAgentRequest={onAgentRequest} onAttachContext={onAttachContext} onTabChange={onTabChange} requestChangeUnavailableReason={requestChangeUnavailableReason} /> : <EmptyCopy text="Run a reviewed command to create a retained canonical execution. TinyOS does not present this as a persistent PTY session." />}</div>;
    case "browser": return <TinyOsBrowser commandRegistry={commandRegistry} kernel={kernel} window={window} onOpenArtifact={onOpenArtifact} />;
    case "plan": return <TinyOsPlan canRequestChange={canRequestChange} entry={[...window.entries].reverse().find(({ step }) => Boolean(step.plan)) ?? window.entries[window.entries.length - 1]} onAgentRequest={onAgentRequest} requestChangeUnavailableReason={requestChangeUnavailableReason} />;
    case "memory": return <TinyOsMemory window={window} />;
    case "subagents": return <TinyOsSubagents window={window} />;
    case "artifacts": return <TinyOsArtifacts window={window} onOpenArtifact={onOpenArtifact} />;
    case "inspector": return <TinyOsStructured entry={window.entries[window.entries.length - 1]} />;
    case "system_monitor": return kernel ? <TinyOsSystemMonitor controls={systemMonitorControls} snapshot={kernel} /> : <EmptyCopy text="Kernel process data is unavailable." />;
  }
}

function TinyOsFiles({ activeTabId, canRequestChange, onAgentRequest, onAttachContext, onTabChange, requestChangeUnavailableReason, window }: { activeTabId?: string; canRequestChange: boolean; onAgentRequest: (reference: TinyOsAgentRequestReference, intent: TinyOsAgentRequestIntent) => void; onAttachContext: (reference: TinyOsContextReference) => void; onTabChange: (tabId: string) => void; requestChangeUnavailableReason?: string; window: TinyOsWindow }) {
  const files = distinctLatestFiles(window.entries.map((entry) => ({ entry, path: filePath(entry.step) })));
  const active = files.find(({ entry }) => entry.step.id === activeTabId) ?? files[files.length - 1];
  const content = fileContent(active.entry.step);
  const lines = content.split("\n").slice(0, 240);
  const directories = uniqueDirectories(files.map(({ path }) => path));
  const [selection, setSelection] = useState<{ anchor: number; end: number }>();
  useEffect(() => setSelection(undefined), [active.entry.step.id]);

  function selectLine(line: number, extend: boolean) {
    setSelection((current) => extend && current
      ? { anchor: current.anchor, end: line }
      : { anchor: line, end: line });
  }

  const selectionStart = selection ? Math.min(selection.anchor, selection.end) : undefined;
  const selectionEnd = selection ? Math.max(selection.anchor, selection.end) : undefined;
  const selectedText = selectionStart !== undefined && selectionEnd !== undefined
    ? boundedSelectionText(lines.slice(selectionStart - 1, selectionEnd).join("\n"))
    : "";
  const selectedReference: TinyOsContextReference | undefined = selectionStart !== undefined && selectionEnd !== undefined ? {
    endLine: selectionEnd,
    kind: "file",
    path: active.path,
    provenance: { kind: "canonical", sourceItemId: active.entry.step.id, turnId: active.entry.turnId },
    selectedText,
    startLine: selectionStart,
    ...(fileRevision(active.entry.step) ? { revision: fileRevision(active.entry.step) } : {}),
  } : undefined;
  return (
    <div className="tinyos-files">
      <aside>
        <strong><FolderOpen aria-hidden="true" size={12} />Workspace</strong>
        {directories.map((directory) => <span className="tinyos-files__directory" key={directory}><Folder aria-hidden="true" size={12} />{directory}</span>)}
        {files.slice(-12).map(({ entry, path }) => (
          <button aria-pressed={entry === active.entry} data-active={entry === active.entry ? "true" : undefined} key={`${entry.turnId}:${entry.step.id}`} title={path} type="button" onClick={() => onTabChange(entry.step.id)}><FileText aria-hidden="true" size={13} />{fileName(path)}</button>
        ))}
      </aside>
      <section>
        <div className="tinyos-app-tabs" role="tablist" aria-label="Open files">
          {files.slice(-6).map(({ entry, path }) => <button aria-selected={entry === active.entry} data-active={entry === active.entry ? "true" : undefined} key={entry.step.id} role="tab" type="button" onClick={() => onTabChange(entry.step.id)}>{fileName(path)}</button>)}
        </div>
        <div className="tinyos-files__path"><FileCode2 aria-hidden="true" size={14} />{active.path}</div>
        {content ? <ol className="tinyos-code-view">{lines.map((line, index) => {
          const lineNumber = index + 1;
          const selected = selectionStart !== undefined && selectionEnd !== undefined && lineNumber >= selectionStart && lineNumber <= selectionEnd;
          return <li data-selected={selected ? "true" : undefined} key={index}><button type="button" onClick={(event) => selectLine(lineNumber, event.shiftKey)}><code>{line || " "}</code></button></li>;
        })}</ol> : <EmptyCopy text={active.entry.step.summary || "No file preview was returned."} />}
        <footer className="tinyos-files__status"><span>{fileLanguage(active.path)}</span><span>UTF-8</span>{selectedReference ? <button draggable="true" title="Attach to Chat or drag this structured file reference" type="button" onClick={() => onAttachContext(selectedReference)} onDragStart={(event) => writeTinyOsReferenceTransfer(event.dataTransfer, { kind: "context", reference: selectedReference })}><Paperclip aria-hidden="true" size={11} />Attach {active.path} · L{selectionStart}{selectionEnd !== selectionStart ? `–${selectionEnd}` : ""}</button> : null}{selectedReference ? <button disabled={!canRequestChange} title={canRequestChange ? "Ask Agent to explain this selection" : requestChangeUnavailableReason} type="button" onClick={() => onAgentRequest(selectedReference, "explain")}><MessageCircleQuestion aria-hidden="true" size={11} />Explain</button> : null}{selectedReference ? <button disabled={!canRequestChange} title={canRequestChange ? "Ask Agent to modify this selection" : requestChangeUnavailableReason} type="button" onClick={() => onAgentRequest(selectedReference, "modify")}><PencilLine aria-hidden="true" size={11} />Modify</button> : null}<span>Canonical item {active.entry.step.sequence + 1}</span></footer>
      </section>
    </div>
  );
}

function TinyOsTerminalHostControls({ commandLifecycle, commandRegistry, runningRunId }: {
  commandLifecycle: TinyOsCommandLifecycle;
  commandRegistry: TinyOsShellCommandRegistry;
  runningRunId?: string;
}) {
  const [command, setCommand] = useState("");
  const [cwd, setCwd] = useState(".");
  const [reviewed, setReviewed] = useState(false);
  const [error, setError] = useState("");
  const executeCommand = requiredShellCommand(commandRegistry, "terminal.execute");
  const cancelCommand = requiredShellCommand(commandRegistry, "terminal.cancel");
  const canExecute = executeCommand.availability.available;
  const canCancel = cancelCommand.availability.available;
  return (
    <form className="tinyos-terminal-command" onSubmit={(event) => {
      event.preventDefault();
      if (!reviewed || !canExecute || !command.trim()) return;
      setError("");
      void commandRegistry.execute("terminal.execute", {
        command: command.trim(),
        ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
      }).then((execution) => {
        if (execution.status === "rejected") throw new Error(execution.reason);
        setCommand("");
        setReviewed(false);
      }).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
    }}>
      <label><span>Command</span><input aria-label="TinyOS terminal command" disabled={!canExecute || Boolean(runningRunId)} placeholder="Enter a workspace command" value={command} onChange={(event) => { setCommand(event.currentTarget.value); setReviewed(false); }} /></label>
      <label><span>cwd</span><input aria-label="TinyOS terminal working directory" disabled={!canExecute || Boolean(runningRunId)} value={cwd} onChange={(event) => { setCwd(event.currentTarget.value); setReviewed(false); }} /></label>
      <div>
        <button disabled={!canExecute || !command.trim() || Boolean(runningRunId)} title={canExecute ? "Review the exact command and execution boundary" : executeCommand.availability.reason} type="button" onClick={() => setReviewed(true)}>Review command</button>
        <button disabled={!canExecute || !reviewed || !command.trim() || Boolean(runningRunId)} title="Execute read-only with network denied" type="submit"><Play aria-hidden="true" size={12} />Run command</button>
        <button disabled={!canCancel || !runningRunId} title={canCancel ? "Interrupt the correlated TinyOS terminal process" : cancelCommand.availability.reason} type="button" onClick={() => {
          setError("");
          void commandRegistry.execute("terminal.cancel").then((execution) => {
            if (execution.status === "rejected") throw new Error(execution.reason);
          }).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
        }}><Pause aria-hidden="true" size={12} />Cancel process</button>
      </div>
      {reviewed ? <p role="status"><ShieldCheck aria-hidden="true" size={12} />Read-only sandbox · network denied · cwd {cwd || "."}</p> : null}
      <p className="tinyos-terminal-command__contract"><ShieldCheck aria-hidden="true" size={12} />Retained execution · non-TTY · no persistent shell state</p>
      {commandLifecycle.stage !== "idle" && (commandLifecycle.command.kind === "terminal.execute" || commandLifecycle.command.kind === "terminal.cancel") ? <TinyOsTerminalLifecycle lifecycle={commandLifecycle} /> : null}
      {error ? <p role="alert">{error}</p> : null}
    </form>
  );
}

function TinyOsTerminalLifecycle({ lifecycle }: { lifecycle: Exclude<TinyOsCommandLifecycle, { stage: "idle" }> }) {
  const label = lifecycle.command.kind === "terminal.cancel" ? "Cancel" : "Execution";
  if (lifecycle.stage === "sending") return <p className="tinyos-terminal-lifecycle" role="status"><strong>{label} dispatching</strong><span>Native transport has not accepted the command yet.</span></p>;
  if (lifecycle.stage === "waiting_for_canonical") return <p className="tinyos-terminal-lifecycle" role="status"><strong>{label} awaiting runtime</strong><span>Transport accepted · waiting for canonical acknowledgement.</span></p>;
  if (lifecycle.stage === "acknowledged") return <p className="tinyos-terminal-lifecycle" role="status"><strong>{label} acknowledged</strong><span>Canonical item {lifecycle.acknowledgement.itemId}</span></p>;
  if (lifecycle.stage === "completed") return <p className="tinyos-terminal-lifecycle" data-state={lifecycle.completion.status} role="status"><strong>{label} {lifecycle.completion.status}</strong><span>Canonical revision {lifecycle.completion.revision}</span></p>;
  return <p className="tinyos-terminal-lifecycle" data-state="failed" role="alert"><strong>{label} {lifecycle.stage.replace("_", " ")}</strong><span>{lifecycle.error}</span></p>;
}

function TinyOsTerminal({ activeTabId, canRequestChange, kernel, onAgentRequest, onAttachContext, onTabChange, requestChangeUnavailableReason, window }: { activeTabId?: string; canRequestChange: boolean; kernel?: TinyOsKernelSnapshot; onAgentRequest: (reference: TinyOsAgentRequestReference, intent: TinyOsAgentRequestIntent) => void; onAttachContext: (reference: TinyOsContextReference) => void; onTabChange: (tabId: string) => void; requestChangeUnavailableReason?: string; window: TinyOsWindow }) {
  const active = window.entries.find((entry) => entry.step.id === activeTabId) ?? window.entries[window.entries.length - 1];
  const [follow, setFollow] = useState(true);
  const [query, setQuery] = useState("");
  const [stream, setStream] = useState<"all" | "stdout" | "stderr">("all");
  const [selection, setSelection] = useState<{ anchor: number; end: number }>();
  const [activeMatch, setActiveMatch] = useState(0);
  const outputRef = useRef<HTMLDivElement>(null);
  const stdout = terminalOutput(active.step);
  const stderr = terminalStderr(active.step);
  const output = stream === "stdout" ? stdout : stream === "stderr" ? stderr : [stdout, stderr].filter(Boolean).join("\n");
  const rawOutputLines = output.split("\n");
  const outputTruncated = rawOutputLines.length > 499;
  const outputLines = [`$ ${terminalCommand(active.step)}`, ...rawOutputLines.slice(-499)];
  const matches = query ? outputLines.flatMap((line, index) => line.toLocaleLowerCase().includes(query.toLocaleLowerCase()) ? [index] : []) : [];
  const currentMatch = matches.length ? matches[Math.min(activeMatch, matches.length - 1)] : undefined;
  const execution = terminalExecutionView(active, kernel);
  const selectionStart = selection ? Math.min(selection.anchor, selection.end) : undefined;
  const selectionEnd = selection ? Math.max(selection.anchor, selection.end) : undefined;
  const selectedText = selectionStart !== undefined && selectionEnd !== undefined
    ? boundedSelectionText(outputLines.slice(selectionStart, selectionEnd + 1).join("\n"))
    : "";
  const selectedReference: TinyOsContextReference | undefined = selectionStart !== undefined && selectionEnd !== undefined ? {
    command: terminalCommand(active.step),
    endLine: selectionEnd + 1,
    executionId: active.step.id,
    kind: "terminal",
    ...(execution.processId ? { processId: execution.processId } : {}),
    provenance: { kind: "canonical", sourceItemId: active.step.id, turnId: active.turnId },
    selectedText,
    sourceItemId: active.step.id,
    startLine: selectionStart + 1,
    turnId: active.turnId,
  } : undefined;
  const metadata = terminalMetadata(active.step);

  useEffect(() => {
    if (!follow) return;
    const element = outputRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [active.step.id, follow, output]);
  useEffect(() => {
    setSelection(undefined);
    setActiveMatch(0);
  }, [active.step.id, stream]);
  useEffect(() => {
    if (currentMatch === undefined) return;
    outputRef.current?.querySelector<HTMLElement>(`li[data-line="${currentMatch}"]`)?.scrollIntoView({ block: "center" });
  }, [currentMatch]);

  function selectLine(line: number, extend: boolean) {
    setSelection((current) => extend && current ? { anchor: current.anchor, end: line } : { anchor: line, end: line });
  }

  function moveMatch(delta: number) {
    if (!matches.length) return;
    setActiveMatch((current) => (current + delta + matches.length) % matches.length);
  }

  return (
    <div className="tinyos-terminal">
      <div className="tinyos-terminal__tabs" role="tablist" aria-label="Canonical commands">
        {window.entries.slice(-6).map((entry) => <button aria-selected={entry === active} data-active={entry === active ? "true" : undefined} key={`${entry.turnId}:${entry.step.id}`} role="tab" title={terminalCommand(entry.step)} type="button" onClick={() => onTabChange(entry.step.id)}>{terminalCommand(entry.step)}</button>)}
        <TinyOsStatus status={active.step.status} />
      </div>
      <dl aria-label="Terminal execution identity" className="tinyos-terminal__identity" role="group">
        <div><dt>Contract</dt><dd>retained execution v1</dd></div>
        <div><dt>Run / item</dt><dd><code>{active.turnId} / {active.step.id}</code></dd></div>
        <div><dt>Process</dt><dd><code>{execution.processId || "Unavailable"}</code></dd></div>
        <div><dt>cwd</dt><dd><code>{metadata.cwd || "Unavailable"}</code></dd></div>
        <div><dt>Boundary</dt><dd>{execution.sandboxMode} · network {execution.networkMode} · non-TTY</dd></div>
        <div><dt>Output</dt><dd>{execution.stdoutBytes} B stdout · {execution.stderrBytes} B stderr{execution.droppedBytes ? ` · ${execution.droppedBytes} B dropped` : ""}</dd></div>
        <div><dt>Exit / timing</dt><dd>{metadata.exit} · {active.step.toolCall?.durationMs !== undefined ? `${active.step.toolCall.durationMs} ms` : "timing unavailable"}</dd></div>
        <div><dt>Provenance</dt><dd><ShieldCheck aria-hidden="true" size={11} />canonical_event · {active.step.id}</dd></div>
      </dl>
      <div className="tinyos-terminal__toolbar">
        <label><Search aria-hidden="true" size={12} /><input aria-label="Search terminal output" placeholder="Search output" value={query} onChange={(event) => { setQuery(event.currentTarget.value); setActiveMatch(0); }} /></label>
        <span aria-live="polite">{query ? `${matches.length ? Math.min(activeMatch, matches.length - 1) + 1 : 0}/${matches.length}` : ""}</span>
        <button aria-label="Previous terminal match" disabled={!matches.length} title="Previous match" type="button" onClick={() => moveMatch(-1)}><ChevronLeft aria-hidden="true" size={12} /></button>
        <button aria-label="Next terminal match" disabled={!matches.length} title="Next match" type="button" onClick={() => moveMatch(1)}><ChevronRight aria-hidden="true" size={12} /></button>
        <select aria-label="Terminal stream filter" value={stream} onChange={(event) => setStream(event.currentTarget.value as "all" | "stdout" | "stderr")}><option value="all">All streams</option><option value="stdout">stdout</option><option value="stderr">stderr</option></select>
        <button aria-label="Copy terminal command" title="Copy command" type="button" onClick={() => copyText(terminalCommand(active.step))}><Copy aria-hidden="true" size={12} />Command</button>
        <button aria-label={selection ? "Copy selected terminal output" : "Copy loaded terminal output"} title={selection ? "Copy selection" : "Copy loaded output"} type="button" onClick={() => copyText(selection ? selectedText : outputLines.join("\n"))}><Copy aria-hidden="true" size={12} />{selection ? "Selection" : "Output"}</button>
        <button aria-pressed={follow} title={follow ? "Pause output follow" : "Follow output"} type="button" onClick={() => setFollow((current) => !current)}>{follow ? <Pause aria-hidden="true" size={12} /> : <Play aria-hidden="true" size={12} />}{follow ? "Pause" : "Follow"}</button>
      </div>
      <div className="tinyos-terminal__output" data-follow={follow ? "true" : undefined} ref={outputRef}>
        <ol>{outputLines.map((line, index) => {
          const matches = Boolean(query && line.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
          const selected = selectionStart !== undefined && selectionEnd !== undefined && index >= selectionStart && index <= selectionEnd;
          return <li data-current-match={currentMatch === index ? "true" : undefined} data-line={index} data-match={matches ? "true" : undefined} data-selected={selected ? "true" : undefined} key={index}><button type="button" onClick={(event) => selectLine(index, event.shiftKey)}><code>{line || " "}</code></button></li>;
        })}</ol>
      </div>
      <footer><span>{metadata.cwd ? `cwd ${metadata.cwd}` : `Agent ${active.step.agentContext.title}`}</span><span>{metadata.exit}</span><span>{active.step.toolCall?.durationMs !== undefined ? `${active.step.toolCall.durationMs} ms` : statusLabel(active.step.status)}</span>{selectedReference ? <button draggable="true" title="Attach to Chat or drag this structured terminal reference" type="button" onClick={() => onAttachContext(selectedReference)} onDragStart={(event) => writeTinyOsReferenceTransfer(event.dataTransfer, { kind: "context", reference: selectedReference })}><Paperclip aria-hidden="true" size={11} />Attach L{selectedReference.startLine}{selectedReference.endLine === selectedReference.startLine ? "" : `–${selectedReference.endLine}`}</button> : <span>{follow ? "Following output" : "Follow paused"}</span>}{selectedReference ? <button disabled={!canRequestChange} title={canRequestChange ? "Ask Agent to explain this output" : requestChangeUnavailableReason} type="button" onClick={() => onAgentRequest(selectedReference, "explain")}><MessageCircleQuestion aria-hidden="true" size={11} />Explain</button> : null}{selectedReference ? <button disabled={!canRequestChange} title={canRequestChange ? "Continue with Agent using this output" : requestChangeUnavailableReason} type="button" onClick={() => onAgentRequest(selectedReference, "follow_up")}><Play aria-hidden="true" size={11} />Continue with Agent</button> : null}{outputTruncated || execution.truncated ? <span>Retained boundary · last 499 lines{execution.droppedBytes ? ` · ${execution.droppedBytes} B dropped` : ""}</span> : null}<span>{stream} · Canonical item {active.step.sequence + 1}</span></footer>
    </div>
  );
}

function TinyOsBrowser({ commandRegistry, kernel, window, onOpenArtifact }: {
  commandRegistry: TinyOsShellCommandRegistry;
  kernel?: TinyOsKernelSnapshot;
  onOpenArtifact: (artifact: ArtifactRef) => void;
  window: TinyOsWindow;
}) {
  const latest = window.entries[window.entries.length - 1];
  const session = kernel?.browserSessions[0];
  const [selectedTabId, setSelectedTabId] = useState(session?.activeTabId);
  const activeTabId = session?.tabs.some(({ tabId }) => tabId === selectedTabId) ? selectedTabId : session?.activeTabId;
  const tab = session?.tabs.find(({ tabId }) => tabId === activeTabId);
  const [selectedCaptureId, setSelectedCaptureId] = useState(tab?.currentCaptureId);
  const selectedCapture = tab?.captures.find(({ captureId }) => captureId === selectedCaptureId)
    ?? tab?.captures.find(({ captureId }) => captureId === tab.currentCaptureId);
  const target = session && tab && selectedCapture ? {
    browserSessionId: session.browserSessionId,
    captureId: selectedCapture.captureId,
    tabId: tab.tabId,
  } : undefined;
  const validation = target ? validateTinyOsBrowserInteractionTarget(session, target) : undefined;
  const currentCapture = validation?.status === "rejected" ? validation.currentCapture : selectedCapture;
  const artifacts = window.entries.flatMap(({ step }) => step.artifacts ?? []);
  const standaloneCapture = [...artifacts].reverse().find((artifact) => artifact.kind === "browser_snapshot");
  const captureArtifact = selectedCapture
    ? artifacts.find((artifact) => artifact.kind === "browser_snapshot" && artifact.id === selectedCapture.captureId)
    : standaloneCapture;
  const image = captureArtifact?.preview && safeRasterDataUrl(captureArtifact.preview) ? captureArtifact.preview : undefined;
  const truth = session ? (image ? "real_capture" : "native_session") : image ? "local_preview" : "structured_projection";
  const canonicalUrl = latest ? browserLocation(latest.step) : "";
  const [url, setUrl] = useState(tab?.url ?? canonicalUrl);
  const [typedText, setTypedText] = useState("");
  const [error, setError] = useState("");
  const navigateCommand = requiredShellCommand(commandRegistry, "browser.navigate");
  const clickCommand = requiredShellCommand(commandRegistry, "browser.click");
  const typeCommand = requiredShellCommand(commandRegistry, "browser.type");
  const historyIndex = tab?.activeHistoryIndex ?? -1;

  useEffect(() => {
    setSelectedTabId(session?.activeTabId);
  }, [session?.activeTabId, session?.browserSessionId, session?.revision]);
  useEffect(() => {
    setSelectedCaptureId(tab?.currentCaptureId);
    setUrl(tab?.url ?? canonicalUrl);
    setError("");
  }, [canonicalUrl, latest?.step.id, tab?.currentCaptureId, tab?.tabId, tab?.url]);

  async function executeBrowserCommand(commandId: "browser.click" | "browser.navigate" | "browser.type", values: Record<string, string>) {
    if (!target) {
      setError("A compatible native browser session, tab, and capture are required.");
      return;
    }
    setError("");
    try {
      const execution = await commandRegistry.execute(commandId, { ...target, ...values });
      if (execution.status === "rejected") setError(execution.reason);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  function navigateHistory(nextIndex: number) {
    const entry = tab?.history[nextIndex];
    if (!entry) return;
    void executeBrowserCommand("browser.navigate", { url: entry.url });
  }

  return (
    <div className="tinyos-browser" data-truth={truth}>
      {session ? <div aria-label="Native browser tabs" className="tinyos-browser__tabs" role="tablist">
        {session.tabs.map((candidate) => <button aria-selected={candidate.tabId === tab?.tabId} key={candidate.tabId} role="tab" type="button" onClick={() => setSelectedTabId(candidate.tabId)}>{candidate.loading ? <Circle aria-hidden="true" size={9} /> : null}{candidate.title}</button>)}
      </div> : null}
      <div className="tinyos-browser__bar">
        <button aria-label="Browser back" disabled={!tab || historyIndex <= 0 || !navigateCommand.availability.available || validation?.status !== "accepted"} title={navigateCommand.availability.available ? "Back" : navigateCommand.availability.reason} type="button" onClick={() => navigateHistory(historyIndex - 1)}><ChevronLeft aria-hidden="true" size={13} /></button>
        <button aria-label="Browser forward" disabled={!tab || historyIndex < 0 || historyIndex >= tab.history.length - 1 || !navigateCommand.availability.available || validation?.status !== "accepted"} title={navigateCommand.availability.available ? "Forward" : navigateCommand.availability.reason} type="button" onClick={() => navigateHistory(historyIndex + 1)}><ChevronRight aria-hidden="true" size={13} /></button>
        <Globe2 aria-hidden="true" size={13} />
        <form onSubmit={(event) => { event.preventDefault(); void executeBrowserCommand("browser.navigate", { url }); }}><input aria-label="Browser URL" disabled={!navigateCommand.availability.available || validation?.status !== "accepted"} value={url} onChange={(event) => setUrl(event.currentTarget.value)} /><button disabled={!url.trim() || !navigateCommand.availability.available || validation?.status !== "accepted"} type="submit">Go</button></form>
        <b>{truth === "real_capture" ? "Real capture" : truth === "native_session" ? "Native session · capture unavailable" : truth === "local_preview" ? "Local preview" : "Structured projection"}</b>
      </div>
      {session && tab ? <section aria-label="Browser session identity" className="tinyos-browser__identity">
        <span><strong>Session</strong><code>{session.browserSessionId}</code></span>
        <span><strong>Tab</strong><code>{tab.tabId}</code></span>
        <span><strong>Capture</strong><code>{selectedCapture?.captureId ?? "Unavailable"}</code></span>
        <span><strong>Observed</strong><time>{selectedCapture?.observedAt ?? session.observedAt}</time></span>
        <span><strong>Provenance</strong>{session.provenance.kind}</span>
        <span><strong>State</strong>{tab.loading ? "loading" : "ready"}</span>
      </section> : null}
      {tab?.captures.length ? <nav aria-label="Browser capture history" className="tinyos-browser__captures">
        {tab.captures.map((capture) => <button aria-current={capture.captureId === selectedCapture?.captureId ? "true" : undefined} data-stale={capture.stale ? "true" : undefined} key={capture.captureId} type="button" onClick={() => setSelectedCaptureId(capture.captureId)}><span>{capture.captureId}</span><small>{capture.stale ? "Stale evidence" : capture.captureId === tab.currentCaptureId ? "Current capture" : "Retained capture"}</small></button>)}
      </nav> : null}
      {validation?.status === "rejected" ? <div className="tinyos-browser__stale" role="alert"><AlertTriangle aria-hidden="true" size={14} /><span><strong>{validation.reasonCode === "capture_stale" ? "Stale capture" : "Capture unavailable"}</strong>{validation.reason}</span>{currentCapture ? <button type="button" onClick={() => setSelectedCaptureId(currentCapture.captureId)}>Show current capture</button> : null}</div> : null}
      {image ? <button aria-label={validation?.status === "accepted" && clickCommand.availability.available ? "Interact with current browser capture" : "Open browser capture artifact"} className="tinyos-browser__capture" type="button" onClick={(event) => {
        if (validation?.status !== "accepted" || !clickCommand.availability.available) {
          if (captureArtifact) onOpenArtifact(captureArtifact);
          return;
        }
        const bounds = event.currentTarget.getBoundingClientRect();
        void executeBrowserCommand("browser.click", {
          x: String(Math.max(0, Math.round(event.clientX - bounds.left))),
          y: String(Math.max(0, Math.round(event.clientY - bounds.top))),
        });
      }}><img alt={captureArtifact?.title || "Browser capture"} src={image} /></button> : <div className="tinyos-browser__page"><Globe2 aria-hidden="true" size={28} /><strong>{tab?.title ?? latest?.step.title ?? "Browser session"}</strong><p>{tab ? "The native session snapshot has no compatible raster capture to display." : latest?.step.summary || "No real browser session or capture is attached. This is a structured projection."}</p></div>}
      <form className="tinyos-browser__type" onSubmit={(event) => { event.preventDefault(); void executeBrowserCommand("browser.type", { text: typedText }); }}><input aria-label="Text for browser" disabled={!typeCommand.availability.available || validation?.status !== "accepted"} placeholder="Type into the focused browser target" value={typedText} onChange={(event) => setTypedText(event.currentTarget.value)} /><button disabled={!typedText.trim() || !typeCommand.availability.available || validation?.status !== "accepted"} title={typeCommand.availability.available ? "Type into current capture" : typeCommand.availability.reason} type="submit">Type</button></form>
      {!session ? <p className="tinyos-browser__readonly" role="status"><ShieldCheck aria-hidden="true" size={13} /><span><strong>Read-only projection</strong>{clickCommand.availability.available ? "A compatible native session snapshot is required." : clickCommand.availability.reason}</span></p> : null}
      {error ? <p className="tinyos-browser__error" role="alert">{error}</p> : null}
    </div>
  );
}

function TinyOsPlan({ canRequestChange, entry, onAgentRequest, requestChangeUnavailableReason }: { canRequestChange: boolean; entry: TinyOsTimelineEntry; onAgentRequest: (reference: TinyOsAgentRequestReference, intent: TinyOsAgentRequestIntent) => void; requestChangeUnavailableReason?: string }) {
  const plan = entry.step.plan;
  const [adjustment, setAdjustment] = useState("");
  if (!plan) return <EmptyCopy text="No plan snapshot is available." />;
  const snapshotText = JSON.stringify({ explanation: plan.explanation, steps: plan.steps });
  return (
    <div className="tinyos-plan">
      <header><h3>Execution plan</h3><span>{plan.completed}/{plan.total}</span></header>
      {plan.explanation ? <p>{plan.explanation}</p> : null}
      <ol>{plan.steps.map((item, index) => (
        <li data-status={item.status} key={`${index}:${item.step}`}>
          {item.status === "completed" ? <CheckCircle2 aria-hidden="true" size={15} /> : <Circle aria-hidden="true" size={13} />}
          <span>{item.step}</span><small>{item.status.replace(/_/g, " ")}</small>
        </li>
      ))}</ol>
      <form onSubmit={(event) => {
        event.preventDefault();
        const requestedAdjustment = adjustment.trim();
        if (!canRequestChange || !requestedAdjustment) return;
        onAgentRequest({ adjustment: requestedAdjustment, kind: "plan", snapshotText, sourceItemId: entry.step.id, turnId: entry.turnId }, "adjust_plan");
      }}>
        <input aria-label="Requested plan adjustment" disabled={!canRequestChange} maxLength={2_048} placeholder="Describe a plan adjustment" value={adjustment} onChange={(event) => setAdjustment(event.currentTarget.value)} />
        <button disabled={!canRequestChange || !adjustment.trim()} title={canRequestChange ? "Request a new live plan adjustment" : requestChangeUnavailableReason} type="submit"><PencilLine aria-hidden="true" size={11} />Ask Agent to adjust</button>
      </form>
    </div>
  );
}

function TinyOsMemory({ window }: { window: TinyOsWindow }) {
  const latest = window.entries[window.entries.length - 1];
  const args = recordValue(latest.step.toolCall?.argsJson);
  return (
    <div className="tinyos-memory">
      <div><Search aria-hidden="true" size={14} /><span>{firstString(args.query, args.q, args.text, latest.step.summary) || "Memory query"}</span></div>
      <pre>{jsonPreview(latest.step.toolCall?.resultJson ?? latest.step.toolCall?.resultPreview) || "No memory matches returned."}</pre>
    </div>
  );
}

function TinyOsSubagents({ window }: { window: TinyOsWindow }) {
  return (
    <div className="tinyos-subagents">
      {window.entries.slice(-8).map((entry) => (
        <article key={`${entry.turnId}:${entry.step.id}`}>
          <Bot aria-hidden="true" size={17} />
          <div><strong>{entry.step.delegate?.title || entry.step.title}</strong><span>{entry.step.delegate?.task || entry.step.summary || "Delegated task"}</span></div>
          <TinyOsStatus status={entry.step.status} />
        </article>
      ))}
    </div>
  );
}

function TinyOsArtifacts({ window, onOpenArtifact }: { window: TinyOsWindow; onOpenArtifact: (artifact: ArtifactRef) => void }) {
  const artifacts = window.entries.flatMap(({ step }) => step.artifacts ?? []);
  if (!artifacts.length) return <EmptyCopy text="No artifact preview is available." />;
  return (
    <div className="tinyos-artifacts">
      {artifacts.map((artifact) => (
        <button key={artifact.id} type="button" onClick={() => onOpenArtifact(artifact)}>
          <FileText aria-hidden="true" size={18} />
          <span><strong>{artifact.title}</strong><small>{artifact.kind}</small></span>
          <span>{artifact.preview || "Open artifact"}</span>
        </button>
      ))}
    </div>
  );
}

function TinyOsStructured({ entry }: { entry: TinyOsTimelineEntry }) {
  return (
    <div className="tinyos-structured">
      <strong>{entry.step.title}</strong>
      <p>{entry.step.summary || "Structured operation details"}</p>
      {entry.step.toolCall?.argsJson !== undefined ? <pre>{jsonPreview(entry.step.toolCall.argsJson)}</pre> : null}
      {entry.step.toolCall?.resultJson !== undefined ? <pre>{jsonPreview(entry.step.toolCall.resultJson)}</pre> : null}
    </div>
  );
}

function TinyOsNotifications({
  notifications,
  onSelect,
}: {
  notifications: TinyOsDesktopSnapshot["notifications"];
  onSelect: (notificationId: string) => void;
}) {
  if (!notifications.length) return null;
  return (
    <aside aria-label="TinyOS notifications" className="tinyos-notifications">
      {notifications.slice(-2).map((notification) => (
        <button data-kind={notification.kind} key={notification.id} type="button" onClick={() => onSelect(notification.id)}>
          {notification.kind === "completed" ? <CheckCircle2 aria-hidden="true" size={15} /> : <AlertTriangle aria-hidden="true" size={15} />}
          <span><strong>{notification.title}</strong><small>{notification.message}</small></span>
        </button>
      ))}
    </aside>
  );
}

function TinyOsSystemDialog({
  agentUiForms,
  dialog,
  onCancelForm,
  onResolveApproval,
  onSubmitForm,
  resolvingApprovalId,
  submittingFormId,
}: {
  agentUiForms: AgentUiForm[];
  dialog: NonNullable<TinyOsDesktopSnapshot["dialog"]>;
  onCancelForm: (form: AgentUiForm) => void;
  onResolveApproval: (approvalId: string, action: ApprovalAction) => void;
  onSubmitForm: (form: AgentUiForm, values: Record<string, unknown>) => void;
  resolvingApprovalId: string;
  submittingFormId?: string;
}) {
  const { step } = dialog.entry;
  if (dialog.kind === "form") {
    const form = agentUiForms.find((candidate) => candidate.form_id === step.form?.formId);
    return (
      <div aria-label="TinyOS input request" aria-modal="true" className="tinyos-system-dialog" role="dialog">
        <div className="tinyos-system-dialog__heading"><ShieldCheck aria-hidden="true" size={20} /><div><small>TinyOS input request</small><strong>{step.title}</strong></div></div>
        {form ? <AgentUiFormCard form={form} submitting={submittingFormId === form.form_id} onCancel={() => onCancelForm(form)} onSubmit={(values) => onSubmitForm(form, values)} /> : <EmptyCopy text="The form schema is still loading. The canonical request remains pending." />}
      </div>
    );
  }
  const approval = step.approval;
  const resolving = Boolean(approval?.approvalId && resolvingApprovalId === approval.approvalId);
  const request = approvalRequest(step);
  return (
    <div aria-label="TinyOS approval request" aria-modal="true" className="tinyos-system-dialog" role="dialog">
      <div className="tinyos-system-dialog__heading"><ShieldCheck aria-hidden="true" size={20} /><div><small>System permission</small><strong>Approval required</strong></div></div>
      <p>The Agent needs permission to continue with this operation.</p>
      <code className="tinyos-system-dialog__request">{request}</code>
      <dl><div><dt>Risk</dt><dd>{approval?.riskLevel || "Unspecified"}</dd></div><div><dt>Agent</dt><dd>{step.agentContext.title}</dd></div></dl>
      <div className="tinyos-system-dialog__actions">
        <button disabled={resolving || !approval} type="button" onClick={() => approval && onResolveApproval(approval.approvalId, "approveOnce")}>Approve once</button>
        <button disabled={resolving || !approval} type="button" onClick={() => approval && onResolveApproval(approval.approvalId, "approveSession")}>Approve for session</button>
        <button disabled={resolving || !approval} type="button" onClick={() => approval && onResolveApproval(approval.approvalId, "deny")}>Deny</button>
      </div>
    </div>
  );
}

function TinyOsInspector({ evidence, onClose, onOpenArtifact, onReferenceDrop }: { evidence: TinyOsPinnedEvidence[]; onClose: (pin: TinyOsPinnedEvidence) => void; onOpenArtifact: (artifact: ArtifactRef) => void; onReferenceDrop: (event: DragEvent<HTMLElement>) => void }) {
  return (
    <aside
      aria-label="TinyOS Inspector"
      className="tinyos-inspector"
      data-split={evidence.length > 1 ? "true" : undefined}
      onDragOver={(event) => {
        if (!Array.from(event.dataTransfer.types).includes(TINYOS_REFERENCE_MIME)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDrop={(event) => {
        event.preventDefault();
        onReferenceDrop(event);
      }}
    >
      {evidence.map((pin) => {
        const { entry } = pin;
        const artifacts = entry.step.artifacts ?? entry.step.delegate?.artifacts ?? [];
        return (
          <article key={pin.id}>
            <header><div><small>Canonical evidence · Event {pin.cursor.eventIndex + 1}</small><strong>{entry.step.title}</strong></div><button aria-label={`Close ${entry.step.title} evidence at event ${pin.cursor.eventIndex + 1}`} type="button" onClick={() => onClose(pin)}><X aria-hidden="true" size={15} /></button></header>
            <TinyOsStatus status={entry.step.status} />
            <dl className="tinyos-inspector__correlation">
              <div><dt>Boundary</dt><dd>Event {pin.cursor.eventIndex + 1} of {pin.cursor.eventCount}</dd></div>
              <div><dt>Observed</dt><dd>{pin.cursor.wallClockTime ?? "Unavailable"}</dd></div>
            </dl>
            {entry.step.summary ? <p>{entry.step.summary}</p> : null}
            {entry.step.toolCall ? <dl className="tinyos-inspector__correlation"><div><dt>Tool call</dt><dd>{entry.step.toolCall.id}</dd></div>{entry.step.toolCall.resultRef ? <div><dt>Result ref</dt><dd>{entry.step.toolCall.resultRef}</dd></div> : null}<div><dt>Turn</dt><dd>{entry.turnId}</dd></div><div><dt>Agent</dt><dd>{entry.step.agentContext.title}</dd></div></dl> : null}
            {entry.step.toolCall?.argsJson !== undefined ? <section><strong>Arguments</strong><pre>{sanitizedJsonPreview(entry.step.toolCall.argsJson)}</pre></section> : null}
            {entry.step.toolCall?.resultJson !== undefined ? <section><strong>Result</strong><pre>{sanitizedJsonPreview(entry.step.toolCall.resultJson)}</pre></section> : null}
            {entry.step.toolCall?.resultPreview ? <section><strong>Result preview</strong><pre>{entry.step.toolCall.resultPreview}</pre></section> : null}
            {entry.step.toolCall?.stderrPreview ? <section><strong>Stderr</strong><pre>{entry.step.toolCall.stderrPreview}</pre></section> : null}
            {pin.resources.length ? <section><strong>Resources at this boundary</strong>{pin.resources.map((resource) => <dl className="tinyos-inspector__resource" key={resource.id}><div><dt>Identity</dt><dd>{resource.id}</dd></div><div><dt>Revision</dt><dd>{resource.revision ?? resource.provenance.revision ?? "Unavailable"}</dd></div><div><dt>Provenance</dt><dd>{resource.provenance.kind} · {resource.provenance.sourceId}</dd></div></dl>)}</section> : null}
            {artifacts.length ? <section><strong>Artifacts</strong>{artifacts.map((artifact) => <button key={artifact.id} type="button" onClick={() => onOpenArtifact(artifact)}>{artifact.title}</button>)}</section> : null}
            <footer>Event {pin.cursor.eventIndex + 1} · Canonical timeline item {entry.step.sequence + 1} · Agent {entry.step.agentContext.title}</footer>
          </article>
        );
      })}
    </aside>
  );
}

function TinyOsOperationShelf({
  commandRegistry,
  operations,
}: {
  commandRegistry: TinyOsShellCommandRegistry;
  operations: TinyOsDesktopSnapshot["operations"];
}) {
  const operation = operations[operations.length - 1];
  const Icon = operation ? APP_ICONS[operation.appId] : undefined;
  const selectCommand = operation
    ? requiredShellCommand(commandRegistry, `history.select:${operation.entry.step.id}`)
    : undefined;
  const retryCommand = operation
    ? requiredShellCommand(commandRegistry, `operation.retry:${operation.entry.step.id}`)
    : undefined;
  return (
    <nav aria-label="TinyOS recent operations" className="tinyos-operation-shelf">
      {operation && Icon && selectCommand && retryCommand ? (
        <>
          <button
            className="tinyos-operation-shelf__select"
            data-status={operation.status}
            draggable="true"
            title="Open operation or drag its canonical evidence"
            type="button"
            onClick={() => void commandRegistry.execute(selectCommand.id)}
            onDragStart={(event) => writeTinyOsReferenceTransfer(event.dataTransfer, {
              itemId: operation.entry.step.id,
              kind: "evidence",
              title: operation.title,
              turnId: operation.entry.turnId,
            })}
          >
            <span className="tinyos-operation-shelf__state"><Icon aria-hidden="true" size={15} /></span>
            <span><small>Latest canonical operation</small><strong>{operation.title}</strong></span>
            <span><small>Status</small><strong>{statusLabel(operation.status)}</strong></span>
            <span><small>Agent</small><strong>{operation.entry.step.agentContext.title}</strong></span>
            <span><small>Source</small><strong>Canonical events</strong></span>
          </button>
          {operation.status === "failed" ? (
            <button
              className="tinyos-operation-shelf__retry"
              disabled={!retryCommand.availability.available}
              title={retryCommand.availability.available ? "Retry operation" : retryCommand.availability.reason}
              type="button"
              onClick={() => void commandRegistry.execute(retryCommand.id)}
            >
              <RotateCcw aria-hidden="true" size={14} />Retry
            </button>
          ) : null}
        </>
      ) : <span className="tinyos-operation-shelf__empty">Visualized from canonical events</span>}
    </nav>
  );
}

function TinyOsStatus({ status }: { status: ChatStepStatus }) {
  return <span className="tinyos-status" data-status={status}>{status === "completed" ? <Check aria-hidden="true" size={11} /> : <Circle aria-hidden="true" size={9} />}{statusLabel(status)}</span>;
}

function EmptyCopy({ text }: { text: string }) {
  return <p className="tinyos-empty-copy">{text}</p>;
}

function filePath(step: ChatStep): string {
  const args = recordValue(step.toolCall?.argsJson);
  return firstString(args.path, args.file, args.file_path, args.cwd, args.directory, step.toolCall?.argsPreview)
    || step.toolCall?.name
    || step.title
    || "Workspace";
}

function fileRevision(step: ChatStep): string {
  const args = recordValue(step.toolCall?.argsJson);
  return firstString(args.revision, args.baseRevision, args.base_revision, args.contentHash, args.content_hash);
}

function TinyOsHistoricalDialog({ dialog }: { dialog: NonNullable<TinyOsDesktopSnapshot["dialog"]> }) {
  const { step } = dialog.entry;
  return (
    <aside aria-label="Historical TinyOS request" className="tinyos-system-dialog tinyos-system-dialog--history">
      <div className="tinyos-system-dialog__heading"><ShieldCheck aria-hidden="true" size={20} /><div><small>Historical evidence · read-only</small><strong>{step.title}</strong></div></div>
      <p>This request is part of canonical History. Return to Live to act on the current request.</p>
      {dialog.kind === "approval" ? <code className="tinyos-system-dialog__request">{approvalRequest(step)}</code> : null}
      <dl>
        <div><dt>Type</dt><dd>{dialog.kind}</dd></div>
        <div><dt>Status</dt><dd>{statusLabel(step.status)}</dd></div>
        <div><dt>Agent</dt><dd>{step.agentContext.title}</dd></div>
      </dl>
    </aside>
  );
}

function isFileMutation(step: ChatStep): boolean {
  const name = step.toolCall?.name ?? "";
  return /(?:^|[._-])(write|save|edit|patch|apply|delete|remove|move|rename|create)(?:$|[._-])/i.test(name);
}

function boundedSelectionText(value: string): string {
  return value.length <= 16_384 ? value : `${value.slice(0, 16_384)}\n[selection truncated]`;
}

function fileContent(step: ChatStep): string {
  const result = recordValue(step.toolCall?.resultJson);
  return firstString(result.content, result.text, step.toolCall?.resultPreview);
}

function fileName(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || path;
}

function uniqueDirectories(paths: string[]): string[] {
  const values = new Set<string>();
  for (const path of paths) {
    const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
    if (parts.length > 1) values.add(parts.slice(0, -1).join("/"));
  }
  return [...values].slice(-4);
}

function distinctLatestFiles<T extends { path: string }>(files: T[]): T[] {
  const latestByPath = new Map<string, T>();
  files.forEach((file) => latestByPath.set(file.path, file));
  return [...latestByPath.values()];
}

function requiredShellCommand(
  registry: TinyOsShellCommandRegistry,
  id: TinyOsShellCommandId,
): TinyOsShellCommand {
  const command = registry.get(id);
  if (!command) throw new Error(`Required TinyOS shell command is not registered: ${id}`);
  return command;
}

function overlayLabel(overlay: TinyOsShellOverlay): string {
  switch (overlay) {
    case "notifications": return "notification center";
    case "overview": return "window Overview";
    case "palette": return "command palette";
    case "switcher": return "application switcher";
  }
}

function tinyOsAppForResourceKind(kind: TinyOsKernelSnapshot["resources"][number]["kind"]): TinyOsAppId | undefined {
  switch (kind) {
    case "file":
    case "directory": return "files";
    case "terminal_execution":
    case "terminal_session": return "terminal";
    case "browser_capture":
    case "browser_session": return "browser";
    case "artifact": return "artifacts";
    case "memory_result": return "memory";
    case "plan": return "plan";
    case "approval":
    case "form": return "inspector";
  }
}

function fileLanguage(path: string): string {
  const parts = fileName(path).split(".");
  const extension = parts[parts.length - 1]?.toLowerCase();
  return ({ css: "CSS", js: "JavaScript", json: "JSON", md: "Markdown", py: "Python", rs: "Rust", ts: "TypeScript", tsx: "TypeScript React" } as Record<string, string>)[extension || ""] || "Text";
}

function approvalRequest(step: ChatStep): string {
  const args = recordValue(step.toolCall?.argsJson);
  return firstString(args.cmd, args.command, args.script, step.toolCall?.argsPreview, step.summary, step.approval?.title, step.title)
    || "Permission request";
}

function terminalCommand(step: ChatStep): string {
  const args = recordValue(step.toolCall?.argsJson);
  return firstString(args.cmd, args.command, args.script, step.toolCall?.argsPreview) || step.title;
}

function terminalOutput(step: ChatStep): string {
  const result = recordValue(step.toolCall?.resultJson);
  return firstString(result.stdout, result.output, step.toolCall?.resultPreview)
    || (Object.keys(result).length ? jsonPreview(result) : "")
    || (step.status === "running" ? "Running..." : "No output returned.");
}

function terminalStderr(step: ChatStep): string {
  const result = recordValue(step.toolCall?.resultJson);
  return firstString(result.stderr, step.toolCall?.stderrPreview);
}

function terminalExecutionView(entry: TinyOsTimelineEntry, kernel?: TinyOsKernelSnapshot): {
  droppedBytes: number;
  networkMode: string;
  processId: string;
  sandboxMode: string;
  stderrBytes: number;
  stdoutBytes: number;
  truncated: boolean;
} {
  const args = recordValue(entry.step.toolCall?.argsJson);
  const result = recordValue(entry.step.toolCall?.resultJson);
  const stdout = firstString(result.stdout, entry.step.toolCall?.resultPreview);
  const stderr = firstString(result.stderr, entry.step.toolCall?.stderrPreview);
  const correlatedProcess = kernel?.processes.find((process) => (
    process.correlation.itemId === entry.step.id
    || process.correlation.toolCallId === entry.step.toolCall?.id
  ));
  const processId = firstString(result.processId, result.process_id, correlatedProcess?.correlation.nativeProcessId, correlatedProcess?.id);
  const droppedBytes = nonNegativeNumber(result.droppedBytes, result.dropped_bytes) ?? 0;
  return {
    droppedBytes,
    networkMode: firstString(result.networkMode, result.network_mode, args.networkMode, args.network_mode) || "unavailable",
    processId,
    sandboxMode: firstString(result.sandboxMode, result.sandbox_mode, args.sandboxMode, args.sandbox_mode) || "unavailable",
    stderrBytes: nonNegativeNumber(result.stderrBytes, result.stderr_bytes) ?? utf8ByteLength(stderr),
    stdoutBytes: nonNegativeNumber(result.stdoutBytes, result.stdout_bytes) ?? utf8ByteLength(stdout),
    truncated: result.truncated === true || droppedBytes > 0,
  };
}

function nonNegativeNumber(...values: unknown[]): number | undefined {
  const value = values.find((candidate): candidate is number => typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0);
  return value;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function terminalMetadata(step: ChatStep): { cwd: string; exit: string } {
  const args = recordValue(step.toolCall?.argsJson);
  const result = recordValue(step.toolCall?.resultJson);
  const cwd = firstString(args.cwd, args.directory, args.workdir, args.workingDirectory, args.working_directory);
  const exitCode = [result.exitCode, result.exit_code, result.code].find((value) => typeof value === "number" || typeof value === "string");
  return {
    cwd,
    exit: exitCode !== undefined ? `exit ${String(exitCode)}` : statusLabel(step.status),
  };
}

function copyText(value: string): void {
  void navigator.clipboard?.writeText(value).catch((error) => {
    console.error("TinyOS could not copy terminal content.", error);
  });
}

type BrowserInteractionCommandInput = {
  browserSessionId: string;
  captureId: string;
  tabId: string;
  text?: string;
  url?: string;
  x?: string;
  y?: string;
};

function browserInteractionCommandInput(input?: TinyOsShellCommandInput): BrowserInteractionCommandInput {
  if (!input || typeof input === "string") throw new Error("Browser interaction requires structured input.");
  return {
    browserSessionId: input.browserSessionId?.trim() || "",
    captureId: input.captureId?.trim() || "",
    tabId: input.tabId?.trim() || "",
    ...(input.text !== undefined ? { text: input.text } : {}),
    ...(input.url !== undefined ? { url: input.url.trim() } : {}),
    ...(input.x !== undefined ? { x: input.x } : {}),
    ...(input.y !== undefined ? { y: input.y } : {}),
  };
}

function browserActionFromCommandInput(
  kind: "click" | "navigate" | "type",
  input: BrowserInteractionCommandInput,
): TinyOsBrowserAction {
  if (kind === "navigate") return { type: "navigate", url: input.url?.trim() || "" };
  if (kind === "type") return { text: input.text || "", type: "type" };
  const x = Number(input.x);
  const y = Number(input.y);
  if (!Number.isFinite(x) || x < 0 || !Number.isFinite(y) || y < 0) {
    throw new Error("Browser click coordinates must be non-negative finite numbers.");
  }
  return { type: "click", x, y };
}

function browserLocation(step: ChatStep): string {
  const args = recordValue(step.toolCall?.argsJson);
  return firstString(args.url, args.href, args.location, step.summary) || "Structured browser activity";
}

function statusLabel(status: ChatStepStatus): string {
  return status.replace(/_/g, " ");
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function firstString(...values: unknown[]): string {
  return values.find((value): value is string => {
    if (typeof value !== "string" || !value.trim()) return false;
    return !["null", "undefined", "{}", "[]"].includes(value.trim().toLowerCase());
  }) ?? "";
}

function jsonPreview(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function sanitizedJsonPreview(value: unknown): string {
  const redact = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(redact);
    if (!input || typeof input !== "object") return input;
    return Object.fromEntries(Object.entries(input as Record<string, unknown>).map(([key, item]) => [
      key,
      /(?:^|_)(?:authorization|cookie|password|secret|token|api_?key)(?:$|_)/i.test(key) ? "[redacted]" : redact(item),
    ]));
  };
  return jsonPreview(redact(value));
}

function safeRasterDataUrl(value: string): boolean {
  return /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i.test(value);
}
