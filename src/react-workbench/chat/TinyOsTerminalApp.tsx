import { useEffect, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Check, ChevronLeft, ChevronRight, Circle, Copy, MessageCircleQuestion, Paperclip, Pause, Play, Search, ShieldCheck } from "lucide-react";
import type { ChatStep, ChatStepStatus } from "../../app-core/chat/chatTurnContracts";
import type { TinyOsCommandLifecycle } from "../../app-core/chat/tinyOsCommand";
import type { TinyOsTimelineEntry, TinyOsWindow } from "../../app-core/chat/tinyOsDesktopModel";
import type { TinyOsKernelSnapshot } from "../../app-core/chat/tinyOsKernelModel";
import { writeTinyOsReferenceTransfer } from "../../app-core/chat/tinyOsReferenceTransfer";
import type { TinyOsShellCommand, TinyOsShellCommandId, TinyOsShellCommandRegistry } from "../../app-core/chat/tinyOsShellCommandRegistry";
import type { TinyOsAgentRequestIntent, TinyOsAgentRequestReference, TinyOsContextReference } from "../../app-core/chat/tinyOsUiState";
import { boundedSelectionText, firstString, jsonPreview, recordValue, statusLabel } from "./tinyOsPresentation";

export function TinyOsTerminalApp({ activeTabId, canRequestChange, commandLifecycle, commandRegistry, kernel, onAgentRequest, onAttachContext, onTabChange, requestChangeUnavailableReason, runningOperationId, window }: {
  activeTabId?: string;
  canRequestChange: boolean;
  commandLifecycle: TinyOsCommandLifecycle;
  commandRegistry: TinyOsShellCommandRegistry;
  kernel?: TinyOsKernelSnapshot;
  onAgentRequest: (reference: TinyOsAgentRequestReference, intent: TinyOsAgentRequestIntent) => void;
  onAttachContext: (reference: TinyOsContextReference) => void;
  onTabChange: (tabId: string) => void;
  requestChangeUnavailableReason?: string;
  runningOperationId?: string;
  window: TinyOsWindow;
}) {
  const { t } = useTranslation("tinyos");
  return <div className="tinyos-terminal-host">
    <TinyOsTerminalHostControls commandLifecycle={commandLifecycle} commandRegistry={commandRegistry} runningOperationId={runningOperationId} />
    {window.entries.length
      ? <TinyOsTerminalTimeline activeTabId={activeTabId} canRequestChange={canRequestChange} kernel={kernel} window={window} onAgentRequest={onAgentRequest} onAttachContext={onAttachContext} onTabChange={onTabChange} requestChangeUnavailableReason={requestChangeUnavailableReason} />
      : <p className="tinyos-empty-copy">{t("shell.emptyCopy.terminal")}</p>}
  </div>;
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

function TinyOsTerminalTimeline({ activeTabId, canRequestChange, kernel, onAgentRequest, onAttachContext, onTabChange, requestChangeUnavailableReason, window }: {
  activeTabId?: string;
  canRequestChange: boolean;
  kernel?: TinyOsKernelSnapshot;
  onAgentRequest: (reference: TinyOsAgentRequestReference, intent: TinyOsAgentRequestIntent) => void;
  onAttachContext: (reference: TinyOsContextReference) => void;
  onTabChange: (tabId: string) => void;
  requestChangeUnavailableReason?: string;
  window: TinyOsWindow;
}) {
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
        <TinyOsTerminalStatus status={active.step.status} />
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

function TinyOsTerminalStatus({ status }: { status: ChatStepStatus }) {
  const { t } = useTranslation("tinyos");
  return <span className="tinyos-status" data-status={status}>{status === "completed" ? <Check aria-hidden="true" size={11} /> : <Circle aria-hidden="true" size={9} />}{statusLabel(status, t)}</span>;
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
  return values.find((candidate): candidate is number => typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0);
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

function requiredShellCommand(
  registry: TinyOsShellCommandRegistry,
  id: TinyOsShellCommandId,
): TinyOsShellCommand {
  const command = registry.get(id);
  if (!command) throw new Error(`Required TinyOS shell command is not registered: ${id}`);
  return command;
}
