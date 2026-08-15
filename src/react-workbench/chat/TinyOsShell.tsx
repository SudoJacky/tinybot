import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { gsap } from "gsap";
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
import type { ArtifactRef, ChatStep, ChatStepStatus } from "../../app-core/chat/chatTurnContracts";
import type { TinyOsBrowserAction, TinyOsCommandLifecycle } from "../../app-core/chat/tinyOsCommand";
import { validateTinyOsBrowserInteractionTarget } from "../../app-core/chat/tinyOsBrowserSession";
import { createTinyOsShellCommandRegistry, defineTinyOsShellCommand, type TinyOsShellCommand, type TinyOsShellCommandId, type TinyOsShellCommandInput, type TinyOsShellCommandRegistry } from "../../app-core/chat/tinyOsShellCommandRegistry";
import { readTinyOsReferenceTransfer, tinyOsReferenceAcceptedBy, TINYOS_REFERENCE_MIME, writeTinyOsReferenceTransfer } from "../../app-core/chat/tinyOsReferenceTransfer";
import type { TinyOsAgentProcessGroup, TinyOsKernelSnapshot, TinyOsProcess, TinyOsResource, TinyOsSimulationCursor } from "../../app-core/chat/tinyOsKernelModel";
import { resourceValue, tinyOsWorkspaceResourceId } from "../../app-core/chat/tinyOsFilesModel";
import type {
  TinyOsAppId,
  TinyOsDesktopSnapshot,
  TinyOsTimelineEntry,
  TinyOsWindow,
} from "../../app-core/chat/tinyOsDesktopModel";
import { filterTinyOsDesktopByAgent } from "../../app-core/chat/tinyOsDesktopModel";
import {
  createTinyOsUiState,
  loadTinyOsLayout,
  normalizeWindowLayout,
  reduceTinyOsUiState,
  saveTinyOsLayout,
  type TinyOsAgentRequestIntent,
  type TinyOsAgentRequestReference,
  type TinyOsDesktopBounds,
  type TinyOsLayoutMode,
  type TinyOsContextReference,
  type TinyOsWindowRect,
} from "../../app-core/chat/tinyOsUiState";
import { AgentUiFormCard } from "./AgentUiFormCard";
import { TinyOsBrowserApp, type TinyOsBrowserHandoff } from "./TinyOsBrowserApp";
import { TinyOsFilesExplorer } from "./TinyOsFilesExplorer";
import { TinyOsSideRays } from "./TinyOsSideRays";
import { TinyOsSystemMonitor, type TinyOsSystemMonitorControls } from "./TinyOsSystemMonitor";
import type { TinyOsFilesController } from "./useTinyOsFilesController";
import type { NativeBrowserRuntimeApi } from "../../app-core/native/desktopNativeBrowser";

const TinyOsGlassSurface = lazy(() => import("./TinyOsGlassSurface"));

const APP_ICONS = {
  artifacts: Archive,
  browser: Globe2,
  files: Folder,
  inspector: Info,
  plan: ListChecks,
  subagents: Bot,
  system_monitor: Activity,
  terminal: TerminalSquare,
} satisfies Record<TinyOsAppId, typeof Folder>;

const APP_ORDER: TinyOsAppId[] = ["files", "terminal", "browser", "plan", "subagents", "artifacts", "inspector"];
const EMPTY_AGENT_GROUPS: TinyOsAgentProcessGroup[] = [];
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
  canRetryTurn,
  canSaveFile = false,
  filesController,
  history = false,
  commandLifecycle,
  onCancelForm,
  onAttachContext,
  onOpenArtifact,
  onAgentRequest,
  onCancelTerminal = async () => undefined,
  onBrowserHandoffComplete = () => undefined,
  onBrowserInteract = async () => undefined,
  onDeleteFile = async () => undefined,
  onExecuteTerminal = async () => undefined,
  onMoveFile = async () => undefined,
  onRetryOperation,
  onSelectEntry,
  onSubmitForm,
  onSaveFile = async () => undefined,
  requestChangeUnavailableReason,
  directEditUnavailableReason,
  retryTurnId,
  retryUnavailableReason,
  runtimeCommandRegistry,
  saveFileUnavailableReason,
  terminalCancelUnavailableReason,
  terminalExecuteUnavailableReason,
  browserInteractUnavailableReason,
  browserRuntime,
  runningTerminalOperationId,
  sessionKey,
  submittingFormId,
  snapshot: sourceSnapshot,
  layoutMode,
  workspaceKey,
}: {
  agentUiForms: AgentUiForm[];
  canCancelTerminal?: boolean;
  canDirectEdit?: boolean;
  canExecuteTerminal?: boolean;
  canInteractBrowser?: boolean;
  canRequestChange: boolean;
  canRetryTurn: boolean;
  canSaveFile?: boolean;
  filesController?: TinyOsFilesController;
  history?: boolean;
  commandLifecycle: TinyOsCommandLifecycle;
  onCancelForm: (form: AgentUiForm) => void;
  onAttachContext: (reference: TinyOsContextReference) => void;
  onOpenArtifact: (artifact: ArtifactRef) => void;
  onAgentRequest: (reference: TinyOsAgentRequestReference, intent: TinyOsAgentRequestIntent) => void;
  onCancelTerminal?: () => Promise<void>;
  onBrowserHandoffComplete?: (input: TinyOsBrowserHandoff) => void;
  onBrowserInteract?: (input: { action: TinyOsBrowserAction; browserSessionId: string; captureId: string; controlEpoch: number; observationRevision: number; tabId: string }) => Promise<void>;
  onDeleteFile?: (input: TinyOsFileDeleteInput) => Promise<void>;
  onExecuteTerminal?: (input: TinyOsTerminalExecuteInput) => Promise<void>;
  onMoveFile?: (input: TinyOsFileMoveInput) => Promise<void>;
  onRetryOperation: (entry: TinyOsTimelineEntry) => void;
  onSelectEntry: (entry: TinyOsTimelineEntry) => void;
  onSubmitForm: (form: AgentUiForm, values: Record<string, unknown>) => void;
  onSaveFile?: (input: TinyOsFileSaveInput) => Promise<void>;
  requestChangeUnavailableReason?: string;
  directEditUnavailableReason?: string;
  retryTurnId?: string;
  retryUnavailableReason?: string;
  runtimeCommandRegistry: TinyOsShellCommandRegistry;
  saveFileUnavailableReason?: string;
  terminalCancelUnavailableReason?: string;
  terminalExecuteUnavailableReason?: string;
  browserInteractUnavailableReason?: string;
  browserRuntime?: NativeBrowserRuntimeApi;
  runningTerminalOperationId?: string;
  sessionKey?: string;
  submittingFormId?: string;
  snapshot: TinyOsDesktopSnapshot;
  layoutMode: TinyOsLayoutMode;
  workspaceKey: string;
}) {
  const { t } = useTranslation("tinyos");
  const desktopRef = useRef<HTMLElement>(null);
  const launcherRef = useRef<HTMLElement>(null);
  const overlayReturnFocusRef = useRef<HTMLElement | null>(null);
  const [overlay, setOverlay] = useState<TinyOsShellOverlay | null>(null);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [readNotificationIds, setReadNotificationIds] = useState<Set<string>>(() => new Set());
  const [switcherAppId, setSwitcherAppId] = useState<TinyOsAppId | undefined>(undefined);
  const [transferMessage, setTransferMessage] = useState<{ kind: "error" | "success"; text: string }>();
  const [contextMenu, setContextMenu] = useState<TinyOsContextMenuState>();
  const [pinnedEvidence, setPinnedEvidence] = useState<TinyOsPinnedEvidence[]>([]);
  const [agentFilterId, setAgentFilterId] = useState("");
  const agentGroups = sourceSnapshot.kernel?.agentGroups ?? EMPTY_AGENT_GROUPS;
  const snapshot = useMemo(
    () => filterTinyOsDesktopByAgent(sourceSnapshot, agentFilterId),
    [agentFilterId, sourceSnapshot],
  );
  useEffect(() => {
    if (agentFilterId && !agentGroups.some(({ agentId }) => agentId === agentFilterId)) {
      setAgentFilterId("");
    }
  }, [agentFilterId, agentGroups]);
  const appWindows = useMemo(() => {
    const windows = snapshot.windows.filter(({ appId }) => appId !== "system_monitor");
    const hasScopedFile = !agentFilterId || snapshot.kernel?.resources.some(({ kind }) => kind === "file" || kind === "directory");
    const hasScopedTerminal = !agentFilterId
      || snapshot.kernel?.processes.some(({ applicationId }) => applicationId === "terminal")
      || snapshot.kernel?.resources.some(({ kind }) => kind === "terminal_execution" || kind === "terminal_session");
    if (filesController && hasScopedFile && !windows.some(({ appId }) => appId === "files")) {
      windows.unshift({ appId: "files", entries: [], id: "tinyos-window-files", sourceItemIds: [], title: appLabel("files", t) });
    }
    if (sessionKey && hasScopedTerminal && !windows.some(({ appId }) => appId === "terminal")) {
      windows.push({ appId: "terminal", entries: [], id: "tinyos-window-terminal", sourceItemIds: [], title: appLabel("terminal", t) });
    }
    if (snapshot.kernel?.browserSessions.length && !windows.some(({ appId }) => appId === "browser")) {
      windows.push({ appId: "browser", entries: [], id: "tinyos-window-browser", sourceItemIds: [], title: appLabel("browser", t) });
    }
    return windows;
  }, [agentFilterId, filesController, sessionKey, snapshot.kernel, snapshot.windows, t]);
  const initialWindowIds = useRef(new Set(appWindows.map((window) => window.id)));
  const initialAppIds = appWindows.map((window) => window.appId);
  const browserSessionAvailable = Boolean(snapshot.kernel?.browserSessions.length);
  const browserNeedsUser = snapshot.kernel?.browserSessions.some(
    (session) => session.control?.state === "user_required",
  ) ?? false;
  const browserSessionWasAvailable = useRef(browserSessionAvailable);
  const browserNeededUser = useRef(false);
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
  useLayoutEffect(() => {
    const launcher = launcherRef.current;
    const lens = launcher?.querySelector<HTMLElement>(".tinyos-launcher__lens");
    if (!launcher || !lens) return;

    let currentItem: HTMLElement | null = null;
    let resting = false;

    const activeItem = () => launcher.querySelector<HTMLElement>(".tinyos-launcher__app[data-active=\"true\"]");
    const clearLensTarget = () => {
      currentItem?.removeAttribute("data-lens-target");
    };
    const publishLensTarget = (item: HTMLElement | null) => {
      const lensBounds = lens.getBoundingClientRect();
      const itemBounds = item?.getBoundingClientRect();
      const visible = Boolean(itemBounds && lensBounds.width > 0);
      const x = visible && itemBounds
        ? (itemBounds.left + itemBounds.width / 2 - lensBounds.left) / lensBounds.width
        : .5;
      lens.dispatchEvent(new CustomEvent("tinyos:glass-target", { detail: { visible, x } }));
    };
    const positionLens = (item: HTMLElement, nextResting: boolean) => {
      if (item === currentItem && resting === nextResting) return;
      const lensBounds = lens.getBoundingClientRect();
      const itemBounds = item.getBoundingClientRect();
      if (lensBounds.width < 1 || itemBounds.width < 1) return;
      clearLensTarget();
      currentItem = item;
      resting = nextResting;
      item.setAttribute("data-lens-target", "true");
      launcher.setAttribute("data-lens-visible", "true");
      publishLensTarget(item);
    };
    const settleLens = () => {
      const active = activeItem();
      if (active) {
        positionLens(active, true);
        return;
      }
      clearLensTarget();
      currentItem = null;
      resting = false;
      launcher.removeAttribute("data-lens-visible");
      publishLensTarget(null);
    };
    const handlePointerMove = (event: globalThis.PointerEvent) => {
      const target = event.target instanceof Element
        ? event.target.closest<HTMLElement>(".tinyos-launcher__app")
        : null;
      if (target && launcher.contains(target)) {
        positionLens(target, false);
      }
    };
    const handleFocusIn = (event: globalThis.FocusEvent) => {
      const target = event.target instanceof Element
        ? event.target.closest<HTMLElement>(".tinyos-launcher__app")
        : null;
      if (target && launcher.contains(target)) positionLens(target, false);
    };
    const handleFocusOut = (event: globalThis.FocusEvent) => {
      if (event.relatedTarget instanceof Node && launcher.contains(event.relatedTarget)) return;
      settleLens();
    };
    const resizeObserver = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => {
      if (currentItem) {
        const item = currentItem;
        currentItem = null;
        positionLens(item, resting);
      }
    });

    launcher.addEventListener("pointermove", handlePointerMove);
    launcher.addEventListener("pointerleave", settleLens);
    launcher.addEventListener("focusin", handleFocusIn);
    launcher.addEventListener("focusout", handleFocusOut);
    resizeObserver?.observe(launcher);
    settleLens();
    return () => {
      launcher.removeEventListener("pointermove", handlePointerMove);
      launcher.removeEventListener("pointerleave", settleLens);
      launcher.removeEventListener("focusin", handleFocusIn);
      launcher.removeEventListener("focusout", handleFocusOut);
      resizeObserver?.disconnect();
      clearLensTarget();
      launcher.removeAttribute("data-lens-visible");
    };
  }, [appWindows.length, uiState.focusedAppId]);

  useEffect(() => {
    const returningToLive = previousHistoryMode.current && !history;
    const browserBecameAvailable = !browserSessionWasAvailable.current && browserSessionAvailable;
    const browserBeganNeedingUser = !browserNeededUser.current && browserNeedsUser;
    previousHistoryMode.current = history;
    browserSessionWasAvailable.current = browserSessionAvailable;
    browserNeededUser.current = browserNeedsUser;
    dispatchUi({
      appIds: appWindows.map((window) => window.appId),
      bounds: uiState.bounds,
      layoutMode,
      preferredActiveAppId: browserBecameAvailable || browserBeganNeedingUser
        ? "browser"
        : history || returningToLive ? snapshot.activeAppId : uiState.focusedAppId,
      type: "sync",
    });
  }, [appWindows.length, browserNeedsUser, browserSessionAvailable, history, layoutMode, snapshot.activeAppId, snapshot.cursorItemId, snapshot.cursorTurnId]);

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
  const scopedResourcePaths = new Set(snapshot.kernel?.resources.flatMap(({ path }) => path ? [path] : []) ?? []);
  const workspaceDocuments = filesController
    ? Object.entries(filesController.state.documents).flatMap(([path, resource]) => {
        if (agentFilterId && !scopedResourcePaths.has(path)) return [];
        const document = resourceValue(resource);
        return document ? [{ document, path }] : [];
      })
    : [];
  const shellOverlayAvailability = snapshot.dialog
    ? { available: false as const, reason: t("shell.availability.finishOverlay") }
    : { available: true as const };
  const retryAvailability = history
    ? { available: false as const, reason: t("shell.availability.historyReadOnly"), reasonCode: "history_read_only" }
    : canRetryTurn
      ? { available: true as const }
      : { available: false as const, reason: retryUnavailableReason || t("shell.availability.retryUnavailable") };
  const terminalExecuteAvailability = history
    ? { available: false as const, reason: t("shell.availability.historyHostActions"), reasonCode: "history_read_only" }
    : canExecuteTerminal
      ? { available: true as const }
      : { available: false as const, reason: terminalExecuteUnavailableReason || t("shell.availability.terminalUnavailable") };
  const terminalCancelAvailability = history
    ? { available: false as const, reason: t("shell.availability.historyHostActions"), reasonCode: "history_read_only" }
    : canCancelTerminal && runningTerminalOperationId
      ? { available: true as const }
      : { available: false as const, reason: terminalCancelUnavailableReason || t("shell.availability.noTerminal") };
  const browserSession = snapshot.kernel?.browserSessions[0];
  const browserCommandAvailability = (kind: "click" | "navigate" | "type") => history
    ? { available: false as const, reason: t("shell.availability.historyHostActions"), reasonCode: "history_read_only" }
    : !canInteractBrowser
      ? { available: false as const, reason: browserInteractUnavailableReason || t("shell.availability.browserUnavailable") }
      : !browserSession
        ? { available: false as const, reason: t("shell.availability.noBrowserSession") }
        : browserSession.interaction[kind]
          ? { available: true as const }
          : { available: false as const, reason: t("shell.availability.browserKind", { kind }) };
  const shellCommandRegistry = createTinyOsShellCommandRegistry([
    ...runtimeCommandRegistry.commands,
    defineTinyOsShellCommand({
      availability: terminalExecuteAvailability,
      category: "process",
      dispatch: (_target, input) => {
        if (!input || typeof input === "string") throw new Error(t("shell.command.terminalInput"));
        return onExecuteTerminal({
          command: input.command,
          ...(input.cwd?.trim() ? { cwd: input.cwd.trim() } : {}),
        });
      },
      id: "terminal.execute",
      input: {
        fields: [
          { label: t("shell.command.command"), name: "command", required: true },
          { label: t("shell.command.workingDirectory"), name: "cwd", required: false },
        ],
        kind: "fields",
      },
      keywords: ["terminal", "run", "command", "shell"],
      label: t("shell.command.runTerminal"),
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
      label: t("shell.command.cancelTerminal"),
      scope: "runtime",
      target: { kind: "process", processId: runningTerminalOperationId ?? "no-active-terminal" },
    }),
    ...(["navigate", "click", "type"] as const).map((kind) => defineTinyOsShellCommand({
      availability: browserCommandAvailability(kind),
      category: "resource",
      dispatch: (_target, input) => {
        const commandInput = browserInteractionCommandInput(input, t);
        const session = snapshot.kernel?.browserSessions.find(({ browserSessionId }) => (
          browserSessionId === commandInput.browserSessionId
        ));
        const validation = validateTinyOsBrowserInteractionTarget(session, commandInput);
        if (validation.status === "rejected") throw new Error(validation.reason);
        if (!session) throw new Error(t("shell.command.browserSessionUnavailable"));
        return onBrowserInteract({
          action: browserActionFromCommandInput(kind, commandInput, t),
          browserSessionId: commandInput.browserSessionId,
          captureId: commandInput.captureId,
          controlEpoch: session.control?.controlEpoch ?? 0,
          observationRevision: session.tabs.find(({ tabId }) => tabId === commandInput.tabId)?.observationRevision ?? 0,
          tabId: commandInput.tabId,
        });
      },
      id: `browser.${kind}` as const,
      input: {
        fields: [
          { label: t("shell.command.browserSessionId"), name: "browserSessionId", required: true },
          { label: t("shell.command.browserTabId"), name: "tabId", required: true },
          { label: t("shell.command.browserCaptureId"), name: "captureId", required: true },
          ...(kind === "navigate" ? [{ label: t("shell.command.url"), name: "url", required: true }] : []),
          ...(kind === "type" ? [{ label: t("shell.command.text"), name: "text", required: true }] : []),
          ...(kind === "click" ? [
            { label: t("shell.command.x"), name: "x", required: true },
            { label: t("shell.command.y"), name: "y", required: true },
          ] : []),
        ],
        kind: "fields",
      },
      keywords: ["browser", kind, "capture", "session"],
      label: t("shell.command.browserAction", { action: t(`shell.command.${kind}`) }),
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
      label: t("shell.command.resetLayout"),
      scope: "local_presentation",
      target: { kind: "shell" },
    }),
    defineTinyOsShellCommand({
      availability: appWindows.length && shellOverlayAvailability.available
        ? { available: true }
        : !shellOverlayAvailability.available
          ? shellOverlayAvailability
        : { available: false, reason: t("shell.availability.noApps") },
      category: "system",
      dispatch: () => openShellOverlay("overview"),
      id: "shell.overview",
      input: { kind: "none" },
      keywords: ["overview", "windows", "applications"],
      label: t("shell.command.openOverview"),
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
      input: { kind: "text", label: t("shell.command.searchCommands"), required: false },
      keywords: ["command", "palette", "search"],
      label: t("shell.command.openPalette"),
      scope: "local_presentation",
      target: { kind: "shell" },
    }),
    defineTinyOsShellCommand({
      availability: snapshot.notifications.length && shellOverlayAvailability.available
        ? { available: true }
        : !shellOverlayAvailability.available
          ? shellOverlayAvailability
          : { available: false, reason: t("shell.availability.noNotifications") },
      category: "system",
      dispatch: () => openShellOverlay("notifications"),
      id: "shell.notification_center",
      input: { kind: "none" },
      keywords: ["notifications", "history", "alerts"],
      label: t("shell.command.openNotifications"),
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
        label: t("shell.command.openApp", { title: window.title }),
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
        label: t("shell.command.focus", { title: window.title }),
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
        label: t("shell.command.maximize", { title: window.title }),
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
        label: t("shell.command.minimize", { title: window.title }),
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
        label: t("shell.command.inspect", { title: entry.step.title }),
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
        label: t("shell.command.show", { title: entry.step.title }),
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
      label: t("shell.command.retry", { title: entry.step.title }),
      scope: "runtime",
      target: { itemId: entry.step.id, kind: "operation", turnId: entry.turnId },
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
        label: t("shell.command.openNotification", { title: notification.title }),
        scope: "local_presentation",
        target: { itemId: notification.entry.step.id, kind: "evidence", turnId: notification.entry.turnId },
      }),
      defineTinyOsShellCommand({
        availability: readNotificationIds.has(notification.id)
          ? { available: false, reason: t("shell.availability.alreadyRead") }
          : { available: true },
        category: "operation",
        dispatch: () => setReadNotificationIds((current) => new Set(current).add(notification.id)),
        id: `notification.read:${notification.id}` as const,
        input: { kind: "none" },
        keywords: [notification.title, "read", "notification"],
        label: t("shell.command.markRead", { title: notification.title }),
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
          : { available: false, reason: t("shell.availability.noResourceApp") },
        category: "resource",
        dispatch: () => {
          if (appId) focusApp(appId);
        },
        id: `resource.reveal:${resource.id}` as const,
        input: { kind: "none" },
        keywords: [resource.title, resource.path || "", resource.kind, resource.provenance.kind, "resource"],
        label: t("shell.command.reveal", { title: resource.title }),
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
          label: t("shell.command.openInFiles", { path }),
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
          label: t("shell.command.attachToChat", { path }),
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
          availability: revealable ? { available: true } : { available: false, reason: t("shell.availability.noRelatedApp") },
          category: "process",
          dispatch: () => {
            if (process.applicationId) focusApp(process.applicationId as TinyOsAppId);
          },
          id: `process.reveal:${process.id}` as const,
          input: { kind: "none" },
          keywords: [process.title, "reveal", "application"],
          label: t("shell.command.reveal", { title: process.title }),
          scope: "local_presentation",
          target: { kind: "process", processId: process.id },
        }),
        defineTinyOsShellCommand({
          availability: inspectable ? { available: true } : { available: false, reason: t("shell.availability.noEvidence") },
          category: "process",
          dispatch: () => {
            const entry = distinctEntries.find((candidate) => candidate.step.id === process.correlation.itemId);
            if (entry) pinEvidence(entry);
          },
          id: `process.inspect:${process.id}` as const,
          input: { kind: "none" },
          keywords: [process.title, "inspect", "evidence"],
          label: t("shell.command.inspect", { title: process.title }),
          scope: "local_presentation",
          target: { kind: "process", processId: process.id },
        }),
      ];
    }) ?? []),
  ], { simulationMode: history ? "history" : "live" });
  const pauseCommand = requiredShellCommand(shellCommandRegistry, "agent.pause");
  const resumeCommand = requiredShellCommand(shellCommandRegistry, "agent.resume");
  const cancelCommand = requiredShellCommand(shellCommandRegistry, "agent.cancel");
  const activeTurnId = pauseCommand.target.kind === "turn" ? pauseCommand.target.turnId : undefined;
  const systemMonitorControls: TinyOsSystemMonitorControls = {
    activeTurnId,
    canCancelTurn: cancelCommand.availability.available,
    canPauseTurn: pauseCommand.availability.available,
    canResumeTurn: resumeCommand.availability.available,
    canRetryTurn,
    cancelUnavailableReason: cancelCommand.availability.available ? undefined : cancelCommand.availability.reason,
    commandLifecycle,
    history,
    inspectableItemIds: allEntries.map((entry) => entry.step.id),
    onCancelTurn: () => void shellCommandRegistry.execute(cancelCommand.id),
    onInspect: (process) => {
      void shellCommandRegistry.execute(`process.inspect:${process.id}`);
    },
    onOpenProcessMenu: (process, clientX, clientY) => openContextMenuAt(clientX, clientY, t("shell.contextMenu.process", { title: process.title }), [
      `process.reveal:${process.id}`,
      `process.inspect:${process.id}`,
      ...(process.correlation.itemId ? [`operation.retry:${process.correlation.itemId}` as const] : []),
    ]),
    onOpenResourceMenu: (resource, clientX, clientY) => openContextMenuAt(clientX, clientY, t("shell.contextMenu.resource", { title: resource.title }), [
      `resource.reveal:${resource.id}`,
    ]),
    onPauseTurn: () => void shellCommandRegistry.execute(pauseCommand.id),
    onResumeTurn: () => void shellCommandRegistry.execute(resumeCommand.id),
    onRetry: (process) => {
      if (process.correlation.itemId) void shellCommandRegistry.execute(`operation.retry:${process.correlation.itemId}`);
    },
    onReveal: (process) => {
      void shellCommandRegistry.execute(`process.reveal:${process.id}`);
    },
    pauseUnavailableReason: pauseCommand.availability.available ? undefined : pauseCommand.availability.reason,
    resumeUnavailableReason: resumeCommand.availability.available ? undefined : resumeCommand.availability.reason,
    retryTurnId,
    retryUnavailableReason,
    revealableApplicationIds: [...availableApps],
  };
  function pinEvidence(entry: TinyOsTimelineEntry) {
    const cursor = snapshot.kernel?.cursor ?? {
      boundary: {
        itemId: entry.step.id,
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
        aria-label={t("shell.desktop")}
        className="tinyos-desktop"
        data-app-count={availableApps.size}
        data-has-windows={windows.length ? "true" : undefined}
        data-layout-mode={uiState.layoutMode}
        ref={desktopRef}
        onContextMenu={(event) => openContextMenu(event, t("shell.contextMenu.desktop"), ["shell.overview", "shell.palette", "shell.reset_layout"])}
      >
        <TinyOsSideRays />
        <div aria-hidden="true" className="tinyos-desktop__environment">
          <span className="tinyos-desktop__brand"><MonitorDot size={17} /><strong>TinyOS</strong><small>{t("shell.sharedWorkspace")}</small></span>
          <span className="tinyos-desktop__mode">{history ? t("shell.historySnapshot") : t("shell.liveWorkspace")}</span>
        </div>
        <div aria-label={t("shell.systemTools")} className="tinyos-desktop__system-tools" role="toolbar">
          {agentGroups.length ? (
            <select
              aria-label={t("shell.filterAgent")}
              className="tinyos-agent-filter"
              title={t("shell.filterAgentHelp")}
              value={agentFilterId}
              onChange={(event) => setAgentFilterId(event.currentTarget.value)}
            >
              <option value="">{t("shell.allAgents")}</option>
              {agentGroups.map((group) => <option key={group.id} value={group.agentId}>{group.title}</option>)}
            </select>
          ) : null}
          <button aria-label={t("shell.command.openOverview")} title={t("shell.overview")} type="button" onClick={() => void shellCommandRegistry.execute("shell.overview")}><LayoutGrid aria-hidden="true" size={15} /></button>
          <button aria-label={t("shell.command.openPalette")} title={t("shell.paletteShortcut")} type="button" onClick={() => void shellCommandRegistry.execute("shell.palette")}><Command aria-hidden="true" size={15} /></button>
          <button
            aria-label={t("shell.command.openNotifications")}
            data-attention={snapshot.notifications.some((notification) => !readNotificationIds.has(notification.id)) ? "true" : undefined}
            disabled={!requiredShellCommand(shellCommandRegistry, "shell.notification_center").availability.available}
            title={snapshot.notifications.length ? t("shell.notificationCenter") : t("shell.noNotifications")}
            type="button"
            onClick={() => void shellCommandRegistry.execute("shell.notification_center")}
          ><Bell aria-hidden="true" size={15} /></button>
        </div>

        <nav aria-label={t("shell.applications")} className="tinyos-launcher" ref={launcherRef}>
          <span aria-hidden="true" className="tinyos-launcher__lens">
            <Suspense fallback={null}>
              <TinyOsGlassSurface />
            </Suspense>
          </span>
          {APP_ORDER.map((appId, index) => {
            const Icon = APP_ICONS[appId];
            const label = appLabel(appId, t);
            const available = availableApps.has(appId);
            const active = uiState.focusedAppId === appId && !uiState.minimizedAppIds.includes(appId);
            const window = appWindows.find((candidate) => candidate.appId === appId);
            const status = window?.entries[window.entries.length - 1]?.step.status;
            return (
              <button
                aria-label={t("shell.openApp", { title: label })}
                aria-pressed={active}
                className="tinyos-launcher__app"
                data-active={active ? "true" : undefined}
                data-available={available ? "true" : undefined}
                data-minimized={uiState.minimizedAppIds.includes(appId) ? "true" : undefined}
                data-status={status}
                disabled={!available}
                key={appId}
                title={available ? t("shell.appShortcut", { title: label, number: index + 1 }) : t("shell.noActivity", { title: label })}
                type="button"
                onClick={() => void shellCommandRegistry.execute(`app.open:${appId}`)}
                onContextMenu={(event) => available && openContextMenu(event, t("shell.contextMenu.app", { title: label }), [
                  `window.focus:${appId}`,
                  `window.maximize:${appId}`,
                  `window.minimize:${appId}`,
                ])}
              >
                <Icon aria-hidden="true" size={19} />
                <span>{label}</span>
                {available ? <Circle aria-hidden="true" className="tinyos-launcher__state" fill="currentColor" size={6} /> : null}
              </button>
            );
          })}
          <span aria-hidden="true" className="tinyos-launcher__divider" />
          <button aria-label={t("shell.resetAria")} className="tinyos-launcher__app tinyos-launcher__reset" title={t("shell.reset")} type="button" onClick={() => void shellCommandRegistry.execute("shell.reset_layout")}>
            <RotateCcw aria-hidden="true" size={18} />
            <span>{t("shell.resetShort")}</span>
          </button>
        </nav>

        {!windows.length ? <TinyOsDesktopEmpty /> : windows.map((window) => (
          <TinyOsAppWindow
            active={uiState.focusedAppId === window.appId}
            activeTabId={uiState.activeTabs[window.appId]}
            animateEntry={!initialWindowIds.current.has(window.id)}
            bounds={uiState.bounds}
            commandRegistry={shellCommandRegistry}
            canDirectEdit={canDirectEdit && !history}
            canRequestChange={canRequestChange}
            canSaveFile={canSaveFile && !history}
            browserRuntime={browserRuntime}
            browserSurfaceAllowed={!history && !overlay && !contextMenu && !snapshot.dialog && !pinnedEvidence.length}
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
            onOpenContextMenu={(event) => openContextMenu(event, t("shell.contextMenu.window", { title: window.title }), [
              `window.focus:${window.appId}`,
              `window.maximize:${window.appId}`,
              `window.minimize:${window.appId}`,
              ...(window.entries.length ? [`evidence.inspect:${window.entries[window.entries.length - 1].step.id}` as const] : []),
            ])}
            onOpenArtifact={onOpenArtifact}
            onAgentRequest={onAgentRequest}
            onBrowserHandoffComplete={onBrowserHandoffComplete}
            onDeleteFile={onDeleteFile}
            onMoveFile={onMoveFile}
            onSaveFile={onSaveFile}
            onSetRect={(rect) => dispatchUi({ appId: window.appId, rect, type: "set_rect" })}
            onSnap={(edge) => dispatchUi({ appId: window.appId, edge, type: "snap" })}
            onTabChange={(tabId) => dispatchUi({ appId: window.appId, tabId, type: "set_active_tab" })}
            requestChangeUnavailableReason={requestChangeUnavailableReason}
            directEditUnavailableReason={history ? t("shell.directHistory") : directEditUnavailableReason}
            saveFileUnavailableReason={history ? t("shell.directHistory") : saveFileUnavailableReason}
            runningTerminalOperationId={runningTerminalOperationId}
          />
        ))}

        <TinyOsNotifications
          notifications={snapshot.notifications}
          onSelect={(notificationId) => void shellCommandRegistry.execute(`notification.open:${notificationId}`)}
        />

        {overlay ? (
          <TinyOsShellOverlay
            agentGroups={snapshot.kernel?.agentGroups ?? []}
            appWindows={appWindows}
            commandRegistry={shellCommandRegistry}
            minimizedAppIds={uiState.minimizedAppIds}
            notifications={snapshot.notifications}
            overlay={overlay}
            paletteQuery={paletteQuery}
            readNotificationIds={readNotificationIds}
            processes={snapshot.kernel?.processes ?? []}
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
            submittingFormId={submittingFormId}
            onCancelForm={onCancelForm}
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
              setTransferMessage({ kind: "success", text: t("shell.pinned", { title: accepted.reference.title }) });
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
  const { t } = useTranslation("tinyos");
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => menuRef.current?.querySelector<HTMLElement>("button:not(:disabled)")?.focus(), []);

  async function execute(commandId: TinyOsShellCommandId) {
    const result = await commandRegistry.execute(commandId);
    if (result.status === "executed") onClose();
  }

  return (
    <div className="tinyos-context-menu-layer">
      <button aria-label={t("shell.contextMenu.close", { label: menu.label })} className="tinyos-context-menu-layer__backdrop" type="button" onClick={onClose} />
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
            ><span>{command.label}</span><small>{command.scope === "runtime" ? t("shell.contextMenu.runtime") : t("shell.contextMenu.local")}</small></button>
          );
        })}
      </div>
    </div>
  );
}

function TinyOsShellOverlay({
  agentGroups,
  appWindows,
  commandRegistry,
  minimizedAppIds,
  notifications,
  onClose,
  onPaletteQueryChange,
  overlay,
  paletteQuery,
  readNotificationIds,
  processes,
  switcherAppId,
  zOrder,
}: {
  agentGroups: TinyOsAgentProcessGroup[];
  appWindows: TinyOsWindow[];
  commandRegistry: TinyOsShellCommandRegistry;
  minimizedAppIds: TinyOsAppId[];
  notifications: TinyOsDesktopSnapshot["notifications"];
  onClose: () => void;
  onPaletteQueryChange: (query: string) => void;
  overlay: TinyOsShellOverlay;
  paletteQuery: string;
  readNotificationIds: Set<string>;
  processes: TinyOsProcess[];
  switcherAppId?: TinyOsAppId;
  zOrder: TinyOsAppId[];
}) {
  const { t } = useTranslation("tinyos");
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
      <button aria-label={t("shell.contextMenu.close", { label: overlayLabel(overlay, t) })} className="tinyos-shell-overlay__backdrop" type="button" onClick={onClose} />
      <div
        aria-label={overlayLabel(overlay, t)}
        aria-modal="true"
        className="tinyos-shell-overlay__panel"
        ref={overlayRef}
        role="dialog"
        onKeyDown={handleOverlayKeyDown}
      >
        {overlay === "switcher" ? (
          <>
            <header><span><Command aria-hidden="true" size={16} /><strong>{t("shell.overlay.switchApps")}</strong></span><small>{t("shell.overlay.releaseAlt")}</small></header>
            <div aria-label={t("shell.overlay.availableApps")} className="tinyos-window-switcher" role="listbox">
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
                  ><Icon aria-hidden="true" size={19} /><span><strong>{appLabel(window.appId, t)}</strong><small>{minimizedAppIds.includes(window.appId) ? t("shell.overlay.minimizedRestore") : t("shell.overlay.available")}</small></span></button>
                );
              })}
            </div>
          </>
        ) : null}

        {overlay === "overview" ? (
          <>
            <header><span><LayoutGrid aria-hidden="true" size={16} /><strong>{t("shell.overlay.missionControl")}</strong></span><button aria-label={t("shell.overlay.closeOverview")} type="button" onClick={onClose}><X aria-hidden="true" size={15} /></button></header>
            {agentGroups.length ? (
              <section aria-label={t("shell.overlay.agentGroups")} className="tinyos-mission-groups">
                <h3>{t("shell.overlay.agents")}</h3>
                <div>
                  {agentGroups.map((group) => {
                    const parent = agentGroups.find(({ agentId }) => agentId === group.parentAgentId);
                    const activeWindows = orderedWindows.filter((window) => processes.some((process) => (
                      process.ownerAgentId === group.agentId && process.applicationId === window.appId
                    )));
                    return (
                      <article data-state={group.state} key={group.id}>
                        <header><span><Bot aria-hidden="true" size={14} /><strong>{group.title}</strong></span><small>{group.state.replace(/_/g, " ")}</small></header>
                        {group.assignedWork ? <p>{group.assignedWork}</p> : null}
                        <dl>
                          <div><dt>{t("shell.overlay.parent")}</dt><dd>{parent?.title ?? group.parentAgentId ?? t("shell.overlay.root")}</dd></div>
                          <div><dt>{t("shell.overlay.windows")}</dt><dd>{activeWindows.length ? activeWindows.map(({ appId }) => appLabel(appId, t)).join(", ") : t("shell.overlay.noActiveWindows")}</dd></div>
                        </dl>
                      </article>
                    );
                  })}
                </div>
              </section>
            ) : null}
            <div className="tinyos-window-overview">
              {orderedWindows.map((window, index) => {
                const Icon = APP_ICONS[window.appId];
                const minimized = minimizedAppIds.includes(window.appId);
                return (
                  <button data-autofocus={index === 0 ? "true" : undefined} key={window.id} type="button" onClick={() => void executeAndClose(`window.focus:${window.appId}`)}>
                    <span className="tinyos-window-overview__preview"><Icon aria-hidden="true" size={24} /><small>{t("shell.overlay.canonicalItems", { count: window.entries.length })}</small></span>
                    <span><strong>{appLabel(window.appId, t)}</strong><small>{minimized ? t("shell.overlay.minimizedSelect") : t("shell.overlay.open")}</small></span>
                  </button>
                );
              })}
            </div>
          </>
        ) : null}

        {overlay === "palette" ? (
          <>
            <header className="tinyos-command-palette__search"><Search aria-hidden="true" size={16} /><input aria-label={t("shell.overlay.searchAria")} autoComplete="off" data-autofocus="true" placeholder={t("shell.overlay.searchPlaceholder")} type="search" value={paletteQuery} onChange={(event) => onPaletteQueryChange(event.currentTarget.value)} /><kbd>Esc</kbd></header>
            <div aria-label={t("shell.overlay.results")} className="tinyos-command-palette__results" role="listbox">
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
                  <span><strong>{command.label}</strong><small>{command.category} · {command.scope === "runtime" ? t("shell.overlay.runtime") : t("shell.overlay.local")}</small></span>
                  <small>{command.availability.available ? command.id : command.availability.reason}</small>
                </button>
              )) : <p className="tinyos-shell-overlay__empty">{t("shell.overlay.noCommand", { query: paletteQuery })}</p>}
            </div>
          </>
        ) : null}

        {overlay === "notifications" ? (
          <>
            <header><span><Bell aria-hidden="true" size={16} /><strong>{t("shell.notificationCenter")}</strong></span><button aria-label={t("shell.overlay.closeNotifications")} type="button" onClick={onClose}><X aria-hidden="true" size={15} /></button></header>
            <div aria-label={t("shell.overlay.notificationHistory")} className="tinyos-notification-center">
              {[...notifications].reverse().map((notification, index) => {
                const read = readNotificationIds.has(notification.id);
                const readCommand = requiredShellCommand(commandRegistry, `notification.read:${notification.id}`);
                return (
                  <article data-read={read ? "true" : undefined} key={notification.id}>
                    <button data-autofocus={index === 0 ? "true" : undefined} type="button" onClick={() => void executeAndClose(`notification.open:${notification.id}`)}>
                      {notification.kind === "completed" ? <CheckCircle2 aria-hidden="true" size={16} /> : <AlertTriangle aria-hidden="true" size={16} />}
                      <span><strong>{notification.title}</strong><small>{notification.message}</small><code>{t("shell.overlay.canonicalItem", { id: notification.entry.step.id })}</code></span>
                    </button>
                    <button disabled={!readCommand.availability.available} title={readCommand.availability.available ? readCommand.label : readCommand.availability.reason} type="button" onClick={() => void commandRegistry.execute(readCommand.id)}>{read ? t("shell.overlay.read") : t("shell.overlay.markRead")}</button>
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
  const { t } = useTranslation("tinyos");
  return (
    <div className="tinyos-desktop__empty">
      <FileCode2 aria-hidden="true" size={26} />
      <strong>{t("shell.empty.title")}</strong>
      <span>{t("shell.empty.description")}</span>
    </div>
  );
}

function TinyOsAppWindow({
  active,
  activeTabId,
  animateEntry,
  bounds,
  browserRuntime,
  browserSurfaceAllowed,
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
  onBrowserHandoffComplete,
  onDeleteFile,
  onMoveFile,
  onSaveFile,
  onSetRect,
  onSnap,
  onTabChange,
  requestChangeUnavailableReason,
  runningTerminalOperationId,
  saveFileUnavailableReason,
  systemMonitorControls,
  window,
  zIndex,
}: {
  active: boolean;
  activeTabId?: string;
  animateEntry: boolean;
  bounds: TinyOsDesktopBounds;
  browserRuntime?: NativeBrowserRuntimeApi;
  browserSurfaceAllowed: boolean;
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
  onBrowserHandoffComplete: (input: TinyOsBrowserHandoff) => void;
  onDeleteFile: (input: TinyOsFileDeleteInput) => Promise<void>;
  onMoveFile: (input: TinyOsFileMoveInput) => Promise<void>;
  onSaveFile: (input: TinyOsFileSaveInput) => Promise<void>;
  onSetRect: (rect: TinyOsWindowRect) => void;
  onSnap: (edge: "left" | "right") => void;
  onTabChange: (tabId: string) => void;
  requestChangeUnavailableReason?: string;
  runningTerminalOperationId?: string;
  saveFileUnavailableReason?: string;
  systemMonitorControls: TinyOsSystemMonitorControls;
  window: TinyOsWindow;
  zIndex: number;
}) {
  const { t } = useTranslation("tinyos");
  const Icon = APP_ICONS[window.appId];
  const displayTitle = appLabel(window.appId, t);
  const latest = window.entries[window.entries.length - 1];
  const windowRef = useRef<HTMLElement>(null);
  const [pointerActive, setPointerActive] = useState(false);
  const pointerState = useRef<{
    animationFrame?: number;
    kind: "move" | "resize";
    pointerId: number;
    previewRect?: TinyOsWindowRect;
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

  useLayoutEffect(() => {
    if (pointerActive || !layout) return;
    applyWindowRect(windowRef.current, layout);
  }, [layout?.height, layout?.width, layout?.x, layout?.y, pointerActive]);

  useLayoutEffect(() => {
    const element = windowRef.current;
    if (!animateEntry || !element || globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const context = gsap.context(() => {
      gsap.fromTo(element, {
        opacity: 0,
        scale: .982,
        y: 12,
      }, {
        clearProps: "opacity,transform",
        duration: .22,
        ease: "power3.out",
        opacity: 1,
        scale: 1,
        y: 0,
      });
    }, element);
    return () => context.revert();
  }, [animateEntry]);

  useEffect(() => () => {
    const animationFrame = pointerState.current?.animationFrame;
    if (animationFrame !== undefined) globalThis.cancelAnimationFrame(animationFrame);
  }, []);

  function startPointer(event: PointerEvent<HTMLElement>, kind: "move" | "resize") {
    if (!layout || event.button !== 0) return;
    if (kind === "move" && (event.target as Element).closest("button")) return;
    event.preventDefault();
    onFocus();
    setPointerActive(true);
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
    interaction.previewRect = pointerInteractionRect(interaction, event.clientX, event.clientY, bounds);
    if (interaction.animationFrame !== undefined) return;
    interaction.animationFrame = globalThis.requestAnimationFrame(() => {
      interaction.animationFrame = undefined;
      if (pointerState.current === interaction) applyWindowRect(windowRef.current, interaction.previewRect);
    });
  }

  function endPointer(event: PointerEvent<HTMLElement>) {
    const interaction = pointerState.current;
    if (!interaction || interaction.pointerId !== event.pointerId) return;
    if (interaction.animationFrame !== undefined) globalThis.cancelAnimationFrame(interaction.animationFrame);
    const finalRect = event.type === "pointerup"
      && (event.clientX !== interaction.startClientX || event.clientY !== interaction.startClientY)
      ? pointerInteractionRect(interaction, event.clientX, event.clientY, bounds)
      : interaction.previewRect;
    if (finalRect) {
      applyWindowRect(windowRef.current, finalRect);
      onSetRect(finalRect);
    }
    pointerState.current = undefined;
    setPointerActive(false);
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
      aria-label={t("shell.window.label", { title: displayTitle })}
      className="tinyos-window"
      data-active={active ? "true" : undefined}
      data-app={window.appId}
      data-maximized={layout?.maximized ? "true" : undefined}
      onMouseDown={onFocus}
      onContextMenu={onOpenContextMenu}
      ref={windowRef}
      style={style}
    >
      <header
        aria-label={t("shell.window.move", { title: displayTitle })}
        className="tinyos-window__titlebar"
        tabIndex={0}
        title={t("shell.window.dragHelp")}
        onDoubleClick={onMaximize}
        onKeyDown={handleWindowKeyDown}
        onPointerDown={(event) => startPointer(event, "move")}
        onPointerMove={movePointer}
        onPointerCancel={endPointer}
        onPointerUp={endPointer}
      >
        <span><Icon aria-hidden="true" size={15} /><strong>{displayTitle}</strong></span>
        <span className="tinyos-window__source">{latest?.step.title ?? (window.appId === "system_monitor" ? t("shell.window.processes", { count: kernel?.processes.length ?? 0 }) : t("shell.window.explorer"))}</span>
        {latest ? <TinyOsStatus status={latest.step.status} /> : null}
        {latest ? <button aria-label={t("shell.window.inspect", { title: displayTitle })} title={t("shell.window.inspect", { title: displayTitle })} type="button" onClick={() => onInspect(latest)}><Info aria-hidden="true" size={14} /></button> : null}
        <button aria-label={`${layout?.maximized ? t("shell.window.restore") : t("shell.window.maximize")} ${displayTitle}`} title={layout?.maximized ? t("shell.window.restore") : t("shell.window.maximize")} type="button" onClick={onMaximize}><Maximize2 aria-hidden="true" size={14} /></button>
        <button aria-label={t("shell.window.minimize", { title: displayTitle })} title={t("shell.window.minimize", { title: displayTitle })} type="button" onClick={onMinimize}><Minus aria-hidden="true" size={15} /></button>
      </header>
      <div className="tinyos-window__content">
        <TinyOsAppContent
          activeTabId={activeTabId}
          canDirectEdit={canDirectEdit}
          canRequestChange={canRequestChange}
          canSaveFile={canSaveFile}
          browserRuntime={browserRuntime}
          browserSurfaceLayout={layout}
          browserSurfaceVisible={active && browserSurfaceAllowed && !pointerActive}
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
          onBrowserHandoffComplete={onBrowserHandoffComplete}
          onDeleteFile={onDeleteFile}
          onMoveFile={onMoveFile}
          onSaveFile={onSaveFile}
          onTabChange={onTabChange}
          requestChangeUnavailableReason={requestChangeUnavailableReason}
          runningTerminalOperationId={runningTerminalOperationId}
          saveFileUnavailableReason={saveFileUnavailableReason}
          systemMonitorControls={systemMonitorControls}
        />
      </div>
      <div
        aria-label={t("shell.window.resize", { title: displayTitle })}
        className="tinyos-window__resize-handle"
        role="separator"
        tabIndex={-1}
        onPointerDown={(event) => startPointer(event, "resize")}
        onPointerMove={movePointer}
        onPointerCancel={endPointer}
        onPointerUp={endPointer}
      />
    </article>
  );
}

function pointerInteractionRect(
  interaction: {
    kind: "move" | "resize";
    startClientX: number;
    startClientY: number;
    startRect: TinyOsWindowRect;
  },
  clientX: number,
  clientY: number,
  bounds: TinyOsDesktopBounds,
): TinyOsWindowRect {
  const dx = clientX - interaction.startClientX;
  const dy = clientY - interaction.startClientY;
  return normalizeWindowLayout(interaction.kind === "move" ? {
    ...interaction.startRect,
    x: interaction.startRect.x + dx,
    y: interaction.startRect.y + dy,
  } : {
    ...interaction.startRect,
    height: interaction.startRect.height + dy,
    width: interaction.startRect.width + dx,
  }, bounds);
}

function applyWindowRect(element: HTMLElement | null, rect: TinyOsWindowRect | undefined): void {
  if (!element || !rect) return;
  element.style.height = `${rect.height}px`;
  element.style.left = `${rect.x}px`;
  element.style.top = `${rect.y}px`;
  element.style.width = `${rect.width}px`;
}

function TinyOsAppContent({ activeTabId, browserRuntime, browserSurfaceLayout, browserSurfaceVisible, canDirectEdit, canRequestChange, canSaveFile, commandLifecycle, commandRegistry, directEditUnavailableReason, filesController, kernel, layoutMode, window, onAgentRequest, onAttachContext, onBrowserHandoffComplete, onDeleteFile, onMoveFile, onOpenArtifact, onSaveFile, onTabChange, requestChangeUnavailableReason, runningTerminalOperationId, saveFileUnavailableReason, systemMonitorControls }: {
  activeTabId?: string;
  browserRuntime?: NativeBrowserRuntimeApi;
  browserSurfaceLayout?: TinyOsWindowRect;
  browserSurfaceVisible: boolean;
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
  onBrowserHandoffComplete: (input: TinyOsBrowserHandoff) => void;
  onDeleteFile: (input: TinyOsFileDeleteInput) => Promise<void>;
  onMoveFile: (input: TinyOsFileMoveInput) => Promise<void>;
  onOpenArtifact: (artifact: ArtifactRef) => void;
  onSaveFile: (input: TinyOsFileSaveInput) => Promise<void>;
  onTabChange: (tabId: string) => void;
  requestChangeUnavailableReason?: string;
  runningTerminalOperationId?: string;
  saveFileUnavailableReason?: string;
  systemMonitorControls: TinyOsSystemMonitorControls;
  window: TinyOsWindow;
}) {
  const { t } = useTranslation("tinyos");
  switch (window.appId) {
    case "files": return filesController?.queryAvailable || !window.entries.length
      ? filesController
        ? <TinyOsFilesExplorer canDirectEdit={canDirectEdit} canRequestChange={canRequestChange} canSave={canSaveFile} commandLifecycle={commandLifecycle} commandRegistry={commandRegistry} controller={filesController} directEditUnavailableReason={directEditUnavailableReason} kernel={kernel} layoutMode={layoutMode} onAttachContext={onAttachContext} onDeleteFile={onDeleteFile} onMoveFile={onMoveFile} onRequestExplanation={(reference) => onAgentRequest(reference, "explain")} onRequestModification={(reference) => onAgentRequest(reference, "modify")} onSaveFile={onSaveFile} requestChangeUnavailableReason={requestChangeUnavailableReason} saveUnavailableReason={saveFileUnavailableReason} />
        : <EmptyCopy text={t("shell.emptyCopy.explorerUnavailable")} />
      : <TinyOsFiles activeTabId={activeTabId} canRequestChange={canRequestChange} window={window} onAgentRequest={onAgentRequest} onAttachContext={onAttachContext} onTabChange={onTabChange} requestChangeUnavailableReason={requestChangeUnavailableReason} />;
    case "terminal": return <div className="tinyos-terminal-host"><TinyOsTerminalHostControls commandLifecycle={commandLifecycle} commandRegistry={commandRegistry} runningOperationId={runningTerminalOperationId} />{window.entries.length ? <TinyOsTerminal activeTabId={activeTabId} canRequestChange={canRequestChange} kernel={kernel} window={window} onAgentRequest={onAgentRequest} onAttachContext={onAttachContext} onTabChange={onTabChange} requestChangeUnavailableReason={requestChangeUnavailableReason} /> : <EmptyCopy text={t("shell.emptyCopy.terminal")} />}</div>;
    case "browser": return <TinyOsBrowserApp browserRuntime={browserRuntime} kernel={kernel} onHandoffComplete={onBrowserHandoffComplete} surfaceLayout={browserSurfaceLayout} surfaceVisible={browserSurfaceVisible} />;
    case "plan": return <TinyOsPlan canRequestChange={canRequestChange} entry={[...window.entries].reverse().find(({ step }) => Boolean(step.plan)) ?? window.entries[window.entries.length - 1]} onAgentRequest={onAgentRequest} requestChangeUnavailableReason={requestChangeUnavailableReason} />;
    case "subagents": return <TinyOsSubagents window={window} />;
    case "artifacts": return <TinyOsArtifacts window={window} onOpenArtifact={onOpenArtifact} />;
    case "inspector": return <TinyOsStructured entry={window.entries[window.entries.length - 1]} />;
    case "system_monitor": return kernel ? <TinyOsSystemMonitor controls={systemMonitorControls} snapshot={kernel} /> : <EmptyCopy text={t("shell.emptyCopy.kernel")} />;
  }
}

function TinyOsFiles({ activeTabId, canRequestChange, onAgentRequest, onAttachContext, onTabChange, requestChangeUnavailableReason, window }: { activeTabId?: string; canRequestChange: boolean; onAgentRequest: (reference: TinyOsAgentRequestReference, intent: TinyOsAgentRequestIntent) => void; onAttachContext: (reference: TinyOsContextReference) => void; onTabChange: (tabId: string) => void; requestChangeUnavailableReason?: string; window: TinyOsWindow }) {
  const { t } = useTranslation("tinyos");
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
        <strong><FolderOpen aria-hidden="true" size={12} />{t("shell.legacyFiles.workspace")}</strong>
        {directories.map((directory) => <span className="tinyos-files__directory" key={directory}><Folder aria-hidden="true" size={12} />{directory}</span>)}
        {files.slice(-12).map(({ entry, path }) => (
          <button aria-pressed={entry === active.entry} data-active={entry === active.entry ? "true" : undefined} key={`${entry.turnId}:${entry.step.id}`} title={path} type="button" onClick={() => onTabChange(entry.step.id)}><FileText aria-hidden="true" size={13} />{fileName(path)}</button>
        ))}
      </aside>
      <section>
        <div className="tinyos-app-tabs" role="tablist" aria-label={t("shell.legacyFiles.openFiles")}>
          {files.slice(-6).map(({ entry, path }) => <button aria-selected={entry === active.entry} data-active={entry === active.entry ? "true" : undefined} key={entry.step.id} role="tab" type="button" onClick={() => onTabChange(entry.step.id)}>{fileName(path)}</button>)}
        </div>
        <div className="tinyos-files__path"><FileCode2 aria-hidden="true" size={14} />{active.path}</div>
        {content ? <ol className="tinyos-code-view">{lines.map((line, index) => {
          const lineNumber = index + 1;
          const selected = selectionStart !== undefined && selectionEnd !== undefined && lineNumber >= selectionStart && lineNumber <= selectionEnd;
          return <li data-selected={selected ? "true" : undefined} key={index}><button type="button" onClick={(event) => selectLine(lineNumber, event.shiftKey)}><code>{line || " "}</code></button></li>;
        })}</ol> : <EmptyCopy text={active.entry.step.summary || t("shell.legacyFiles.noPreview")} />}
        <footer className="tinyos-files__status"><span>{fileLanguage(active.path)}</span><span>UTF-8</span>{selectedReference ? <button draggable="true" title={t("files.attachHelp")} type="button" onClick={() => onAttachContext(selectedReference)} onDragStart={(event) => writeTinyOsReferenceTransfer(event.dataTransfer, { kind: "context", reference: selectedReference })}><Paperclip aria-hidden="true" size={11} />{t("shell.legacyFiles.attach", { path: active.path, start: selectionStart ?? 1, range: selectionEnd !== selectionStart ? `–${selectionEnd}` : "" })}</button> : null}{selectedReference ? <button disabled={!canRequestChange} title={canRequestChange ? t("files.explainHelp") : requestChangeUnavailableReason} type="button" onClick={() => onAgentRequest(selectedReference, "explain")}><MessageCircleQuestion aria-hidden="true" size={11} />{t("shell.legacyFiles.explain")}</button> : null}{selectedReference ? <button disabled={!canRequestChange} title={canRequestChange ? t("files.modifyHelp") : requestChangeUnavailableReason} type="button" onClick={() => onAgentRequest(selectedReference, "modify")}><PencilLine aria-hidden="true" size={11} />{t("shell.legacyFiles.modify")}</button> : null}<span>{t("shell.legacyFiles.canonicalItem", { number: active.entry.step.sequence + 1 })}</span></footer>
      </section>
    </div>
  );
}

function TinyOsTerminalHostControls({ commandLifecycle, commandRegistry, runningOperationId }: {
  commandLifecycle: TinyOsCommandLifecycle;
  commandRegistry: TinyOsShellCommandRegistry;
  runningOperationId?: string;
}) {
  const { t } = useTranslation("tinyos");
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
      <label><span>{t("shell.terminal.command")}</span><input aria-label={t("shell.terminal.commandAria")} disabled={!canExecute || Boolean(runningOperationId)} placeholder={t("shell.terminal.commandPlaceholder")} value={command} onChange={(event) => { setCommand(event.currentTarget.value); setReviewed(false); }} /></label>
      <label><span>cwd</span><input aria-label={t("shell.terminal.cwdAria")} disabled={!canExecute || Boolean(runningOperationId)} value={cwd} onChange={(event) => { setCwd(event.currentTarget.value); setReviewed(false); }} /></label>
      <div>
        <button disabled={!canExecute || !command.trim() || Boolean(runningOperationId)} title={canExecute ? t("shell.terminal.reviewHelp") : executeCommand.availability.reason} type="button" onClick={() => setReviewed(true)}>{t("shell.terminal.review")}</button>
        <button disabled={!canExecute || !reviewed || !command.trim() || Boolean(runningOperationId)} title={t("shell.terminal.runHelp")} type="submit"><Play aria-hidden="true" size={12} />{t("shell.terminal.run")}</button>
        <button disabled={!canCancel || !runningOperationId} title={canCancel ? t("shell.terminal.cancelHelp") : cancelCommand.availability.reason} type="button" onClick={() => {
          setError("");
          void commandRegistry.execute("terminal.cancel").then((execution) => {
            if (execution.status === "rejected") throw new Error(execution.reason);
          }).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
        }}><Pause aria-hidden="true" size={12} />{t("shell.terminal.cancelProcess")}</button>
      </div>
      {reviewed ? <p role="status"><ShieldCheck aria-hidden="true" size={12} />{t("shell.terminal.reviewedBoundary", { cwd: cwd || "." })}</p> : null}
      <p className="tinyos-terminal-command__contract"><ShieldCheck aria-hidden="true" size={12} />{t("shell.terminal.contractCopy")}</p>
      {commandLifecycle.stage !== "idle" && (commandLifecycle.command.kind === "terminal.execute" || commandLifecycle.command.kind === "terminal.cancel") ? <TinyOsTerminalLifecycle lifecycle={commandLifecycle} /> : null}
      {error ? <p role="alert">{error}</p> : null}
    </form>
  );
}

function TinyOsTerminalLifecycle({ lifecycle }: { lifecycle: Exclude<TinyOsCommandLifecycle, { stage: "idle" }> }) {
  const { t } = useTranslation("tinyos");
  const label = lifecycle.command.kind === "terminal.cancel" ? t("shell.terminal.cancel") : t("shell.terminal.execution");
  if (lifecycle.stage === "sending") return <p className="tinyos-terminal-lifecycle" role="status"><strong>{t("shell.terminal.dispatching", { label })}</strong><span>{t("shell.terminal.transportPending")}</span></p>;
  if (lifecycle.stage === "waiting_for_canonical") return <p className="tinyos-terminal-lifecycle" role="status"><strong>{t("shell.terminal.awaiting", { label })}</strong><span>{t("shell.terminal.transportAccepted")}</span></p>;
  if (lifecycle.stage === "acknowledged") return <p className="tinyos-terminal-lifecycle" role="status"><strong>{t("shell.terminal.acknowledged", { label })}</strong><span>{t("shell.terminal.canonicalItem", { id: lifecycle.acknowledgement.itemId })}</span></p>;
  if (lifecycle.stage === "completed") return <p className="tinyos-terminal-lifecycle" data-state={lifecycle.completion.status} role="status"><strong>{t("shell.terminal.completed", { label, status: lifecycle.completion.status })}</strong><span>{t("shell.terminal.canonicalRevision", { revision: lifecycle.completion.revision })}</span></p>;
  return <p className="tinyos-terminal-lifecycle" data-state="failed" role="alert"><strong>{t("shell.terminal.failed", { label, stage: lifecycle.stage.replace("_", " ") })}</strong><span>{lifecycle.error}</span></p>;
}

function TinyOsTerminal({ activeTabId, canRequestChange, kernel, onAgentRequest, onAttachContext, onTabChange, requestChangeUnavailableReason, window }: { activeTabId?: string; canRequestChange: boolean; kernel?: TinyOsKernelSnapshot; onAgentRequest: (reference: TinyOsAgentRequestReference, intent: TinyOsAgentRequestIntent) => void; onAttachContext: (reference: TinyOsContextReference) => void; onTabChange: (tabId: string) => void; requestChangeUnavailableReason?: string; window: TinyOsWindow }) {
  const { t } = useTranslation("tinyos");
  const active = window.entries.find((entry) => entry.step.id === activeTabId) ?? window.entries[window.entries.length - 1];
  const [follow, setFollow] = useState(true);
  const [query, setQuery] = useState("");
  const [stream, setStream] = useState<"all" | "stdout" | "stderr">("all");
  const [selection, setSelection] = useState<{ anchor: number; end: number }>();
  const [activeMatch, setActiveMatch] = useState(0);
  const outputRef = useRef<HTMLDivElement>(null);
  const stdout = terminalOutput(active.step, t);
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
  const metadata = terminalMetadata(active.step, t);

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
      <div className="tinyos-terminal__tabs" role="tablist" aria-label={t("shell.terminal.canonicalCommands")}>
        {window.entries.slice(-6).map((entry) => <button aria-selected={entry === active} data-active={entry === active ? "true" : undefined} key={`${entry.turnId}:${entry.step.id}`} role="tab" title={terminalCommand(entry.step)} type="button" onClick={() => onTabChange(entry.step.id)}>{terminalCommand(entry.step)}</button>)}
        <TinyOsStatus status={active.step.status} />
      </div>
      <dl aria-label={t("shell.terminal.identity")} className="tinyos-terminal__identity" role="group">
        <div><dt>{t("shell.terminal.contract")}</dt><dd>{t("shell.terminal.contractValue")}</dd></div>
        <div><dt>{t("shell.terminal.turnItem")}</dt><dd><code>{active.turnId} / {active.step.id}</code></dd></div>
        <div><dt>{t("shell.terminal.process")}</dt><dd><code>{execution.processId || t("shell.terminal.unavailable")}</code></dd></div>
        <div><dt>cwd</dt><dd><code>{metadata.cwd || t("shell.terminal.unavailable")}</code></dd></div>
        <div><dt>{t("shell.terminal.boundary")}</dt><dd>{t("shell.terminal.boundaryValue", { sandbox: execution.sandboxMode, network: execution.networkMode })}</dd></div>
        <div><dt>{t("shell.terminal.output")}</dt><dd>{t("shell.terminal.outputValue", { stdout: execution.stdoutBytes, stderr: execution.stderrBytes, dropped: execution.droppedBytes ? t("shell.terminal.dropped", { count: execution.droppedBytes }) : "" })}</dd></div>
        <div><dt>{t("shell.terminal.exitTiming")}</dt><dd>{metadata.exit} · {active.step.toolCall?.durationMs !== undefined ? `${active.step.toolCall.durationMs} ms` : t("shell.terminal.timingUnavailable")}</dd></div>
        <div><dt>{t("shell.terminal.provenance")}</dt><dd><ShieldCheck aria-hidden="true" size={11} />canonical_event · {active.step.id}</dd></div>
      </dl>
      <div className="tinyos-terminal__toolbar">
        <label><Search aria-hidden="true" size={12} /><input aria-label={t("shell.terminal.search")} placeholder={t("shell.terminal.searchPlaceholder")} value={query} onChange={(event) => { setQuery(event.currentTarget.value); setActiveMatch(0); }} /></label>
        <span aria-live="polite">{query ? `${matches.length ? Math.min(activeMatch, matches.length - 1) + 1 : 0}/${matches.length}` : ""}</span>
        <button aria-label={t("shell.terminal.previous")} disabled={!matches.length} title={t("shell.terminal.previousShort")} type="button" onClick={() => moveMatch(-1)}><ChevronLeft aria-hidden="true" size={12} /></button>
        <button aria-label={t("shell.terminal.next")} disabled={!matches.length} title={t("shell.terminal.nextShort")} type="button" onClick={() => moveMatch(1)}><ChevronRight aria-hidden="true" size={12} /></button>
        <select aria-label={t("shell.terminal.streamFilter")} value={stream} onChange={(event) => setStream(event.currentTarget.value as "all" | "stdout" | "stderr")}><option value="all">{t("shell.terminal.allStreams")}</option><option value="stdout">stdout</option><option value="stderr">stderr</option></select>
        <button aria-label={t("shell.terminal.copyCommandAria")} title={t("shell.terminal.copyCommand")} type="button" onClick={() => copyText(terminalCommand(active.step))}><Copy aria-hidden="true" size={12} />{t("shell.terminal.commandShort")}</button>
        <button aria-label={selection ? t("shell.terminal.copySelected") : t("shell.terminal.copyLoaded")} title={selection ? t("shell.terminal.copySelection") : t("shell.terminal.copyOutput")} type="button" onClick={() => copyText(selection ? selectedText : outputLines.join("\n"))}><Copy aria-hidden="true" size={12} />{selection ? t("shell.terminal.selection") : t("shell.terminal.outputShort")}</button>
        <button aria-pressed={follow} title={follow ? t("shell.terminal.pauseFollow") : t("shell.terminal.followOutput")} type="button" onClick={() => setFollow((current) => !current)}>{follow ? <Pause aria-hidden="true" size={12} /> : <Play aria-hidden="true" size={12} />}{follow ? t("shell.terminal.pause") : t("shell.terminal.follow")}</button>
      </div>
      <div className="tinyos-terminal__output" data-follow={follow ? "true" : undefined} ref={outputRef}>
        <ol>{outputLines.map((line, index) => {
          const matches = Boolean(query && line.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
          const selected = selectionStart !== undefined && selectionEnd !== undefined && index >= selectionStart && index <= selectionEnd;
          return <li data-current-match={currentMatch === index ? "true" : undefined} data-line={index} data-match={matches ? "true" : undefined} data-selected={selected ? "true" : undefined} key={index}><button type="button" onClick={(event) => selectLine(index, event.shiftKey)}><code>{line || " "}</code></button></li>;
        })}</ol>
      </div>
      <footer><span>{metadata.cwd ? `cwd ${metadata.cwd}` : t("shell.terminal.agent", { name: active.step.agentContext.title })}</span><span>{metadata.exit}</span><span>{active.step.toolCall?.durationMs !== undefined ? `${active.step.toolCall.durationMs} ms` : statusLabel(active.step.status, t)}</span>{selectedReference ? <button draggable="true" title={t("shell.terminal.attachHelp")} type="button" onClick={() => onAttachContext(selectedReference)} onDragStart={(event) => writeTinyOsReferenceTransfer(event.dataTransfer, { kind: "context", reference: selectedReference })}><Paperclip aria-hidden="true" size={11} />{t("shell.terminal.attach", { start: selectedReference.startLine ?? 1, range: !selectedReference.endLine || selectedReference.endLine === selectedReference.startLine ? "" : `–${selectedReference.endLine}` })}</button> : <span>{follow ? t("shell.terminal.following") : t("shell.terminal.paused")}</span>}{selectedReference ? <button disabled={!canRequestChange} title={canRequestChange ? t("shell.terminal.explainHelp") : requestChangeUnavailableReason} type="button" onClick={() => onAgentRequest(selectedReference, "explain")}><MessageCircleQuestion aria-hidden="true" size={11} />{t("shell.terminal.explain")}</button> : null}{selectedReference ? <button disabled={!canRequestChange} title={canRequestChange ? t("shell.terminal.continueHelp") : requestChangeUnavailableReason} type="button" onClick={() => onAgentRequest(selectedReference, "follow_up")}><Play aria-hidden="true" size={11} />{t("shell.terminal.continue")}</button> : null}{outputTruncated || execution.truncated ? <span>{t("shell.terminal.retained", { dropped: execution.droppedBytes ? t("shell.terminal.dropped", { count: execution.droppedBytes }) : "" })}</span> : null}<span>{t("shell.terminal.streamItem", { stream, number: active.step.sequence + 1 })}</span></footer>
    </div>
  );
}

function TinyOsPlan({ canRequestChange, entry, onAgentRequest, requestChangeUnavailableReason }: { canRequestChange: boolean; entry: TinyOsTimelineEntry; onAgentRequest: (reference: TinyOsAgentRequestReference, intent: TinyOsAgentRequestIntent) => void; requestChangeUnavailableReason?: string }) {
  const { t } = useTranslation("tinyos");
  const plan = entry.step.plan;
  const [adjustment, setAdjustment] = useState("");
  if (!plan) return <EmptyCopy text={t("shell.plan.unavailable")} />;
  const snapshotText = JSON.stringify({ explanation: plan.explanation, steps: plan.steps });
  return (
    <div className="tinyos-plan">
      <header><h3>{t("shell.plan.title")}</h3><span>{plan.completed}/{plan.total}</span></header>
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
        <input aria-label={t("shell.plan.adjustmentAria")} disabled={!canRequestChange} maxLength={2_048} placeholder={t("shell.plan.adjustmentPlaceholder")} value={adjustment} onChange={(event) => setAdjustment(event.currentTarget.value)} />
        <button disabled={!canRequestChange || !adjustment.trim()} title={canRequestChange ? t("shell.plan.adjustmentHelp") : requestChangeUnavailableReason} type="submit"><PencilLine aria-hidden="true" size={11} />{t("shell.plan.adjust")}</button>
      </form>
    </div>
  );
}

function TinyOsSubagents({ window }: { window: TinyOsWindow }) {
  const { t } = useTranslation("tinyos");
  return (
    <div className="tinyos-subagents">
      {window.entries.slice(-8).map((entry) => (
        <article key={`${entry.turnId}:${entry.step.id}`}>
          <Bot aria-hidden="true" size={17} />
          <div><strong>{entry.step.delegate?.title || entry.step.title}</strong><span>{entry.step.delegate?.task || entry.step.summary || t("shell.subagents.delegatedTask")}</span></div>
          <TinyOsStatus status={entry.step.status} />
        </article>
      ))}
    </div>
  );
}

function TinyOsArtifacts({ window, onOpenArtifact }: { window: TinyOsWindow; onOpenArtifact: (artifact: ArtifactRef) => void }) {
  const { t } = useTranslation("tinyos");
  const artifacts = window.entries.flatMap(({ step }) => step.artifacts ?? []);
  if (!artifacts.length) return <EmptyCopy text={t("shell.artifacts.unavailable")} />;
  return (
    <div className="tinyos-artifacts">
      {artifacts.map((artifact) => (
        <button key={artifact.id} type="button" onClick={() => onOpenArtifact(artifact)}>
          <FileText aria-hidden="true" size={18} />
          <span><strong>{artifact.title}</strong><small>{artifact.kind}</small></span>
          <span>{artifact.preview || t("shell.artifacts.open")}</span>
        </button>
      ))}
    </div>
  );
}

function TinyOsStructured({ entry }: { entry: TinyOsTimelineEntry }) {
  const { t } = useTranslation("tinyos");
  return (
    <div className="tinyos-structured">
      <strong>{entry.step.title}</strong>
      <p>{entry.step.summary || t("shell.structured.details")}</p>
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
  const { t } = useTranslation("tinyos");
  if (!notifications.length) return null;
  return (
    <aside aria-label={t("shell.notifications")} className="tinyos-notifications">
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
  onSubmitForm,
  submittingFormId,
}: {
  agentUiForms: AgentUiForm[];
  dialog: NonNullable<TinyOsDesktopSnapshot["dialog"]>;
  onCancelForm: (form: AgentUiForm) => void;
  onSubmitForm: (form: AgentUiForm, values: Record<string, unknown>) => void;
  submittingFormId?: string;
}) {
  const { t } = useTranslation("tinyos");
  const { step } = dialog.entry;
  const form = agentUiForms.find((candidate) => candidate.form_id === step.form?.formId);
  return (
    <div aria-label={t("shell.dialog.input")} aria-modal="true" className="tinyos-system-dialog" role="dialog">
      <div className="tinyos-system-dialog__heading"><ShieldCheck aria-hidden="true" size={20} /><div><small>{t("shell.dialog.input")}</small><strong>{step.title}</strong></div></div>
      {form ? <AgentUiFormCard form={form} submitting={submittingFormId === form.form_id} onCancel={() => onCancelForm(form)} onSubmit={(values) => onSubmitForm(form, values)} /> : <EmptyCopy text={t("shell.dialog.loading")} />}
    </div>
  );
}

function TinyOsInspector({ evidence, onClose, onOpenArtifact, onReferenceDrop }: { evidence: TinyOsPinnedEvidence[]; onClose: (pin: TinyOsPinnedEvidence) => void; onOpenArtifact: (artifact: ArtifactRef) => void; onReferenceDrop: (event: DragEvent<HTMLElement>) => void }) {
  const { t } = useTranslation("tinyos");
  return (
    <aside
      aria-label={t("shell.inspector.label")}
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
            <header><div><small>{t("shell.inspector.evidence", { event: pin.cursor.eventIndex + 1 })}</small><strong>{entry.step.title}</strong></div><button aria-label={t("shell.inspector.close", { title: entry.step.title, event: pin.cursor.eventIndex + 1 })} type="button" onClick={() => onClose(pin)}><X aria-hidden="true" size={15} /></button></header>
            <TinyOsStatus status={entry.step.status} />
            <dl className="tinyos-inspector__correlation">
              <div><dt>{t("shell.inspector.boundary")}</dt><dd>{t("shell.inspector.eventOf", { event: pin.cursor.eventIndex + 1, count: pin.cursor.eventCount })}</dd></div>
              <div><dt>{t("shell.inspector.observed")}</dt><dd>{pin.cursor.wallClockTime ?? t("shell.inspector.unavailable")}</dd></div>
            </dl>
            {entry.step.summary ? <p>{entry.step.summary}</p> : null}
            {entry.step.toolCall ? <dl className="tinyos-inspector__correlation"><div><dt>{t("shell.inspector.toolCall")}</dt><dd>{entry.step.toolCall.id}</dd></div>{entry.step.toolCall.resultRef ? <div><dt>{t("shell.inspector.resultRef")}</dt><dd>{entry.step.toolCall.resultRef}</dd></div> : null}<div><dt>{t("shell.inspector.turn")}</dt><dd>{entry.turnId}</dd></div><div><dt>{t("shell.inspector.agent")}</dt><dd>{entry.step.agentContext.title}</dd></div></dl> : null}
            {entry.step.toolCall?.argsJson !== undefined ? <section><strong>{t("shell.inspector.arguments")}</strong><pre>{sanitizedJsonPreview(entry.step.toolCall.argsJson)}</pre></section> : null}
            {entry.step.toolCall?.resultJson !== undefined ? <section><strong>{t("shell.inspector.result")}</strong><pre>{sanitizedJsonPreview(entry.step.toolCall.resultJson)}</pre></section> : null}
            {entry.step.toolCall?.resultPreview ? <section><strong>{t("shell.inspector.resultPreview")}</strong><pre>{entry.step.toolCall.resultPreview}</pre></section> : null}
            {entry.step.toolCall?.stderrPreview ? <section><strong>{t("shell.terminal.stderr")}</strong><pre>{entry.step.toolCall.stderrPreview}</pre></section> : null}
            {pin.resources.length ? <section><strong>{t("shell.inspector.resources")}</strong>{pin.resources.map((resource) => <dl className="tinyos-inspector__resource" key={resource.id}><div><dt>{t("shell.inspector.identity")}</dt><dd>{resource.id}</dd></div><div><dt>{t("shell.inspector.revision")}</dt><dd>{resource.revision ?? resource.provenance.revision ?? t("shell.inspector.unavailable")}</dd></div><div><dt>{t("shell.inspector.provenance")}</dt><dd>{resource.provenance.kind} · {resource.provenance.sourceId}</dd></div></dl>)}</section> : null}
            {artifacts.length ? <section><strong>{t("shell.inspector.artifacts")}</strong>{artifacts.map((artifact) => <button key={artifact.id} type="button" onClick={() => onOpenArtifact(artifact)}>{artifact.title}</button>)}</section> : null}
            <footer>{t("shell.inspector.footer", { event: pin.cursor.eventIndex + 1, item: entry.step.sequence + 1, agent: entry.step.agentContext.title })}</footer>
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
  const { t } = useTranslation("tinyos");
  const operation = operations[operations.length - 1];
  const Icon = operation ? APP_ICONS[operation.appId] : undefined;
  const selectCommand = operation
    ? requiredShellCommand(commandRegistry, `history.select:${operation.entry.step.id}`)
    : undefined;
  const retryCommand = operation
    ? requiredShellCommand(commandRegistry, `operation.retry:${operation.entry.step.id}`)
    : undefined;
  return (
    <nav aria-label={t("shell.shelf.label")} className="tinyos-operation-shelf">
      {operation && Icon && selectCommand && retryCommand ? (
        <>
          <button
            className="tinyos-operation-shelf__select"
            data-status={operation.status}
            draggable="true"
            title={t("shell.shelf.openHelp")}
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
            <span><small>{t("shell.shelf.latest")}</small><strong>{operation.title}</strong></span>
            <span><small>{t("shell.shelf.status")}</small><strong>{statusLabel(operation.status, t)}</strong></span>
            <span><small>{t("shell.shelf.agent")}</small><strong>{operation.entry.step.agentContext.title}</strong></span>
            <span><small>{t("shell.shelf.source")}</small><strong>{t("shell.shelf.canonicalEvents")}</strong></span>
          </button>
          {operation.status === "failed" ? (
            <button
              className="tinyos-operation-shelf__retry"
              disabled={!retryCommand.availability.available}
              title={retryCommand.availability.available ? t("shell.shelf.retry") : retryCommand.availability.reason}
              type="button"
              onClick={() => void commandRegistry.execute(retryCommand.id)}
            >
              <RotateCcw aria-hidden="true" size={14} />{t("shell.shelf.retryShort")}
            </button>
          ) : null}
        </>
      ) : <span className="tinyos-operation-shelf__empty">{t("shell.shelf.ready")}</span>}
    </nav>
  );
}

function TinyOsStatus({ status }: { status: ChatStepStatus }) {
  const { t } = useTranslation("tinyos");
  return <span className="tinyos-status" data-status={status}>{status === "completed" ? <Check aria-hidden="true" size={11} /> : <Circle aria-hidden="true" size={9} />}{statusLabel(status, t)}</span>;
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
  const { t } = useTranslation("tinyos");
  const { step } = dialog.entry;
  return (
    <aside aria-label={t("shell.dialog.historical")} className="tinyos-system-dialog tinyos-system-dialog--history">
      <div className="tinyos-system-dialog__heading"><ShieldCheck aria-hidden="true" size={20} /><div><small>{t("shell.dialog.historyLabel")}</small><strong>{step.title}</strong></div></div>
      <p>{t("shell.dialog.historyDescription")}</p>
      <dl>
        <div><dt>{t("shell.dialog.type")}</dt><dd>{dialog.kind}</dd></div>
        <div><dt>{t("shell.dialog.status")}</dt><dd>{statusLabel(step.status, t)}</dd></div>
        <div><dt>{t("shell.dialog.agent")}</dt><dd>{step.agentContext.title}</dd></div>
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

function overlayLabel(overlay: TinyOsShellOverlay, t: TFunction<"tinyos">): string {
  switch (overlay) {
    case "notifications": return t("shell.overlay.notification");
    case "overview": return t("shell.overlay.overview");
    case "palette": return t("shell.overlay.palette");
    case "switcher": return t("shell.overlay.switcher");
  }
}

function appLabel(appId: TinyOsAppId, t: TFunction<"tinyos">): string {
  switch (appId) {
    case "artifacts": return t("shell.apps.artifacts");
    case "browser": return t("shell.apps.browser");
    case "files": return t("shell.apps.files");
    case "inspector": return t("shell.apps.inspector");
    case "plan": return t("shell.apps.plan");
    case "subagents": return t("shell.apps.subagents");
    case "system_monitor": return t("shell.apps.systemMonitor");
    case "terminal": return t("shell.apps.terminal");
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
    case "plan": return "plan";
    case "form": return "inspector";
  }
}

function fileLanguage(path: string): string {
  const parts = fileName(path).split(".");
  const extension = parts[parts.length - 1]?.toLowerCase();
  return ({ css: "CSS", js: "JavaScript", json: "JSON", md: "Markdown", py: "Python", rs: "Rust", ts: "TypeScript", tsx: "TypeScript React" } as Record<string, string>)[extension || ""] || "Text";
}

function terminalCommand(step: ChatStep): string {
  const args = recordValue(step.toolCall?.argsJson);
  return firstString(args.cmd, args.command, args.script, step.toolCall?.argsPreview) || step.title;
}

function terminalOutput(step: ChatStep, t: TFunction<"tinyos">): string {
  const result = recordValue(step.toolCall?.resultJson);
  return firstString(result.stdout, result.output, step.toolCall?.resultPreview)
    || (Object.keys(result).length ? jsonPreview(result) : "")
    || (step.status === "running" ? t("shell.terminal.running") : t("shell.terminal.noOutput"));
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

function terminalMetadata(step: ChatStep, t: TFunction<"tinyos">): { cwd: string; exit: string } {
  const args = recordValue(step.toolCall?.argsJson);
  const result = recordValue(step.toolCall?.resultJson);
  const cwd = firstString(args.cwd, args.directory, args.workdir, args.workingDirectory, args.working_directory);
  const exitCode = [result.exitCode, result.exit_code, result.code].find((value) => typeof value === "number" || typeof value === "string");
  return {
    cwd,
    exit: exitCode !== undefined ? t("shell.terminal.exit", { code: String(exitCode) }) : statusLabel(step.status, t),
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

function browserInteractionCommandInput(input: TinyOsShellCommandInput | undefined, t: TFunction<"tinyos">): BrowserInteractionCommandInput {
  if (!input || typeof input === "string") throw new Error(t("shell.command.browserInput"));
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
  t: TFunction<"tinyos">,
): TinyOsBrowserAction {
  if (kind === "navigate") return { type: "navigate", url: input.url?.trim() || "" };
  if (kind === "type") return { text: input.text || "", type: "type" };
  const x = Number(input.x);
  const y = Number(input.y);
  if (!Number.isFinite(x) || x < 0 || !Number.isFinite(y) || y < 0) {
    throw new Error(t("shell.command.browserCoordinates"));
  }
  return { type: "click", x, y };
}

function statusLabel(status: ChatStepStatus, t?: TFunction<"tinyos">): string {
  if (!t) return status.replace(/_/g, " ");
  switch (status) {
    case "completed": return t("shell.status.completed");
    case "running": return t("shell.status.running");
    case "blocked": return t("shell.status.blocked");
    case "failed": return t("shell.status.failed");
    case "cancelled": return t("shell.status.cancelled");
    default: return t("shell.status.pending");
  }
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
