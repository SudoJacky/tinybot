import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { Bell, Bot, Loader2, Maximize2, Minimize2, MonitorDot, Pause, Play, StopCircle, X } from "lucide-react";
import type { AgentUiForm } from "../../app-core/agent-ui/agentUiEvents";
import { projectKernelBackedTinyOsDesktop, projectTinyOsDesktop, type TinyOsDesktopSnapshot, type TinyOsTimelineEntry } from "../../app-core/chat/tinyOsDesktopModel";
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
import { TinyOsTimeMachine } from "./TinyOsTimeMachine";
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
  onSelectBoundary,
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
  onSelectBoundary?: (boundary: TinyOsTimeMachineBoundary) => void;
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
  const agentActivity = tinyOsAgentActivity(snapshot);
  const actionableDialog = Boolean(snapshot.dialog && mode === "live_follow");
  const commandPending = isTinyOsCommandInFlight(commandLifecycle);
  const commandKind = commandLifecycle.stage === "idle" ? "" : commandLifecycle.command.kind;
  const commandLabel = tinyOsLifecycleCommandLabel(commandKind);
  const commandAction = commandLabel.toLocaleLowerCase();
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
  const pauseCommand = runtimeCommandRegistry.get("agent.pause")!;
  const resumeCommand = runtimeCommandRegistry.get("agent.resume")!;
  const cancelCommand = runtimeCommandRegistry.get("agent.cancel")!;
  const submittingFormId = commandLifecycle.stage !== "idle"
    && (commandLifecycle.command.kind === "form.submit" || commandLifecycle.command.kind === "form.cancel")
    && isTinyOsCommandInFlight(commandLifecycle)
    ? commandLifecycle.command.form.formId
    : "";
  const skipBoot = Boolean(snapshot.dialog) || prefersReducedMotion();
  const [booting, setBooting] = useState(() => !tinyOsBootedInRuntime && !skipBoot);
  const dragRef = useRef<{ pointerId: number; startWidth: number; startX: number } | undefined>(undefined);
  const previousBoundary = timeMachineIndex.boundaries[historyEventIndex - 1];
  const nextBoundary = timeMachineIndex.boundaries[historyEventIndex + 1];
  const selectBoundary = (boundary: TinyOsTimeMachineBoundary) => {
    if (onSelectBoundary) {
      onSelectBoundary(boundary);
      return;
    }
    const entry = entries.find((candidate) => candidate.turnId === boundary.turnId && candidate.step.id === boundary.itemId);
    if (entry) onSelectEntry(entry);
  };
  const canvasCommandRegistry = createTinyOsShellCommandRegistry([
    ...runtimeCommandRegistry.commands,
    defineTinyOsShellCommand({
      availability: previousBoundary ? { available: true } : { available: false, reason: "There is no previous canonical event." },
      category: "history",
      dispatch: () => {
        if (previousBoundary) selectBoundary(previousBoundary);
      },
      id: "history.previous",
      input: { kind: "none" },
      keywords: ["previous", "history", "operation"],
      label: "Previous canonical event",
      scope: "local_presentation",
      target: { kind: "shell" },
    }),
    defineTinyOsShellCommand({
      availability: nextBoundary ? { available: true } : { available: false, reason: "There is no next canonical event." },
      category: "history",
      dispatch: () => {
        if (nextBoundary) selectBoundary(nextBoundary);
      },
      id: "history.next",
      input: { kind: "none" },
      keywords: ["next", "history", "operation"],
      label: "Next canonical event",
      scope: "local_presentation",
      target: { kind: "shell" },
    }),
    ...timeMachineIndex.boundaries.map((boundary) => defineTinyOsShellCommand({
      availability: { available: true },
      category: "history",
      dispatch: () => selectBoundary(boundary),
      id: `history.select_event:${boundary.eventIndex}` as const,
      input: { kind: "none" },
      keywords: [boundary.title, boundary.kind, boundary.status, boundary.runId, boundary.turnId, "history", "event"],
      label: `Show event ${boundary.eventIndex + 1}: ${boundary.title}`,
      scope: "local_presentation",
      target: { itemId: boundary.itemId, kind: "history", turnId: boundary.turnId },
    })),
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
        <div className="tinyos-system-bar__status">
          <span data-live={mode === "live_follow" ? "true" : undefined}>{mode === "live_follow" ? "Live workspace" : "History"}</span>
          {mode === "live_follow" ? <span className="tinyos-agent-activity"><Bot aria-hidden="true" size={12} />{agentActivity}</span> : snapshot.agentTitle ? <span><Bot aria-hidden="true" size={12} />{snapshot.agentTitle}</span> : null}
          {snapshot.dialog || snapshot.notifications.length ? <span className="tinyos-attention" title="TinyOS notifications"><Bell aria-hidden="true" size={13} />{actionableDialog ? "Action needed" : snapshot.dialog ? "Historical request" : snapshot.notifications.length}</span> : null}
          {commandLifecycle.stage === "sending" ? <span>Sending {commandAction}…</span> : null}
          {commandLifecycle.stage === "waiting_for_canonical" ? <span>Awaiting runtime</span> : null}
          {commandLifecycle.stage === "acknowledged" ? <span>Command acknowledged</span> : null}
          {commandLifecycle.stage === "completed" ? <span>{commandLabel} complete</span> : null}
          {commandLifecycle.stage === "rejected" || commandLifecycle.stage === "timed_out" ? <span className="tinyos-attention">{commandLabel} issue</span> : null}
          {cancelUnavailableReason && commandLifecycle.stage === "idle" ? <span className="tinyos-attention">{cancelUnavailableReason}</span> : null}
        </div>
        <div className="react-live-canvas__header-actions">
          {mode === "live_follow" ? (
            <button
              aria-label={commandPending && commandKind === "agent.pause" ? "Pause command pending" : "Pause active Agent run"}
              disabled={!pauseCommand.availability.available}
              title={pauseCommand.availability.available ? "Pause at the next safe runtime boundary" : pauseCommand.availability.reason}
              type="button"
              onClick={() => void canvasCommandRegistry.execute(pauseCommand.id)}
            >
              {commandPending && commandKind === "agent.pause" ? <Loader2 aria-hidden="true" className="tinyos-command-spinner" size={15} /> : <Pause aria-hidden="true" size={15} />}
              <span>{commandPending && commandKind === "agent.pause" ? "Pausing" : "Pause"}</span>
            </button>
          ) : null}
          {mode === "live_follow" ? (
            <button
              aria-label={commandPending && commandKind === "agent.resume" ? "Resume command pending" : "Resume paused Agent run"}
              disabled={!resumeCommand.availability.available}
              title={resumeCommand.availability.available ? "Resume the same Agent run" : resumeCommand.availability.reason}
              type="button"
              onClick={() => void canvasCommandRegistry.execute(resumeCommand.id)}
            >
              {commandPending && commandKind === "agent.resume" ? <Loader2 aria-hidden="true" className="tinyos-command-spinner" size={15} /> : <Play aria-hidden="true" size={15} />}
              <span>{commandPending && commandKind === "agent.resume" ? "Resuming" : "Resume"}</span>
            </button>
          ) : null}
          {mode === "live_follow" ? (
            <button
              aria-label={commandPending && commandKind === "agent.cancel" ? "Cancel command pending" : "Cancel active Agent run"}
              disabled={!cancelCommand.availability.available}
              title={cancelCommand.availability.available ? "Cancel active run" : cancelCommand.availability.reason}
              type="button"
              onClick={() => void canvasCommandRegistry.execute(cancelCommand.id)}
            >
              {commandPending && commandKind === "agent.cancel" ? <Loader2 aria-hidden="true" className="tinyos-command-spinner" size={15} /> : <StopCircle aria-hidden="true" size={15} />}
              <span>{commandPending && commandKind === "agent.cancel" ? "Cancelling" : "Cancel"}</span>
            </button>
          ) : null}
          {onExpandedChange ? <button aria-label={expanded ? "Exit expanded TinyOS" : "Expand TinyOS to Chat surface"} title={expanded ? "Exit expanded mode" : "Expanded mode"} type="button" onClick={() => void canvasCommandRegistry.execute("shell.expanded_toggle")}>{expanded ? <Minimize2 aria-hidden="true" size={15} /> : <Maximize2 aria-hidden="true" size={15} />}</button> : null}
          <button aria-label="Close TinyOS desktop" title="Close TinyOS" type="button" onClick={() => void canvasCommandRegistry.execute("shell.close")}>
            <X aria-hidden="true" size={16} />
          </button>
        </div>
      </header>

      <TinyOsTimeMachine
        currentEventIndex={Math.max(0, historyEventIndex)}
        index={timeMachineIndex}
        live={mode === "live_follow"}
        onReturnToLive={() => void canvasCommandRegistry.execute("history.return_live")}
        onSelect={(boundary) => void canvasCommandRegistry.execute(`history.select_event:${boundary.eventIndex}`)}
      />

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

function tinyOsLifecycleCommandLabel(commandKind: string): string {
  switch (commandKind) {
    case "approval.resolve": return "Approval";
    case "form.submit": return "Form submission";
    case "form.cancel": return "Form cancellation";
    case "operation.retry": return "Retry";
    case "agent.request_change": return "Agent request";
    case "agent.pause": return "Pause";
    case "agent.resume": return "Resume";
    case "file.save": return "File save";
    case "file.move": return "File move";
    case "file.delete": return "File deletion";
    case "terminal.execute": return "Terminal execution";
    case "terminal.cancel": return "Terminal cancellation";
    case "browser.interact": return "Browser interaction";
    default: return "Cancellation";
  }
}

function tinyOsAgentActivity(snapshot: TinyOsDesktopSnapshot): string {
  const operation = snapshot.operations[snapshot.operations.length - 1];
  const browserSession = snapshot.kernel?.browserSessions[snapshot.kernel.browserSessions.length - 1];
  const browserTab = browserSession?.tabs.find(({ tabId }) => tabId === browserSession.activeTabId);
  if (!operation) {
    return browserTab?.url && browserTab.url !== "about:blank"
      ? `Browsing ${browserActivityTarget(browserTab.url)}`
      : "Ready to work together";
  }

  const step = operation.entry.step;
  const args = activityRecord(step.toolCall?.argsJson);
  const active = step.status === "pending" || step.status === "running" || step.status === "blocked";
  switch (operation.appId) {
    case "files": {
      const path = activityText(args.path, args.file_path, args.file, args.target_path, operation.title);
      const mutation = /(?:write|save|edit|patch|apply|create|delete|move|rename)/i.test(step.toolCall?.name ?? "");
      return mutation
        ? `${active ? "Updating" : "Updated"} ${activityLabel(path)}`
        : `${active ? "Viewing" : "Viewed"} ${activityLabel(path)}`;
    }
    case "browser": {
      const target = browserTab?.url || activityText(args.url, args.href, operation.title);
      return `Browsing ${browserActivityTarget(target)}`;
    }
    case "terminal": {
      const command = activityText(args.command, args.cmd, args.script, operation.title);
      return `${active ? "Running" : "Ran"} ${activityLabel(command)}`;
    }
    case "artifacts": {
      const artifact = step.artifacts?.[step.artifacts.length - 1]?.title ?? operation.title;
      return `${active ? "Creating" : "Created"} ${activityLabel(artifact)}`;
    }
    case "plan":
      return active ? "Updating the plan" : "Plan updated";
    case "memory":
      return "Reviewing relevant context";
    case "subagents":
      return `Working with ${activityLabel(step.delegate?.title ?? "a subagent")}`;
    default:
      return `${active ? "Working in" : "Finished in"} ${activityLabel(operation.title)}`;
  }
}

function activityRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function activityText(...values: unknown[]): string {
  return values.find((value): value is string => typeof value === "string" && Boolean(value.trim()))?.trim() ?? "workspace";
}

function activityLabel(value: string): string {
  return value.length > 52 ? `${value.slice(0, 49)}…` : value;
}

function browserActivityTarget(value: string): string {
  try {
    const url = new URL(value);
    return activityLabel(url.hostname || value);
  } catch {
    return activityLabel(value);
  }
}
