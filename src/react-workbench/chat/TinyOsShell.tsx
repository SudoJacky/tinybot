import { useEffect, useMemo, useReducer, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import {
  Activity,
  AlertTriangle,
  Archive,
  Bot,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Circle,
  Copy,
  FileCode2,
  FileText,
  Folder,
  FolderOpen,
  Globe2,
  Info,
  ListChecks,
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
import type { TinyOsCommandLifecycle } from "../../app-core/chat/tinyOsCommandGateway";
import type { TinyOsKernelSnapshot } from "../../app-core/chat/tinyOsKernelModel";
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
type TinyOsFileSaveInput = { baseRevision?: string; content: string; createOnly: boolean; path: string };
type TinyOsFileMoveInput = { baseRevision: string; path: string; targetPath: string };
type TinyOsFileDeleteInput = { baseRevision: string; path: string };
type TinyOsTerminalExecuteInput = { command: string; cwd?: string };

export function TinyOsShell({
  activeRunId,
  agentUiForms,
  canCancelRun,
  canCancelTerminal = false,
  canDirectEdit = false,
  canExecuteTerminal = false,
  canPauseRun,
  canRequestChange,
  canResumeRun,
  canRetryRun,
  canSaveFile = false,
  filesController,
  history = false,
  cancelUnavailableReason,
  commandLifecycle,
  onCancelForm,
  onCancelRun,
  onAttachContext,
  onOpenArtifact,
  onAgentRequest,
  onCancelTerminal = async () => undefined,
  onDeleteFile = async () => undefined,
  onExecuteTerminal = async () => undefined,
  onMoveFile = async () => undefined,
  onPauseRun,
  onResolveApproval,
  onRetryOperation,
  onResumeRun,
  onSelectEntry,
  onSubmitForm,
  onSaveFile = async () => undefined,
  resolvingApprovalId,
  requestChangeUnavailableReason,
  directEditUnavailableReason,
  pauseUnavailableReason,
  retryRunId,
  retryUnavailableReason,
  resumeUnavailableReason,
  saveFileUnavailableReason,
  terminalCancelUnavailableReason,
  terminalExecuteUnavailableReason,
  runningTerminalRunId,
  sessionKey,
  submittingFormId,
  snapshot,
  layoutMode,
  workspaceKey,
}: {
  activeRunId?: string;
  agentUiForms: AgentUiForm[];
  canCancelRun: boolean;
  canCancelTerminal?: boolean;
  canDirectEdit?: boolean;
  canExecuteTerminal?: boolean;
  canPauseRun: boolean;
  canRequestChange: boolean;
  canResumeRun: boolean;
  canRetryRun: boolean;
  canSaveFile?: boolean;
  filesController?: TinyOsFilesController;
  history?: boolean;
  cancelUnavailableReason?: string;
  commandLifecycle: TinyOsCommandLifecycle;
  onCancelForm: (form: AgentUiForm) => void;
  onCancelRun: () => void;
  onAttachContext: (reference: TinyOsContextReference) => void;
  onOpenArtifact: (artifact: ArtifactRef) => void;
  onAgentRequest: (reference: TinyOsAgentRequestReference, intent: TinyOsAgentRequestIntent) => void;
  onCancelTerminal?: () => Promise<void>;
  onDeleteFile?: (input: TinyOsFileDeleteInput) => Promise<void>;
  onExecuteTerminal?: (input: TinyOsTerminalExecuteInput) => Promise<void>;
  onMoveFile?: (input: TinyOsFileMoveInput) => Promise<void>;
  onPauseRun: () => void;
  onResolveApproval: (approvalId: string, action: ApprovalAction) => void;
  onRetryOperation: (entry: TinyOsTimelineEntry) => void;
  onResumeRun: () => void;
  onSelectEntry: (entry: TinyOsTimelineEntry) => void;
  onSubmitForm: (form: AgentUiForm, values: Record<string, unknown>) => void;
  onSaveFile?: (input: TinyOsFileSaveInput) => Promise<void>;
  resolvingApprovalId: string;
  requestChangeUnavailableReason?: string;
  directEditUnavailableReason?: string;
  pauseUnavailableReason?: string;
  retryRunId?: string;
  retryUnavailableReason?: string;
  resumeUnavailableReason?: string;
  saveFileUnavailableReason?: string;
  terminalCancelUnavailableReason?: string;
  terminalExecuteUnavailableReason?: string;
  runningTerminalRunId?: string;
  sessionKey?: string;
  submittingFormId?: string;
  snapshot: TinyOsDesktopSnapshot;
  layoutMode: TinyOsLayoutMode;
  workspaceKey: string;
}) {
  const desktopRef = useRef<HTMLElement>(null);
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

  const windows = useMemo(() => {
    const visible = appWindows.filter((window) => (
      !uiState.minimizedAppIds.includes(window.appId)
      && (uiState.layoutMode !== "compact" || window.appId === uiState.focusedAppId)
    ));
    return visible.sort((left, right) => uiState.zOrder.indexOf(left.appId) - uiState.zOrder.indexOf(right.appId));
  }, [appWindows, uiState.focusedAppId, uiState.layoutMode, uiState.minimizedAppIds, uiState.zOrder]);
  const availableApps = new Set(appWindows.map((window) => window.appId));
  const allEntries = snapshot.windows.flatMap((window) => window.entries);
  const systemMonitorControls: TinyOsSystemMonitorControls = {
    activeRunId,
    canCancelRun,
    canPauseRun,
    canResumeRun,
    canRetryRun,
    cancelUnavailableReason,
    commandLifecycle,
    history,
    inspectableItemIds: allEntries.map((entry) => entry.step.id),
    onCancelRun,
    onInspect: (process) => {
      const entry = allEntries.find((candidate) => candidate.step.id === process.correlation.itemId);
      if (!entry) return;
      dispatchUi({ itemId: entry.step.id, type: "inspect" });
    },
    onPauseRun,
    onResumeRun,
    onRetry: (process) => {
      const entry = allEntries.find((candidate) => candidate.step.id === process.correlation.itemId);
      if (entry) onRetryOperation(entry);
    },
    onReveal: (process) => {
      if (process.applicationId && availableApps.has(process.applicationId as TinyOsAppId)) {
        focusApp(process.applicationId as TinyOsAppId);
      }
    },
    pauseUnavailableReason,
    resumeUnavailableReason,
    retryRunId,
    retryUnavailableReason,
    revealableApplicationIds: [...availableApps],
  };
  const inspectorEntries = uiState.inspectorItemIds.flatMap((itemId) => {
    const entry = allEntries.find((candidate) => candidate.step.id === itemId);
    return entry ? [entry] : [];
  });

  function focusApp(appId: TinyOsAppId) {
    if (!availableApps.has(appId)) return;
    dispatchUi({ appId, type: "focus" });
  }

  function minimizeApp(appId: TinyOsAppId) {
    dispatchUi({ appId, type: "minimize" });
  }

  function handleShellKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const digit = event.altKey && !event.ctrlKey ? Number(event.key) : 0;
    if (digit >= 1 && digit <= APP_ORDER.length) {
      const appId = APP_ORDER[digit - 1];
      if (availableApps.has(appId)) {
        event.preventDefault();
        focusApp(appId);
      }
      return;
    }
    if (!event.altKey || !event.ctrlKey || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
    const available = APP_ORDER.filter((appId) => availableApps.has(appId));
    if (!available.length) return;
    const current = Math.max(0, available.indexOf(uiState.focusedAppId ?? available[0]));
    const delta = event.key === "ArrowRight" ? 1 : -1;
    event.preventDefault();
    focusApp(available[(current + delta + available.length) % available.length]);
  }

  return (
    <div className="tinyos-shell" data-has-dialog={snapshot.dialog ? "true" : undefined} onKeyDown={handleShellKeyDown}>
      <section aria-label="TinyOS desktop" className="tinyos-desktop" data-app-count={availableApps.size} data-layout-mode={uiState.layoutMode} ref={desktopRef}>
        <div aria-hidden="true" className="tinyos-desktop__environment">
          <span className="tinyos-desktop__brand"><MonitorDot size={17} /><strong>TinyOS</strong><small>Agent workspace</small></span>
          <span className="tinyos-desktop__mode">{history ? "History snapshot" : "Live workspace"}</span>
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
                onClick={() => focusApp(appId)}
              >
                <Icon aria-hidden="true" size={19} />
                <span>{APP_LABELS[appId]}</span>
                {available ? <Circle aria-hidden="true" className="tinyos-launcher__state" fill="currentColor" size={6} /> : null}
              </button>
            );
          })}
          <span aria-hidden="true" className="tinyos-launcher__divider" />
          <button aria-label="Reset TinyOS layout" className="tinyos-launcher__app tinyos-launcher__reset" title="Reset layout" type="button" onClick={() => dispatchUi({ type: "reset" })}>
            <RotateCcw aria-hidden="true" size={18} />
            <span>Reset</span>
          </button>
        </nav>

        {!windows.length ? <TinyOsDesktopEmpty /> : windows.map((window) => (
          <TinyOsAppWindow
            active={uiState.focusedAppId === window.appId}
            activeTabId={uiState.activeTabs[window.appId]}
            canCancelTerminal={canCancelTerminal && !history}
            canDirectEdit={canDirectEdit && !history}
            canExecuteTerminal={canExecuteTerminal && !history}
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
            onFocus={() => dispatchUi({ appId: window.appId, type: "focus" })}
            onAttachContext={onAttachContext}
            onInspect={(entry) => dispatchUi({ itemId: entry.step.id, type: "inspect" })}
            onMaximize={() => dispatchUi({ appId: window.appId, type: "maximize_toggle" })}
            onMinimize={() => minimizeApp(window.appId)}
            onOpenArtifact={onOpenArtifact}
            onAgentRequest={onAgentRequest}
            onCancelTerminal={onCancelTerminal}
            onDeleteFile={onDeleteFile}
            onExecuteTerminal={onExecuteTerminal}
            onMoveFile={onMoveFile}
            onSaveFile={onSaveFile}
            onSetRect={(rect) => dispatchUi({ appId: window.appId, rect, type: "set_rect" })}
            onSnap={(edge) => dispatchUi({ appId: window.appId, edge, type: "snap" })}
            onTabChange={(tabId) => dispatchUi({ appId: window.appId, tabId, type: "set_active_tab" })}
            requestChangeUnavailableReason={requestChangeUnavailableReason}
            directEditUnavailableReason={history ? "Direct host actions are disabled while viewing History." : directEditUnavailableReason}
            saveFileUnavailableReason={history ? "Direct host actions are disabled while viewing History." : saveFileUnavailableReason}
            terminalCancelUnavailableReason={history ? "Direct host actions are disabled while viewing History." : terminalCancelUnavailableReason}
            terminalExecuteUnavailableReason={history ? "Direct host actions are disabled while viewing History." : terminalExecuteUnavailableReason}
            runningTerminalRunId={runningTerminalRunId}
          />
        ))}

        <TinyOsNotifications
          notifications={snapshot.notifications}
          onSelect={(entry) => {
            const window = snapshot.windows.find((candidate) => candidate.sourceItemIds.includes(entry.step.id));
            if (window) focusApp(window.appId);
            dispatchUi({ itemId: entry.step.id, type: "inspect" });
          }}
        />

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

        {inspectorEntries.length ? (
          <TinyOsInspector
            entries={inspectorEntries}
            onClose={(entry) => dispatchUi({ itemId: entry.step.id, type: "uninspect" })}
            onOpenArtifact={onOpenArtifact}
          />
        ) : null}
      </section>

      <TinyOsOperationShelf canRetryRun={canRetryRun} operations={snapshot.operations} onRetryOperation={onRetryOperation} onSelectEntry={(entry) => {
        const sourceWindow = appWindows.find(({ sourceItemIds }) => sourceItemIds.includes(entry.step.id));
        if (sourceWindow) focusApp(sourceWindow.appId);
        onSelectEntry(entry);
      }} />
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
  canCancelTerminal,
  canDirectEdit,
  canExecuteTerminal,
  canRequestChange,
  canSaveFile,
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
  onOpenArtifact,
  onAgentRequest,
  onCancelTerminal,
  onDeleteFile,
  onExecuteTerminal,
  onMoveFile,
  onSaveFile,
  onSetRect,
  onSnap,
  onTabChange,
  requestChangeUnavailableReason,
  runningTerminalRunId,
  saveFileUnavailableReason,
  systemMonitorControls,
  terminalCancelUnavailableReason,
  terminalExecuteUnavailableReason,
  window,
  zIndex,
}: {
  active: boolean;
  activeTabId?: string;
  canCancelTerminal: boolean;
  canDirectEdit: boolean;
  canExecuteTerminal: boolean;
  canRequestChange: boolean;
  canSaveFile: boolean;
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
  onOpenArtifact: (artifact: ArtifactRef) => void;
  onAgentRequest: (reference: TinyOsAgentRequestReference, intent: TinyOsAgentRequestIntent) => void;
  onCancelTerminal: () => Promise<void>;
  onDeleteFile: (input: TinyOsFileDeleteInput) => Promise<void>;
  onExecuteTerminal: (input: TinyOsTerminalExecuteInput) => Promise<void>;
  onMoveFile: (input: TinyOsFileMoveInput) => Promise<void>;
  onSaveFile: (input: TinyOsFileSaveInput) => Promise<void>;
  onSetRect: (rect: TinyOsWindowRect) => void;
  onSnap: (edge: "left" | "right") => void;
  onTabChange: (tabId: string) => void;
  requestChangeUnavailableReason?: string;
  runningTerminalRunId?: string;
  saveFileUnavailableReason?: string;
  systemMonitorControls: TinyOsSystemMonitorControls;
  terminalCancelUnavailableReason?: string;
  terminalExecuteUnavailableReason?: string;
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
          canCancelTerminal={canCancelTerminal}
          canDirectEdit={canDirectEdit}
          canExecuteTerminal={canExecuteTerminal}
          canRequestChange={canRequestChange}
          canSaveFile={canSaveFile}
          directEditUnavailableReason={directEditUnavailableReason}
          filesController={filesController}
          layoutMode={layoutMode}
          kernel={kernel}
          window={window}
          onAttachContext={onAttachContext}
          onOpenArtifact={onOpenArtifact}
          onAgentRequest={onAgentRequest}
          onCancelTerminal={onCancelTerminal}
          onDeleteFile={onDeleteFile}
          onExecuteTerminal={onExecuteTerminal}
          onMoveFile={onMoveFile}
          onSaveFile={onSaveFile}
          onTabChange={onTabChange}
          requestChangeUnavailableReason={requestChangeUnavailableReason}
          runningTerminalRunId={runningTerminalRunId}
          saveFileUnavailableReason={saveFileUnavailableReason}
          systemMonitorControls={systemMonitorControls}
          terminalCancelUnavailableReason={terminalCancelUnavailableReason}
          terminalExecuteUnavailableReason={terminalExecuteUnavailableReason}
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

function TinyOsAppContent({ activeTabId, canCancelTerminal, canDirectEdit, canExecuteTerminal, canRequestChange, canSaveFile, directEditUnavailableReason, filesController, kernel, layoutMode, window, onAgentRequest, onAttachContext, onCancelTerminal, onDeleteFile, onExecuteTerminal, onMoveFile, onOpenArtifact, onSaveFile, onTabChange, requestChangeUnavailableReason, runningTerminalRunId, saveFileUnavailableReason, systemMonitorControls, terminalCancelUnavailableReason, terminalExecuteUnavailableReason }: {
  activeTabId?: string;
  canCancelTerminal: boolean;
  canDirectEdit: boolean;
  canExecuteTerminal: boolean;
  canRequestChange: boolean;
  canSaveFile: boolean;
  directEditUnavailableReason?: string;
  filesController?: TinyOsFilesController;
  kernel?: TinyOsKernelSnapshot;
  layoutMode: TinyOsLayoutMode;
  onAgentRequest: (reference: TinyOsAgentRequestReference, intent: TinyOsAgentRequestIntent) => void;
  onAttachContext: (reference: TinyOsContextReference) => void;
  onCancelTerminal: () => Promise<void>;
  onDeleteFile: (input: TinyOsFileDeleteInput) => Promise<void>;
  onExecuteTerminal: (input: TinyOsTerminalExecuteInput) => Promise<void>;
  onMoveFile: (input: TinyOsFileMoveInput) => Promise<void>;
  onOpenArtifact: (artifact: ArtifactRef) => void;
  onSaveFile: (input: TinyOsFileSaveInput) => Promise<void>;
  onTabChange: (tabId: string) => void;
  requestChangeUnavailableReason?: string;
  runningTerminalRunId?: string;
  saveFileUnavailableReason?: string;
  systemMonitorControls: TinyOsSystemMonitorControls;
  terminalCancelUnavailableReason?: string;
  terminalExecuteUnavailableReason?: string;
  window: TinyOsWindow;
}) {
  switch (window.appId) {
    case "files": return filesController?.queryAvailable || !window.entries.length
      ? filesController
        ? <TinyOsFilesExplorer canDirectEdit={canDirectEdit} canRequestChange={canRequestChange} canSave={canSaveFile} controller={filesController} directEditUnavailableReason={directEditUnavailableReason} layoutMode={layoutMode} onAttachContext={onAttachContext} onDeleteFile={onDeleteFile} onMoveFile={onMoveFile} onRequestExplanation={(reference) => onAgentRequest(reference, "explain")} onRequestModification={(reference) => onAgentRequest(reference, "modify")} onSaveFile={onSaveFile} requestChangeUnavailableReason={requestChangeUnavailableReason} saveUnavailableReason={saveFileUnavailableReason} />
        : <EmptyCopy text="Workspace Explorer is unavailable." />
      : <TinyOsFiles activeTabId={activeTabId} canRequestChange={canRequestChange} window={window} onAgentRequest={onAgentRequest} onAttachContext={onAttachContext} onTabChange={onTabChange} requestChangeUnavailableReason={requestChangeUnavailableReason} />;
    case "terminal": return <div className="tinyos-terminal-host"><TinyOsTerminalHostControls canCancel={canCancelTerminal} canExecute={canExecuteTerminal} cancelUnavailableReason={terminalCancelUnavailableReason} executeUnavailableReason={terminalExecuteUnavailableReason} onCancel={onCancelTerminal} onExecute={onExecuteTerminal} runningRunId={runningTerminalRunId} />{window.entries.length ? <TinyOsTerminal activeTabId={activeTabId} canRequestChange={canRequestChange} window={window} onAgentRequest={onAgentRequest} onAttachContext={onAttachContext} onTabChange={onTabChange} requestChangeUnavailableReason={requestChangeUnavailableReason} /> : <EmptyCopy text="Run a reviewed command to create canonical terminal output." />}</div>;
    case "browser": return <TinyOsBrowser window={window} onOpenArtifact={onOpenArtifact} />;
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
        <footer className="tinyos-files__status"><span>{fileLanguage(active.path)}</span><span>UTF-8</span>{selectedReference ? <button type="button" onClick={() => onAttachContext(selectedReference)}><Paperclip aria-hidden="true" size={11} />Attach {active.path} · L{selectionStart}{selectionEnd !== selectionStart ? `–${selectionEnd}` : ""}</button> : null}{selectedReference ? <button disabled={!canRequestChange} title={canRequestChange ? "Ask Agent to explain this selection" : requestChangeUnavailableReason} type="button" onClick={() => onAgentRequest(selectedReference, "explain")}><MessageCircleQuestion aria-hidden="true" size={11} />Explain</button> : null}{selectedReference ? <button disabled={!canRequestChange} title={canRequestChange ? "Ask Agent to modify this selection" : requestChangeUnavailableReason} type="button" onClick={() => onAgentRequest(selectedReference, "modify")}><PencilLine aria-hidden="true" size={11} />Modify</button> : null}<span>Canonical item {active.entry.step.sequence + 1}</span></footer>
      </section>
    </div>
  );
}

function TinyOsTerminalHostControls({ canCancel, canExecute, cancelUnavailableReason, executeUnavailableReason, onCancel, onExecute, runningRunId }: {
  canCancel: boolean;
  canExecute: boolean;
  cancelUnavailableReason?: string;
  executeUnavailableReason?: string;
  onCancel: () => Promise<void>;
  onExecute: (input: TinyOsTerminalExecuteInput) => Promise<void>;
  runningRunId?: string;
}) {
  const [command, setCommand] = useState("");
  const [cwd, setCwd] = useState(".");
  const [reviewed, setReviewed] = useState(false);
  const [error, setError] = useState("");
  return (
    <form className="tinyos-terminal-command" onSubmit={(event) => {
      event.preventDefault();
      if (!reviewed || !canExecute || !command.trim()) return;
      setError("");
      void onExecute({ command: command.trim(), ...(cwd.trim() ? { cwd: cwd.trim() } : {}) }).then(() => {
        setCommand("");
        setReviewed(false);
      }).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
    }}>
      <label><span>Command</span><input aria-label="TinyOS terminal command" disabled={!canExecute || Boolean(runningRunId)} placeholder="Enter a workspace command" value={command} onChange={(event) => { setCommand(event.currentTarget.value); setReviewed(false); }} /></label>
      <label><span>cwd</span><input aria-label="TinyOS terminal working directory" disabled={!canExecute || Boolean(runningRunId)} value={cwd} onChange={(event) => { setCwd(event.currentTarget.value); setReviewed(false); }} /></label>
      <div>
        <button disabled={!canExecute || !command.trim() || Boolean(runningRunId)} title={canExecute ? "Review the exact command and execution boundary" : executeUnavailableReason} type="button" onClick={() => setReviewed(true)}>Review command</button>
        <button disabled={!canExecute || !reviewed || !command.trim() || Boolean(runningRunId)} title="Execute read-only with network denied" type="submit"><Play aria-hidden="true" size={12} />Run command</button>
        <button disabled={!canCancel || !runningRunId} title={canCancel ? "Interrupt the correlated TinyOS terminal process" : cancelUnavailableReason} type="button" onClick={() => { setError(""); void onCancel().catch((reason) => setError(reason instanceof Error ? reason.message : String(reason))); }}><Pause aria-hidden="true" size={12} />Cancel process</button>
      </div>
      {reviewed ? <p role="status"><ShieldCheck aria-hidden="true" size={12} />Read-only sandbox · network denied · cwd {cwd || "."}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </form>
  );
}

function TinyOsTerminal({ activeTabId, canRequestChange, onAgentRequest, onAttachContext, onTabChange, requestChangeUnavailableReason, window }: { activeTabId?: string; canRequestChange: boolean; onAgentRequest: (reference: TinyOsAgentRequestReference, intent: TinyOsAgentRequestIntent) => void; onAttachContext: (reference: TinyOsContextReference) => void; onTabChange: (tabId: string) => void; requestChangeUnavailableReason?: string; window: TinyOsWindow }) {
  const active = window.entries.find((entry) => entry.step.id === activeTabId) ?? window.entries[window.entries.length - 1];
  const [follow, setFollow] = useState(true);
  const [query, setQuery] = useState("");
  const [stream, setStream] = useState<"all" | "stdout" | "stderr">("all");
  const [selection, setSelection] = useState<{ anchor: number; end: number }>();
  const [activeMatch, setActiveMatch] = useState(0);
  const outputRef = useRef<HTMLDivElement>(null);
  const stdout = terminalOutput(active.step);
  const stderr = active.step.toolCall?.stderrPreview ?? "";
  const output = stream === "stdout" ? stdout : stream === "stderr" ? stderr : [stdout, stderr].filter(Boolean).join("\n");
  const rawOutputLines = output.split("\n");
  const outputTruncated = rawOutputLines.length > 499;
  const outputLines = [`$ ${terminalCommand(active.step)}`, ...rawOutputLines.slice(-499)];
  const matches = query ? outputLines.flatMap((line, index) => line.toLocaleLowerCase().includes(query.toLocaleLowerCase()) ? [index] : []) : [];
  const currentMatch = matches.length ? matches[Math.min(activeMatch, matches.length - 1)] : undefined;
  const selectionStart = selection ? Math.min(selection.anchor, selection.end) : undefined;
  const selectionEnd = selection ? Math.max(selection.anchor, selection.end) : undefined;
  const selectedText = selectionStart !== undefined && selectionEnd !== undefined
    ? boundedSelectionText(outputLines.slice(selectionStart, selectionEnd + 1).join("\n"))
    : "";
  const selectedReference: TinyOsContextReference | undefined = selectionStart !== undefined && selectionEnd !== undefined ? {
    command: terminalCommand(active.step),
    endLine: selectionEnd + 1,
    kind: "terminal",
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
      <footer><span>{metadata.cwd ? `cwd ${metadata.cwd}` : `Agent ${active.step.agentContext.title}`}</span><span>{metadata.exit}</span><span>{active.step.toolCall?.durationMs !== undefined ? `${active.step.toolCall.durationMs} ms` : statusLabel(active.step.status)}</span>{selectedReference ? <button type="button" onClick={() => onAttachContext(selectedReference)}><Paperclip aria-hidden="true" size={11} />Attach L{selectedReference.startLine}{selectedReference.endLine === selectedReference.startLine ? "" : `–${selectedReference.endLine}`}</button> : <span>{follow ? "Following output" : "Follow paused"}</span>}{selectedReference ? <button disabled={!canRequestChange} title={canRequestChange ? "Ask Agent to explain this output" : requestChangeUnavailableReason} type="button" onClick={() => onAgentRequest(selectedReference, "explain")}><MessageCircleQuestion aria-hidden="true" size={11} />Explain</button> : null}{selectedReference ? <button disabled={!canRequestChange} title={canRequestChange ? "Continue with Agent using this output" : requestChangeUnavailableReason} type="button" onClick={() => onAgentRequest(selectedReference, "follow_up")}><Play aria-hidden="true" size={11} />Continue with Agent</button> : null}{outputTruncated ? <span>Showing last 499 output lines</span> : null}<span>{stream} · Canonical item {active.step.sequence + 1}</span></footer>
    </div>
  );
}

function TinyOsBrowser({ window, onOpenArtifact }: { window: TinyOsWindow; onOpenArtifact: (artifact: ArtifactRef) => void }) {
  const latest = window.entries[window.entries.length - 1];
  const artifacts = latest.step.artifacts ?? [];
  const capture = artifacts.find((artifact) => artifact.kind === "browser_snapshot");
  const image = capture?.preview && safeRasterDataUrl(capture.preview) ? capture.preview : undefined;
  return (
    <div className="tinyos-browser" data-truth={image ? "real_capture" : "structured"}>
      <div className="tinyos-browser__bar"><span /><span /><span /><Globe2 aria-hidden="true" size={13} /><strong>{browserLocation(latest.step)}</strong><b>{image ? "Real capture" : "Structured simulation"}</b></div>
      {image ? <button type="button" onClick={() => capture && onOpenArtifact(capture)}><img alt={capture?.title || "Browser capture"} src={image} /></button> : <div className="tinyos-browser__page"><Globe2 aria-hidden="true" size={28} /><strong>{latest.step.title}</strong><p>{latest.step.summary || "No real browser capture is attached. This is a structured browser view."}</p></div>}
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
  onSelect: (entry: TinyOsTimelineEntry) => void;
}) {
  if (!notifications.length) return null;
  return (
    <aside aria-label="TinyOS notifications" className="tinyos-notifications">
      {notifications.slice(-2).map((notification) => (
        <button data-kind={notification.kind} key={notification.id} type="button" onClick={() => onSelect(notification.entry)}>
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

function TinyOsInspector({ entries, onClose, onOpenArtifact }: { entries: TinyOsTimelineEntry[]; onClose: (entry: TinyOsTimelineEntry) => void; onOpenArtifact: (artifact: ArtifactRef) => void }) {
  return (
    <aside aria-label="TinyOS Inspector" className="tinyos-inspector" data-split={entries.length > 1 ? "true" : undefined}>
      {entries.map((entry) => {
        const artifacts = entry.step.artifacts ?? entry.step.delegate?.artifacts ?? [];
        return (
          <article key={`${entry.turnId}:${entry.step.id}`}>
            <header><div><small>Canonical evidence</small><strong>{entry.step.title}</strong></div><button aria-label={`Close ${entry.step.title} evidence`} type="button" onClick={() => onClose(entry)}><X aria-hidden="true" size={15} /></button></header>
            <TinyOsStatus status={entry.step.status} />
            {entry.step.summary ? <p>{entry.step.summary}</p> : null}
            {entry.step.toolCall ? <dl className="tinyos-inspector__correlation"><div><dt>Tool call</dt><dd>{entry.step.toolCall.id}</dd></div>{entry.step.toolCall.resultRef ? <div><dt>Result ref</dt><dd>{entry.step.toolCall.resultRef}</dd></div> : null}<div><dt>Turn</dt><dd>{entry.turnId}</dd></div><div><dt>Agent</dt><dd>{entry.step.agentContext.title}</dd></div></dl> : null}
            {entry.step.toolCall?.argsJson !== undefined ? <section><strong>Arguments</strong><pre>{sanitizedJsonPreview(entry.step.toolCall.argsJson)}</pre></section> : null}
            {entry.step.toolCall?.resultJson !== undefined ? <section><strong>Result</strong><pre>{sanitizedJsonPreview(entry.step.toolCall.resultJson)}</pre></section> : null}
            {entry.step.toolCall?.resultPreview ? <section><strong>Result preview</strong><pre>{entry.step.toolCall.resultPreview}</pre></section> : null}
            {entry.step.toolCall?.stderrPreview ? <section><strong>Stderr</strong><pre>{entry.step.toolCall.stderrPreview}</pre></section> : null}
            {artifacts.length ? <section><strong>Artifacts</strong>{artifacts.map((artifact) => <button key={artifact.id} type="button" onClick={() => onOpenArtifact(artifact)}>{artifact.title}</button>)}</section> : null}
            <footer>Canonical timeline item {entry.step.sequence + 1} · Agent {entry.step.agentContext.title}</footer>
          </article>
        );
      })}
    </aside>
  );
}

function TinyOsOperationShelf({
  canRetryRun,
  onRetryOperation,
  onSelectEntry,
  operations,
}: {
  canRetryRun: boolean;
  onRetryOperation: (entry: TinyOsTimelineEntry) => void;
  onSelectEntry: (entry: TinyOsTimelineEntry) => void;
  operations: TinyOsDesktopSnapshot["operations"];
}) {
  const operation = operations[operations.length - 1];
  const Icon = operation ? APP_ICONS[operation.appId] : undefined;
  return (
    <nav aria-label="TinyOS recent operations" className="tinyos-operation-shelf">
      {operation && Icon ? (
        <>
          <button className="tinyos-operation-shelf__select" data-status={operation.status} type="button" onClick={() => onSelectEntry(operation.entry)}>
            <span className="tinyos-operation-shelf__state"><Icon aria-hidden="true" size={15} /></span>
            <span><small>Latest canonical operation</small><strong>{operation.title}</strong></span>
            <span><small>Status</small><strong>{statusLabel(operation.status)}</strong></span>
            <span><small>Agent</small><strong>{operation.entry.step.agentContext.title}</strong></span>
            <span><small>Source</small><strong>Canonical events</strong></span>
          </button>
          {operation.status === "failed" ? (
            <button className="tinyos-operation-shelf__retry" disabled={!canRetryRun} type="button" onClick={() => onRetryOperation(operation.entry)}>
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
  return step.toolCall?.resultPreview || jsonPreview(step.toolCall?.resultJson) || (step.status === "running" ? "Running..." : "No output returned.");
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
