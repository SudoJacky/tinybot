import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { Maximize2, Minimize2, MonitorDot, Play, X } from "lucide-react";
import type { AgentUiForm } from "../../app-core/agent-ui/agentUiEvents";
import { projectKernelBackedTinyOsDesktop, projectTinyOsDesktop, type TinyOsTimelineEntry } from "../../app-core/chat/tinyOsDesktopModel";
import { tinyOsLayoutModeForWidth, type TinyOsAgentRequestIntent, type TinyOsAgentRequestReference, type TinyOsContextReference } from "../../app-core/chat/tinyOsUiState";
import type { ArtifactRef, BackendAgentTurnItem, ChatStep } from "../../app-core/chat/chatRunModel";
import type { TinyOsBrowserAction } from "../../app-core/chat/tinyOsCommandGateway";
import type { TinyOsNativeSnapshot } from "../../app-core/chat/tinyOsNativeSnapshot";
import type { ApprovalAction } from "../services";
import { TinyOsShell } from "./TinyOsShell";
import type { TinyOsFilesController } from "./useTinyOsFilesController";
import { isTinyOsCommandInFlight, type TinyOsCommandLifecycle } from "../../app-core/chat/tinyOsCommandGateway";
import { createTinyOsShellCommandRegistry, defineTinyOsShellCommand, type TinyOsShellCommandAvailability } from "../../app-core/chat/tinyOsShellCommandRegistry";
import { createTinyOsTimeMachineIndex, type TinyOsTimeMachineBoundary } from "../../app-core/chat/tinyOsTimeMachine";
import type { NativeBrowserRuntimeApi } from "../../app-core/native/desktopNativeBrowser";

export type LiveCanvasMode = "live_follow" | "history";
export type LiveCanvasEntry = TinyOsTimelineEntry;

const MIN_TINYOS_WIDTH = 380;
const TINYOS_DESKTOP_RESERVED_WIDTH = 520;
const TINYOS_OVERLAY_RESERVED_WIDTH = 64;
const TINYOS_BOOT_DURATION_MS = 1_000;
let tinyOsBootedInRuntime = false;

export function LiveCanvas({
  activeRunId,
  agentUiForms,
  canCancelTerminal = false,
  canDirectEdit = false,
  canExecuteTerminal = false,
  canInteractBrowser = false,
  canCancelRun,
  canPauseRun,
  canRequestChange,
  canResumeRun,
  canRetryRun,
  canSaveFile = false,
  cancelUnavailableReason,
  canonicalItems = [],
  nativeSnapshots = [],
  pauseUnavailableReason,
  commandLifecycle,
  entries,
  expanded = false,
  filesController,
  headingRef,
  mode,
  onCancelForm,
  onCancelRun,
  onPauseRun,
  onAttachContext,
  onClose,
  onExpandedChange,
  onOpenArtifact,
  onAgentRequest,
  onCancelTerminal = async () => undefined,
  onBrowserInteract = async () => undefined,
  onDeleteFile = async () => undefined,
  onExecuteTerminal = async () => undefined,
  onMoveFile = async () => undefined,
  onResolveApproval,
  onRetryOperation,
  onReturnToLive,
  onResumeRun,
  onSelectEntry,
  onSubmitForm,
  onSaveFile = async () => undefined,
  onWidthChange,
  resolvingApprovalId,
  requestChangeUnavailableReason,
  directEditUnavailableReason,
  retryRunId,
  retryUnavailableReason,
  resumeUnavailableReason,
  runningTerminalRunId,
  saveFileUnavailableReason,
  terminalCancelUnavailableReason,
  terminalExecuteUnavailableReason,
  browserInteractUnavailableReason,
  browserRuntime,
  selection,
  selectionEventIndex,
  sessionKey,
  widthPx,
  workspaceKey = "desktop-workspace",
}: {
  activeRunId?: string;
  agentUiForms: AgentUiForm[];
  canCancelTerminal?: boolean;
  canDirectEdit?: boolean;
  canExecuteTerminal?: boolean;
  canInteractBrowser?: boolean;
  canCancelRun: boolean;
  canPauseRun: boolean;
  canRequestChange: boolean;
  canResumeRun: boolean;
  canRetryRun: boolean;
  canSaveFile?: boolean;
  cancelUnavailableReason?: string;
  canonicalItems?: BackendAgentTurnItem[];
  nativeSnapshots?: TinyOsNativeSnapshot[];
  pauseUnavailableReason?: string;
  commandLifecycle: TinyOsCommandLifecycle;
  entries: LiveCanvasEntry[];
  expanded?: boolean;
  filesController?: TinyOsFilesController;
  headingRef: RefObject<HTMLHeadingElement | null>;
  mode: LiveCanvasMode;
  onCancelForm: (form: AgentUiForm) => void;
  onCancelRun: () => void;
  onPauseRun: () => void;
  onAttachContext: (reference: TinyOsContextReference) => void;
  onClose: () => void;
  onExpandedChange?: () => void;
  onOpenArtifact: (artifact: ArtifactRef) => void;
  onAgentRequest: (reference: TinyOsAgentRequestReference, intent: TinyOsAgentRequestIntent, fromHistory: boolean) => void;
  onCancelTerminal?: () => Promise<void>;
  onBrowserInteract?: (input: { action: TinyOsBrowserAction; browserSessionId: string; captureId: string; controlEpoch: number; observationRevision: number; tabId: string }) => Promise<void>;
  onDeleteFile?: (input: { baseRevision: string; path: string }) => Promise<void>;
  onExecuteTerminal?: (input: { command: string; cwd?: string }) => Promise<void>;
  onMoveFile?: (input: { baseRevision: string; path: string; targetPath: string }) => Promise<void>;
  onResolveApproval: (approvalId: string, action: ApprovalAction) => void;
  onRetryOperation: (entry: LiveCanvasEntry) => void;
  onReturnToLive: () => void;
  onResumeRun: () => void;
  onSelectEntry: (entry: LiveCanvasEntry) => void;
  onSubmitForm: (form: AgentUiForm, values: Record<string, unknown>) => void;
  onSaveFile?: (input: { baseRevision?: string; content: string; createOnly: boolean; path: string }) => Promise<void>;
  onWidthChange: (widthPx: number) => void;
  resolvingApprovalId: string;
  requestChangeUnavailableReason?: string;
  directEditUnavailableReason?: string;
  retryRunId?: string;
  retryUnavailableReason?: string;
  resumeUnavailableReason?: string;
  runningTerminalRunId?: string;
  saveFileUnavailableReason?: string;
  terminalCancelUnavailableReason?: string;
  terminalExecuteUnavailableReason?: string;
  browserInteractUnavailableReason?: string;
  browserRuntime?: NativeBrowserRuntimeApi;
  selection?: LiveCanvasEntry;
  selectionEventIndex?: number;
  sessionKey?: string;
  widthPx: number;
  workspaceKey?: string;
}) {
  const timeMachineIndex = useMemo(() => createTinyOsTimeMachineIndex(canonicalItems), [canonicalItems]);
  const historyEventIndex = mode === "history"
    ? resolveHistoryEventIndex(timeMachineIndex.boundaries, selectionEventIndex, selection)
    : timeMachineIndex.eventCount - 1;
  const historyBoundary = timeMachineIndex.boundaries[historyEventIndex];
  const snapshot = useMemo(() => {
    const cursor = mode === "history" && historyBoundary
      ? {
          eventIndex: historyBoundary.eventIndex,
          itemId: historyBoundary.itemId,
          mode,
          runId: historyBoundary.runId,
          turnId: historyBoundary.turnId,
        } as const
      : {
          itemId: mode === "history" ? selection?.step.id : undefined,
          mode,
          turnId: mode === "history" ? selection?.turnId : undefined,
        } as const;
    return canonicalItems.length || nativeSnapshots.length || (entries.length === 0 && mode === "live_follow")
      ? projectKernelBackedTinyOsDesktop(entries, canonicalItems, cursor, { nativeSnapshots })
      : projectTinyOsDesktop(entries, cursor);
  }, [canonicalItems, entries, historyBoundary, mode, nativeSnapshots, selection?.step.id, selection?.turnId]);
  const actionableDialog = Boolean(snapshot.dialog && mode === "live_follow");
  const commandPending = isTinyOsCommandInFlight(commandLifecycle);
  const runtimeCommandRegistry = useMemo(() => {
    const target = { kind: "run", runId: activeRunId || "unavailable" } as const;
    const availability = (available: boolean, reason?: string): TinyOsShellCommandAvailability => available
      ? { available: true }
      : {
          available: false,
          reason: mode === "history"
            ? "History snapshots are read-only."
            : commandPending
              ? "A command is awaiting runtime confirmation."
              : reason || "The backend reports that this command is unavailable.",
        };
    return createTinyOsShellCommandRegistry([
      defineTinyOsShellCommand({
        availability: availability(mode === "live_follow" && canPauseRun && !commandPending, pauseUnavailableReason),
        category: "process",
        dispatch: onPauseRun,
        id: "agent.pause",
        input: { kind: "none" },
        keywords: ["pause", "agent", "run"],
        label: "Pause active Agent run",
        scope: "runtime",
        target,
      }),
      defineTinyOsShellCommand({
        availability: availability(mode === "live_follow" && canResumeRun && !commandPending, resumeUnavailableReason),
        category: "process",
        dispatch: onResumeRun,
        id: "agent.resume",
        input: { kind: "none" },
        keywords: ["resume", "agent", "run"],
        label: "Resume paused Agent run",
        scope: "runtime",
        target,
      }),
      defineTinyOsShellCommand({
        availability: availability(mode === "live_follow" && canCancelRun && !commandPending, cancelUnavailableReason),
        category: "process",
        dispatch: onCancelRun,
        id: "agent.cancel",
        input: { kind: "none" },
        keywords: ["cancel", "stop", "agent", "run"],
        label: "Cancel active Agent run",
        scope: "runtime",
        target,
      }),
    ], { simulationMode: mode === "history" ? "history" : "live" });
  }, [activeRunId, canCancelRun, canPauseRun, canResumeRun, cancelUnavailableReason, commandPending, mode, onCancelRun, onPauseRun, onResumeRun, pauseUnavailableReason, resumeUnavailableReason]);
  const submittingFormId = commandLifecycle.stage !== "idle"
    && (commandLifecycle.command.kind === "form.submit" || commandLifecycle.command.kind === "form.cancel")
    && isTinyOsCommandInFlight(commandLifecycle)
    ? commandLifecycle.command.form.formId
    : "";
  const skipBoot = Boolean(snapshot.dialog) || prefersReducedMotion();
  const [booting, setBooting] = useState(() => !tinyOsBootedInRuntime && !skipBoot);
  const dragRef = useRef<{ pointerId: number; startWidth: number; startX: number } | undefined>(undefined);
  const canvasCommandRegistry = createTinyOsShellCommandRegistry([
    ...runtimeCommandRegistry.commands,
    defineTinyOsShellCommand({
      availability: mode === "history" ? { available: true } : { available: false, reason: "TinyOS is already following Live." },
      category: "history",
      dispatch: onReturnToLive,
      id: "history.return_live",
      input: { kind: "none" },
      keywords: ["return", "live", "history"],
      label: "Return to live",
      scope: "local_presentation",
      target: { kind: "shell" },
    }),
    defineTinyOsShellCommand({
      availability: onExpandedChange ? { available: true } : { available: false, reason: "Expanded TinyOS is unavailable on this surface." },
      category: "system",
      dispatch: () => onExpandedChange?.(),
      id: "shell.expanded_toggle",
      input: { kind: "none" },
      keywords: ["expand", "restore", "surface"],
      label: expanded ? "Exit expanded TinyOS" : "Expand TinyOS to Chat surface",
      scope: "local_presentation",
      target: { kind: "shell" },
    }),
    defineTinyOsShellCommand({
      availability: actionableDialog
        ? { available: false, reason: "Finish the active TinyOS system request before closing." }
        : { available: true },
      category: "system",
      dispatch: onClose,
      id: "shell.close",
      input: { kind: "none" },
      keywords: ["close", "hide", "tinyos"],
      label: "Close TinyOS",
      scope: "local_presentation",
      target: { kind: "shell" },
    }),
  ], { simulationMode: mode === "history" ? "history" : "live" });

  useEffect(() => {
    tinyOsBootedInRuntime = true;
    if (!booting || skipBoot) {
      setBooting(false);
      return;
    }
    const timer = window.setTimeout(() => setBooting(false), TINYOS_BOOT_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [booting, skipBoot]);

  function handleResizePointerDown(event: PointerEvent<HTMLDivElement>) {
    dragRef.current = { pointerId: event.pointerId, startWidth: widthPx, startX: event.clientX };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handleResizePointerMove(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    onWidthChange(clampTinyOsWidth(drag.startWidth + drag.startX - event.clientX));
  }

  function handleResizePointerUp(event: PointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function handleResizeKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    if (event.key === "Home") onWidthChange(MIN_TINYOS_WIDTH);
    else if (event.key === "End") onWidthChange(tinyOsMaxWidth());
    else onWidthChange(clampTinyOsWidth(widthPx + (event.key === "ArrowLeft" ? 24 : -24)));
  }

  return (
    <>
      {!expanded && actionableDialog ? (
        <div aria-hidden="true" className="tinyos-overlay-backdrop" />
      ) : !expanded ? (
        <button
          aria-label="Close TinyOS overlay"
          className="tinyos-overlay-backdrop"
          type="button"
          onClick={() => void canvasCommandRegistry.execute("shell.close")}
        />
      ) : null}
      <aside aria-label="TinyOS shared desktop" className="react-live-canvas tinyos" data-expanded={expanded ? "true" : undefined} data-mode={mode} id="tinybot-live-canvas">
      <div
        aria-label="Resize TinyOS"
        aria-orientation="vertical"
        aria-valuemax={tinyOsMaxWidth()}
        aria-valuemin={MIN_TINYOS_WIDTH}
        aria-valuenow={Math.round(widthPx)}
        className="tinyos-resize-handle"
        role="separator"
        tabIndex={0}
        onKeyDown={handleResizeKeyDown}
        onPointerDown={handleResizePointerDown}
        onPointerMove={handleResizePointerMove}
        onPointerUp={handleResizePointerUp}
      />
      <header className="react-live-canvas__header tinyos-system-bar">
        <div className="tinyos-system-bar__identity">
          <MonitorDot aria-hidden="true" size={17} />
          <h2 ref={headingRef} tabIndex={-1}>TinyOS</h2>
          <span className="tinyos-truth-badge">Shared desktop</span>
        </div>
        <div className="react-live-canvas__header-actions">
          {mode === "history" ? (
            <button aria-label="Return to live desktop" title="Return to the shared desktop" type="button" onClick={() => void canvasCommandRegistry.execute("history.return_live")}>
              <Play aria-hidden="true" size={15} />
              <span>Return to Live</span>
            </button>
          ) : null}
          {onExpandedChange ? <button aria-label={expanded ? "Exit expanded TinyOS" : "Expand TinyOS to Chat surface"} title={expanded ? "Exit expanded mode" : "Expanded mode"} type="button" onClick={() => void canvasCommandRegistry.execute("shell.expanded_toggle")}>{expanded ? <Minimize2 aria-hidden="true" size={15} /> : <Maximize2 aria-hidden="true" size={15} />}</button> : null}
          <button aria-label="Close TinyOS desktop" title="Close TinyOS" type="button" onClick={() => void canvasCommandRegistry.execute("shell.close")}>
            <X aria-hidden="true" size={16} />
          </button>
        </div>
      </header>

      <TinyOsShell
        key={sessionKey}
        agentUiForms={agentUiForms}
        canCancelTerminal={canCancelTerminal}
        canDirectEdit={canDirectEdit}
        canExecuteTerminal={canExecuteTerminal}
        canInteractBrowser={canInteractBrowser}
        canRequestChange={canRequestChange}
        canRetryRun={canRetryRun}
        canSaveFile={canSaveFile}
        commandLifecycle={commandLifecycle}
        directEditUnavailableReason={directEditUnavailableReason}
        browserInteractUnavailableReason={browserInteractUnavailableReason}
        browserRuntime={browserRuntime}
        filesController={filesController}
        history={mode === "history"}
        onAttachContext={onAttachContext}
        resolvingApprovalId={resolvingApprovalId}
        submittingFormId={submittingFormId}
        snapshot={snapshot}
        layoutMode={tinyOsLayoutModeForWidth(widthPx, expanded)}
        sessionKey={sessionKey}
        workspaceKey={filesController?.state.workspaceKey ?? workspaceKey}
        onCancelForm={onCancelForm}
        onOpenArtifact={onOpenArtifact}
        onAgentRequest={(reference, intent) => onAgentRequest(reference, intent, mode === "history")}
        onCancelTerminal={onCancelTerminal}
        onBrowserInteract={onBrowserInteract}
        onDeleteFile={onDeleteFile}
        onExecuteTerminal={onExecuteTerminal}
        onMoveFile={onMoveFile}
        onResolveApproval={onResolveApproval}
        onRetryOperation={onRetryOperation}
        onSelectEntry={onSelectEntry}
        onSubmitForm={onSubmitForm}
        onSaveFile={onSaveFile}
        requestChangeUnavailableReason={requestChangeUnavailableReason}
        runtimeCommandRegistry={canvasCommandRegistry}
        retryRunId={retryRunId}
        retryUnavailableReason={retryUnavailableReason}
        runningTerminalRunId={runningTerminalRunId}
        saveFileUnavailableReason={saveFileUnavailableReason}
        terminalCancelUnavailableReason={terminalCancelUnavailableReason}
        terminalExecuteUnavailableReason={terminalExecuteUnavailableReason}
      />

      {booting ? (
        <div aria-label="TinyOS starting" aria-live="polite" className="tinyos-boot" role="status">
          <div className="tinyos-boot__mark"><MonitorDot aria-hidden="true" size={30} /></div>
          <strong>TinyOS</strong>
          <span>Shared desktop</span>
          <i aria-hidden="true"><b /></i>
        </div>
      ) : null}
      </aside>
    </>
  );
}

function resolveHistoryEventIndex(
  boundaries: readonly TinyOsTimeMachineBoundary[],
  requestedEventIndex: number | undefined,
  selection: LiveCanvasEntry | undefined,
): number {
  if (requestedEventIndex !== undefined && boundaries[requestedEventIndex]) return requestedEventIndex;
  for (let index = boundaries.length - 1; index >= 0; index -= 1) {
    const boundary = boundaries[index];
    if (boundary.itemId === selection?.step.id && boundary.turnId === selection.turnId) return index;
  }
  return boundaries.length - 1;
}

export function clampTinyOsWidth(widthPx: number, viewportWidth = currentViewportWidth()): number {
  return Math.min(tinyOsMaxWidth(viewportWidth), Math.max(MIN_TINYOS_WIDTH, Math.round(widthPx)));
}

function tinyOsMaxWidth(viewportWidth = currentViewportWidth()): number {
  const reservedWidth = viewportWidth >= 1_280
    ? TINYOS_DESKTOP_RESERVED_WIDTH
    : TINYOS_OVERLAY_RESERVED_WIDTH;
  return Math.max(MIN_TINYOS_WIDTH, Math.floor(viewportWidth - reservedWidth));
}

function currentViewportWidth(): number {
  return typeof window === "undefined" ? 1_240 : window.innerWidth;
}

export function liveCanvasEntryForStep(turnId: string, step: ChatStep): LiveCanvasEntry {
  return { step, turnId };
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
