import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { Maximize2, Minimize2, MonitorDot, Play, Power, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AgentUiForm } from "../../app-core/agent-ui/agentUiEvents";
import { projectKernelBackedTinyOsDesktop, projectTinyOsDesktop } from "../../app-core/chat/tinyOsDesktopModel";
import { tinyOsLayoutModeForWidth, type TinyOsAgentRequestIntent, type TinyOsAgentRequestReference, type TinyOsContextReference } from "../../app-core/chat/tinyOsUiState";
import type { ArtifactRef, BackendAgentTurnItem } from "../../app-core/chat/chatTurnContracts";
import type { TinyOsBrowserAction } from "../../app-core/chat/tinyOsCommand";
import type { TinyOsNativeSnapshot } from "../../app-core/chat/tinyOsNativeSnapshot";
import type { TinyOsBrowserHandoff } from "./TinyOsShell";
import type { TinyOsFilesController } from "./useTinyOsFilesController";
import { isTinyOsCommandInFlight, type TinyOsCommandLifecycle } from "../../app-core/chat/tinyOsCommand";
import { createTinyOsShellCommandRegistry, defineTinyOsShellCommand, type TinyOsShellCommandAvailability } from "../../app-core/chat/tinyOsShellCommandRegistry";
import { createTinyOsTimeMachineIndex, type TinyOsTimeMachineBoundary } from "../../app-core/chat/tinyOsTimeMachine";
import type { NativeBrowserRuntimeApi } from "../../app-core/native/desktopNativeBrowser";
import { DeferredSurface } from "../shell/DeferredSurface";
import {
  clampTinyOsWidth,
  MIN_TINYOS_WIDTH,
  tinyOsMaxWidth,
  type LiveCanvasEntry,
  type LiveCanvasMode,
} from "./liveCanvasModel";

export { clampTinyOsWidth, tinyOsMaxWidth } from "./liveCanvasModel";
export type { LiveCanvasEntry, LiveCanvasMode } from "./liveCanvasModel";

const TINYOS_BOOT_DURATION_MS = 450;
const TINYOS_BOOT_SEEN_STORAGE_KEY = "tinybot.ui.tinyos.boot-seen";
const loadTinyOsShell = () => import("./TinyOsShell").then(({ TinyOsShell }) => ({ default: TinyOsShell }));

export function LiveCanvas({
  activeTurnId,
  agentUiForms,
  canCancelTerminal = false,
  canDirectEdit = false,
  canExecuteTerminal = false,
  canInteractBrowser = false,
  canCancelTurn,
  canPauseTurn,
  canRequestChange,
  canResumeTurn,
  canRetryTurn,
  canSaveFile = false,
  cancelUnavailableReason,
  canonicalItems = [],
  closing = false,
  nativeSnapshots = [],
  pauseUnavailableReason,
  commandLifecycle,
  entries,
  expanded = false,
  filesController,
  headingRef,
  mode,
  onCancelForm,
  onCancelTurn,
  onPauseTurn,
  onAttachContext,
  onClose,
  onExit,
  onExpandedChange,
  onOpenArtifact,
  onAgentRequest,
  onCancelTerminal = async () => undefined,
  onBrowserHandoffComplete = () => undefined,
  onBrowserInteract = async () => undefined,
  onDeleteFile = async () => undefined,
  onExecuteTerminal = async () => undefined,
  onMoveFile = async () => undefined,
  onRetryOperation,
  onReturnToLive,
  onResumeTurn,
  onSelectEntry,
  onSubmitForm,
  onSaveFile = async () => undefined,
  onWidthChange,
  requestChangeUnavailableReason,
  directEditUnavailableReason,
  retryTurnId,
  retryUnavailableReason,
  resumeUnavailableReason,
  runningTerminalOperationId,
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
  activeTurnId?: string;
  agentUiForms: AgentUiForm[];
  canCancelTerminal?: boolean;
  canDirectEdit?: boolean;
  canExecuteTerminal?: boolean;
  canInteractBrowser?: boolean;
  canCancelTurn: boolean;
  canPauseTurn: boolean;
  canRequestChange: boolean;
  canResumeTurn: boolean;
  canRetryTurn: boolean;
  canSaveFile?: boolean;
  cancelUnavailableReason?: string;
  canonicalItems?: BackendAgentTurnItem[];
  closing?: boolean;
  nativeSnapshots?: TinyOsNativeSnapshot[];
  pauseUnavailableReason?: string;
  commandLifecycle: TinyOsCommandLifecycle;
  entries: LiveCanvasEntry[];
  expanded?: boolean;
  filesController?: TinyOsFilesController;
  headingRef: RefObject<HTMLHeadingElement | null>;
  mode: LiveCanvasMode;
  onCancelForm: (form: AgentUiForm) => void;
  onCancelTurn: () => void;
  onPauseTurn: () => void;
  onAttachContext: (reference: TinyOsContextReference) => void;
  onClose: () => void;
  onExit: () => Promise<void>;
  onExpandedChange?: () => void;
  onOpenArtifact: (artifact: ArtifactRef) => void;
  onAgentRequest: (reference: TinyOsAgentRequestReference, intent: TinyOsAgentRequestIntent, fromHistory: boolean) => void;
  onCancelTerminal?: () => Promise<void>;
  onBrowserHandoffComplete?: (input: TinyOsBrowserHandoff) => void;
  onBrowserInteract?: (input: { action: TinyOsBrowserAction; browserSessionId: string; captureId: string; controlEpoch: number; observationRevision: number; tabId: string }) => Promise<void>;
  onDeleteFile?: (input: { baseRevision: string; path: string }) => Promise<void>;
  onExecuteTerminal?: (input: { command: string; cwd?: string }) => Promise<void>;
  onMoveFile?: (input: { baseRevision: string; path: string; targetPath: string }) => Promise<void>;
  onRetryOperation: (entry: LiveCanvasEntry) => void;
  onReturnToLive: () => void;
  onResumeTurn: () => void;
  onSelectEntry: (entry: LiveCanvasEntry) => void;
  onSubmitForm: (form: AgentUiForm, values: Record<string, unknown>) => void;
  onSaveFile?: (input: { baseRevision?: string; content: string; createOnly: boolean; path: string }) => Promise<void>;
  onWidthChange: (widthPx: number) => void;
  requestChangeUnavailableReason?: string;
  directEditUnavailableReason?: string;
  retryTurnId?: string;
  retryUnavailableReason?: string;
  resumeUnavailableReason?: string;
  runningTerminalOperationId?: string;
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
  const { t } = useTranslation("tinyos");
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
    const target = { kind: "turn", turnId: activeTurnId || "unavailable" } as const;
    const availability = (available: boolean, reason?: string): TinyOsShellCommandAvailability => available
      ? { available: true }
      : {
          available: false,
          reason: mode === "history"
            ? t("liveCanvas.historyReadOnly")
            : commandPending
              ? t("liveCanvas.commandPending")
              : reason || t("liveCanvas.commandUnavailable"),
        };
    return createTinyOsShellCommandRegistry([
      defineTinyOsShellCommand({
        availability: availability(mode === "live_follow" && canPauseTurn && !commandPending, pauseUnavailableReason),
        category: "process",
        dispatch: onPauseTurn,
        id: "agent.pause",
        input: { kind: "none" },
        keywords: ["pause", "agent", "turn"],
        label: t("liveCanvas.pauseTurn"),
        scope: "runtime",
        target,
      }),
      defineTinyOsShellCommand({
        availability: availability(mode === "live_follow" && canResumeTurn && !commandPending, resumeUnavailableReason),
        category: "process",
        dispatch: onResumeTurn,
        id: "agent.resume",
        input: { kind: "none" },
        keywords: ["resume", "agent", "turn"],
        label: t("liveCanvas.resumeTurn"),
        scope: "runtime",
        target,
      }),
      defineTinyOsShellCommand({
        availability: availability(mode === "live_follow" && canCancelTurn && !commandPending, cancelUnavailableReason),
        category: "process",
        dispatch: onCancelTurn,
        id: "agent.cancel",
        input: { kind: "none" },
        keywords: ["cancel", "stop", "agent", "turn"],
        label: t("liveCanvas.cancelTurn"),
        scope: "runtime",
        target,
      }),
    ], { simulationMode: mode === "history" ? "history" : "live" });
  }, [activeTurnId, canCancelTurn, canPauseTurn, canResumeTurn, cancelUnavailableReason, commandPending, mode, onCancelTurn, onPauseTurn, onResumeTurn, pauseUnavailableReason, resumeUnavailableReason, t]);
  const submittingFormId = commandLifecycle.stage !== "idle"
    && (commandLifecycle.command.kind === "form.submit" || commandLifecycle.command.kind === "form.cancel")
    && isTinyOsCommandInFlight(commandLifecycle)
    ? commandLifecycle.command.form.formId
    : "";
  const skipBoot = Boolean(snapshot.dialog) || prefersReducedMotion();
  const [booting, setBooting] = useState(() => shouldShowTinyOsBoot(skipBoot));
  const dragRef = useRef<{ pointerId: number; startWidth: number; startX: number } | undefined>(undefined);
  const canvasCommandRegistry = createTinyOsShellCommandRegistry([
    ...runtimeCommandRegistry.commands,
    defineTinyOsShellCommand({
      availability: mode === "history" ? { available: true } : { available: false, reason: t("liveCanvas.alreadyLive") },
      category: "history",
      dispatch: onReturnToLive,
      id: "history.return_live",
      input: { kind: "none" },
      keywords: ["return", "live", "history"],
      label: t("liveCanvas.returnLive"),
      scope: "local_presentation",
      target: { kind: "shell" },
    }),
    defineTinyOsShellCommand({
      availability: onExpandedChange ? { available: true } : { available: false, reason: t("liveCanvas.expandedUnavailable") },
      category: "system",
      dispatch: () => onExpandedChange?.(),
      id: "shell.expanded_toggle",
      input: { kind: "none" },
      keywords: ["expand", "restore", "surface"],
      label: expanded ? t("liveCanvas.exitExpanded") : t("liveCanvas.expand"),
      scope: "local_presentation",
      target: { kind: "shell" },
    }),
    defineTinyOsShellCommand({
      availability: actionableDialog
        ? { available: false, reason: t("liveCanvas.finishRequest") }
        : { available: true },
      category: "system",
      dispatch: onClose,
      id: "shell.close",
      input: { kind: "none" },
      keywords: ["close", "hide", "tinyos"],
      label: t("liveCanvas.close"),
      scope: "local_presentation",
      target: { kind: "shell" },
    }),
    defineTinyOsShellCommand({
      availability: { available: true },
      category: "system",
      dispatch: onExit,
      id: "shell.exit",
      input: { kind: "none" },
      keywords: ["exit", "release", "browser", "tinyos"],
      label: t("liveCanvas.exit"),
      scope: "runtime",
      target: { kind: "shell" },
    }),
  ], { simulationMode: mode === "history" ? "history" : "live" });

  useEffect(() => {
    window.localStorage.setItem(TINYOS_BOOT_SEEN_STORAGE_KEY, "true");
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
        <div aria-hidden="true" className="tinyos-overlay-backdrop" data-state={closing ? "closing" : "open"} />
      ) : !expanded ? (
        <button
          aria-label={t("liveCanvas.closeOverlay")}
          className="tinyos-overlay-backdrop"
          data-state={closing ? "closing" : "open"}
          type="button"
          onClick={() => void canvasCommandRegistry.execute("shell.close")}
        />
      ) : null}
      <aside
        aria-label={t("liveCanvas.sharedDesktop")}
        className="react-live-canvas tinyos"
        data-expanded={expanded ? "true" : undefined}
        data-mode={mode}
        data-state={closing ? "closing" : "open"}
        id="tinybot-live-canvas"
      >
      <div
        aria-label={t("liveCanvas.resize")}
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
          <span className="tinyos-truth-badge">{t("liveCanvas.badge")}</span>
        </div>
        <div className="react-live-canvas__header-actions">
          {mode === "history" ? (
            <button aria-label={t("liveCanvas.returnLiveDesktop")} title={t("liveCanvas.returnSharedDesktop")} type="button" onClick={() => void canvasCommandRegistry.execute("history.return_live")}>
              <Play aria-hidden="true" size={15} />
              <span>{t("liveCanvas.returnLive")}</span>
            </button>
          ) : null}
          {onExpandedChange ? <button aria-label={expanded ? t("liveCanvas.exitExpanded") : t("liveCanvas.expand")} title={expanded ? t("liveCanvas.exitExpandedMode") : t("liveCanvas.expandedMode")} type="button" onClick={() => void canvasCommandRegistry.execute("shell.expanded_toggle")}>{expanded ? <Minimize2 aria-hidden="true" size={15} /> : <Maximize2 aria-hidden="true" size={15} />}</button> : null}
          <button aria-label={t("liveCanvas.exit")} title={t("liveCanvas.exit")} type="button" onClick={() => void canvasCommandRegistry.execute("shell.exit")}>
            <Power aria-hidden="true" size={16} />
          </button>
          <button aria-label={t("liveCanvas.closeDesktop")} title={t("liveCanvas.close")} type="button" onClick={() => void canvasCommandRegistry.execute("shell.close")}>
            <X aria-hidden="true" size={16} />
          </button>
        </div>
      </header>

      <DeferredSurface
        key={sessionKey}
        load={loadTinyOsShell}
        name="TinyOS"
        surfaceProps={{
          agentUiForms,
          browserInteractUnavailableReason,
          browserRuntime,
          canCancelTerminal,
          canDirectEdit,
          canExecuteTerminal,
          canInteractBrowser,
          canRequestChange,
          canRetryTurn,
          canSaveFile,
          commandLifecycle,
          directEditUnavailableReason,
          filesController,
          history: mode === "history",
          layoutMode: tinyOsLayoutModeForWidth(widthPx, expanded),
          onAgentRequest: (reference, intent) => onAgentRequest(reference, intent, mode === "history"),
          onAttachContext,
          onBrowserHandoffComplete,
          onBrowserInteract,
          onCancelForm,
          onCancelTerminal,
          onDeleteFile,
          onExecuteTerminal,
          onMoveFile,
          onOpenArtifact,
          onRetryOperation,
          onSaveFile,
          onSelectEntry,
          onSubmitForm,
          requestChangeUnavailableReason,
          retryTurnId,
          retryUnavailableReason,
          runningTerminalOperationId,
          runtimeCommandRegistry: canvasCommandRegistry,
          saveFileUnavailableReason,
          sessionKey,
          snapshot,
          submittingFormId,
          terminalCancelUnavailableReason,
          terminalExecuteUnavailableReason,
          workspaceKey: filesController?.state.workspaceKey ?? workspaceKey,
        }}
      />

      {booting ? (
        <div aria-label={t("liveCanvas.starting")} aria-live="polite" className="tinyos-boot" role="status">
          <div className="tinyos-boot__mark"><MonitorDot aria-hidden="true" size={30} /></div>
          <strong>TinyOS</strong>
          <span>{t("liveCanvas.badge")}</span>
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

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function shouldShowTinyOsBoot(skipBoot: boolean): boolean {
  return !skipBoot
    && typeof window !== "undefined"
    && window.localStorage.getItem(TINYOS_BOOT_SEEN_STORAGE_KEY) !== "true";
}
