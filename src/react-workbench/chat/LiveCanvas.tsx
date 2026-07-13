import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { Bell, Bot, ChevronLeft, ChevronRight, Loader2, Maximize2, Minimize2, MonitorDot, PanelRightClose, PanelRightOpen, Pause, Play, RotateCcw, ShieldCheck, StopCircle, X } from "lucide-react";
import type { AgentUiForm } from "../../app-core/agent-ui/agentUiEvents";
import { projectTinyOsDesktop, tinyOsAppForStep, type TinyOsTimelineEntry } from "../../app-core/chat/tinyOsDesktopModel";
import { tinyOsLayoutModeForWidth, type TinyOsAgentRequestIntent, type TinyOsAgentRequestReference, type TinyOsContextReference } from "../../app-core/chat/tinyOsUiState";
import type { ArtifactRef, ChatStep } from "../../app-core/chat/chatRunModel";
import type { ApprovalAction } from "../services";
import { TinyOsShell } from "./TinyOsShell";
import type { TinyOsFilesController } from "./useTinyOsFilesController";
import { isTinyOsCommandInFlight, type TinyOsCommandLifecycle } from "../../app-core/chat/tinyOsCommandGateway";

export type LiveCanvasMode = "live_follow" | "history";
export type LiveCanvasEntry = TinyOsTimelineEntry;

const MIN_TINYOS_WIDTH = 380;
const MAX_TINYOS_WIDTH = 720;
const COMPACT_TINYOS_WIDTH = 480;
const WORKSPACE_TINYOS_WIDTH = 680;
const TINYOS_BOOT_DURATION_MS = 1_000;
let tinyOsBootedInRuntime = false;

export function LiveCanvas({
  agentUiForms,
  canCancelTerminal = false,
  canDirectEdit = false,
  canExecuteTerminal = false,
  canCancelRun,
  canPauseRun,
  canRequestChange,
  canResumeRun,
  canRetryRun,
  canSaveFile = false,
  cancelUnavailableReason,
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
  resumeUnavailableReason,
  runningTerminalRunId,
  saveFileUnavailableReason,
  terminalCancelUnavailableReason,
  terminalExecuteUnavailableReason,
  selection,
  sessionKey,
  widthPx,
  workspaceKey = "desktop-workspace",
}: {
  agentUiForms: AgentUiForm[];
  canCancelTerminal?: boolean;
  canDirectEdit?: boolean;
  canExecuteTerminal?: boolean;
  canCancelRun: boolean;
  canPauseRun: boolean;
  canRequestChange: boolean;
  canResumeRun: boolean;
  canRetryRun: boolean;
  canSaveFile?: boolean;
  cancelUnavailableReason?: string;
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
  resumeUnavailableReason?: string;
  runningTerminalRunId?: string;
  saveFileUnavailableReason?: string;
  terminalCancelUnavailableReason?: string;
  terminalExecuteUnavailableReason?: string;
  selection?: LiveCanvasEntry;
  sessionKey?: string;
  widthPx: number;
  workspaceKey?: string;
}) {
  const snapshot = useMemo(() => projectTinyOsDesktop(entries, {
    itemId: mode === "history" ? selection?.step.id : undefined,
    mode,
    turnId: mode === "history" ? selection?.turnId : undefined,
  }), [entries, mode, selection?.step.id, selection?.turnId]);
  const actionableDialog = Boolean(snapshot.dialog && mode === "live_follow");
  const commandPending = isTinyOsCommandInFlight(commandLifecycle);
  const commandKind = commandLifecycle.stage === "idle" ? "" : commandLifecycle.command.kind;
  const commandLabel = tinyOsLifecycleCommandLabel(commandKind);
  const commandAction = commandLabel.toLocaleLowerCase();
  const submittingFormId = commandLifecycle.stage !== "idle"
    && (commandLifecycle.command.kind === "form.submit" || commandLifecycle.command.kind === "form.cancel")
    && isTinyOsCommandInFlight(commandLifecycle)
    ? commandLifecycle.command.form.formId
    : "";
  const skipBoot = Boolean(snapshot.dialog) || prefersReducedMotion();
  const [booting, setBooting] = useState(() => !tinyOsBootedInRuntime && !skipBoot);
  const dragRef = useRef<{ pointerId: number; startWidth: number; startX: number } | undefined>(undefined);
  const visualEntries = useMemo(() => entries.filter(({ step }) => Boolean(tinyOsAppForStep(step))), [entries]);
  const selectedVisualIndex = mode === "history" && selection
    ? visualEntries.findIndex((entry) => entry.turnId === selection.turnId && entry.step.id === selection.step.id)
    : visualEntries.length - 1;
  const previousEntry = selectedVisualIndex > 0 ? visualEntries[selectedVisualIndex - 1] : undefined;
  const nextEntry = selectedVisualIndex >= 0 && selectedVisualIndex < visualEntries.length - 1 ? visualEntries[selectedVisualIndex + 1] : undefined;

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
    else if (event.key === "End") onWidthChange(MAX_TINYOS_WIDTH);
    else onWidthChange(clampTinyOsWidth(widthPx + (event.key === "ArrowLeft" ? 24 : -24)));
  }

  function toggleWorkspaceWidth() {
    onWidthChange(widthPx <= 520 ? WORKSPACE_TINYOS_WIDTH : COMPACT_TINYOS_WIDTH);
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
          onClick={onClose}
        />
      ) : null}
      <aside aria-label="Live Canvas" className="react-live-canvas tinyos" data-expanded={expanded ? "true" : undefined} data-mode={mode} id="tinybot-live-canvas">
      <div
        aria-label="Resize TinyOS"
        aria-orientation="vertical"
        aria-valuemax={MAX_TINYOS_WIDTH}
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
          <span className="tinyos-truth-badge"><ShieldCheck aria-hidden="true" size={12} />Structured simulation</span>
        </div>
        <div className="tinyos-system-bar__status">
          <span data-live={mode === "live_follow" ? "true" : undefined}>{mode === "live_follow" ? "Live follow" : "History"}</span>
          {snapshot.agentTitle ? <span><Bot aria-hidden="true" size={12} />{snapshot.agentTitle}</span> : null}
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
              disabled={!canPauseRun || commandPending}
              title={commandPending ? "Waiting for runtime confirmation" : canPauseRun ? "Pause at the next safe runtime boundary" : pauseUnavailableReason || "No pausable run"}
              type="button"
              onClick={onPauseRun}
            >
              {commandPending && commandKind === "agent.pause" ? <Loader2 aria-hidden="true" className="tinyos-command-spinner" size={15} /> : <Pause aria-hidden="true" size={15} />}
              <span>{commandPending && commandKind === "agent.pause" ? "Pausing" : "Pause"}</span>
            </button>
          ) : null}
          {mode === "live_follow" ? (
            <button
              aria-label={commandPending && commandKind === "agent.resume" ? "Resume command pending" : "Resume paused Agent run"}
              disabled={!canResumeRun || commandPending}
              title={commandPending ? "Waiting for runtime confirmation" : canResumeRun ? "Resume the same Agent run" : resumeUnavailableReason || "No paused run"}
              type="button"
              onClick={onResumeRun}
            >
              {commandPending && commandKind === "agent.resume" ? <Loader2 aria-hidden="true" className="tinyos-command-spinner" size={15} /> : <Play aria-hidden="true" size={15} />}
              <span>{commandPending && commandKind === "agent.resume" ? "Resuming" : "Resume"}</span>
            </button>
          ) : null}
          {mode === "live_follow" ? (
            <button
              aria-label={commandPending && commandKind === "agent.cancel" ? "Cancel command pending" : "Cancel active Agent run"}
              disabled={!canCancelRun || commandPending}
              title={commandPending ? "Waiting for runtime confirmation" : canCancelRun ? "Cancel active run" : cancelUnavailableReason || "No cancellable run"}
              type="button"
              onClick={onCancelRun}
            >
              {commandPending && commandKind === "agent.cancel" ? <Loader2 aria-hidden="true" className="tinyos-command-spinner" size={15} /> : <StopCircle aria-hidden="true" size={15} />}
              <span>{commandPending && commandKind === "agent.cancel" ? "Cancelling" : "Cancel"}</span>
            </button>
          ) : null}
          <button aria-label="Previous canonical operation" disabled={!previousEntry} title="Previous operation" type="button" onClick={() => previousEntry && onSelectEntry(previousEntry)}><ChevronLeft aria-hidden="true" size={15} /></button>
          <button aria-label="Next canonical operation" disabled={!nextEntry} title="Next operation" type="button" onClick={() => nextEntry && onSelectEntry(nextEntry)}><ChevronRight aria-hidden="true" size={15} /></button>
          {mode === "history" ? (
            <button aria-label="Return to live" title="Return to live" type="button" onClick={onReturnToLive}>
              <RotateCcw aria-hidden="true" size={15} />
              <span>Return to live</span>
            </button>
          ) : null}
          <button
            aria-label={widthPx <= 520 ? "Expand TinyOS workspace" : "Use compact TinyOS workspace"}
            className="tinyos-workspace-toggle"
            title={widthPx <= 520 ? "Workspace layout" : "Compact layout"}
            type="button"
            onClick={toggleWorkspaceWidth}
          >
            {widthPx <= 520 ? <PanelRightOpen aria-hidden="true" size={15} /> : <PanelRightClose aria-hidden="true" size={15} />}
            <span>{widthPx <= 520 ? "Workspace" : "Compact"}</span>
          </button>
          {onExpandedChange ? <button aria-label={expanded ? "Exit expanded TinyOS" : "Expand TinyOS to Chat surface"} title={expanded ? "Exit expanded mode" : "Expanded mode"} type="button" onClick={onExpandedChange}>{expanded ? <Minimize2 aria-hidden="true" size={15} /> : <Maximize2 aria-hidden="true" size={15} />}</button> : null}
          <button aria-label="Close Live Canvas panel" title="Close TinyOS" type="button" onClick={onClose}>
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
        canRequestChange={canRequestChange}
        canRetryRun={canRetryRun}
        canSaveFile={canSaveFile}
        directEditUnavailableReason={directEditUnavailableReason}
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
        onDeleteFile={onDeleteFile}
        onExecuteTerminal={onExecuteTerminal}
        onMoveFile={onMoveFile}
        onResolveApproval={onResolveApproval}
        onRetryOperation={onRetryOperation}
        onSelectEntry={onSelectEntry}
        onSubmitForm={onSubmitForm}
        onSaveFile={onSaveFile}
        requestChangeUnavailableReason={requestChangeUnavailableReason}
        runningTerminalRunId={runningTerminalRunId}
        saveFileUnavailableReason={saveFileUnavailableReason}
        terminalCancelUnavailableReason={terminalCancelUnavailableReason}
        terminalExecuteUnavailableReason={terminalExecuteUnavailableReason}
      />

      {booting ? (
        <div aria-label="TinyOS starting" aria-live="polite" className="tinyos-boot" role="status">
          <div className="tinyos-boot__mark"><MonitorDot aria-hidden="true" size={30} /></div>
          <strong>TinyOS</strong>
          <span>Structured simulation</span>
          <i aria-hidden="true"><b /></i>
        </div>
      ) : null}
      </aside>
    </>
  );
}

export function clampTinyOsWidth(widthPx: number): number {
  return Math.min(MAX_TINYOS_WIDTH, Math.max(MIN_TINYOS_WIDTH, Math.round(widthPx)));
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
