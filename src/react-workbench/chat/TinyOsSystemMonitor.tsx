import { Activity, Eye, GitBranch, Info, List, Pause, Play, RotateCcw, Search, ShieldCheck, StopCircle } from "lucide-react";
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";

import { isTinyOsCommandInFlight, type TinyOsCommandLifecycle } from "../../app-core/chat/tinyOsCommandGateway";
import type {
  TinyOsKernelSnapshot,
  TinyOsProcess,
  TinyOsProcessState,
  TinyOsResource,
} from "../../app-core/chat/tinyOsKernelModel";

type TinyOsSystemMonitorFilters = {
  agentId: string;
  applicationId: string;
  operationId: string;
  query: string;
  state: string;
  turnId: string;
};

export type TinyOsProcessRow = {
  depth: number;
  process: TinyOsProcess;
};

export type TinyOsSystemMonitorControls = {
  activeTurnId?: string;
  canCancelTurn: boolean;
  canPauseTurn: boolean;
  canResumeTurn: boolean;
  canRetryTurn: boolean;
  cancelUnavailableReason?: string;
  commandLifecycle: TinyOsCommandLifecycle;
  history: boolean;
  inspectableItemIds: readonly string[];
  onCancelTurn: () => void;
  onInspect: (process: TinyOsProcess) => void;
  onOpenProcessMenu?: (process: TinyOsProcess, clientX: number, clientY: number) => void;
  onOpenResourceMenu?: (resource: TinyOsResource, clientX: number, clientY: number) => void;
  onPauseTurn: () => void;
  onResumeTurn: () => void;
  onRetry: (process: TinyOsProcess) => void;
  onReveal: (process: TinyOsProcess) => void;
  pauseUnavailableReason?: string;
  resumeUnavailableReason?: string;
  retryTurnId?: string;
  retryUnavailableReason?: string;
  revealableApplicationIds: readonly string[];
};

const EMPTY_FILTERS: TinyOsSystemMonitorFilters = {
  agentId: "",
  applicationId: "",
  operationId: "",
  query: "",
  state: "",
  turnId: "",
};

const ATTENTION_STATES = new Set<TinyOsProcessState>(["waiting_for_user", "blocked", "failed", "cancelled"]);

export function TinyOsSystemMonitor({ controls, snapshot }: { controls?: TinyOsSystemMonitorControls; snapshot: TinyOsKernelSnapshot }) {
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [view, setView] = useState<"list" | "tree">("tree");
  const rows = useMemo(
    () => tinyOsSystemMonitorRows(snapshot.processes, filters, view),
    [filters, snapshot.processes, view],
  );
  const [selectedProcessId, setSelectedProcessId] = useState(() => rows[0]?.process.id ?? "");
  const selected = snapshot.processes.find((process) => process.id === selectedProcessId) ?? rows[0]?.process;
  const relatedResources = selected
    ? snapshot.resources.filter((resource) => resource.relatedProcessIds.includes(selected.id))
    : [];
  const relatedMetrics = selected
    ? snapshot.metrics.filter((metric) => metric.processId === selected.id || relatedResources.some((resource) => resource.id === metric.resourceId))
    : [];
  const relatedCapabilities = selected
    ? snapshot.capabilities.filter((capability) => !capability.processId || capability.processId === selected.id)
    : [];
  const relatedDiscrepancies = selected
    ? snapshot.discrepancies.filter((entry) => entry.canonical.entityId === selected.id || entry.native.entityId === selected.id)
    : [];
  const commandLifecycle = controls?.commandLifecycle;
  const commandTargetsSelected = Boolean(selected
    && commandLifecycle
    && commandLifecycle.stage !== "idle"
    && targetIdentity(commandLifecycle.command.target) === processIdentity(selected));
  const activeCount = snapshot.processes.filter((process) => ["queued", "running", "waiting_for_user", "blocked", "paused"].includes(process.state)).length;
  const attentionCount = snapshot.processes.filter((process) => ATTENTION_STATES.has(process.state)).length + snapshot.discrepancies.length;
  const sourceCount = new Set(snapshot.processes.map((process) => `${process.provenance.kind}:${process.provenance.sourceId}`)).size;

  useEffect(() => {
    if (selected && rows.some((row) => row.process.id === selected.id)) return;
    setSelectedProcessId(rows[0]?.process.id ?? "");
  }, [rows, selected]);

  const options = useMemo(() => ({
    agents: uniqueValues(snapshot.processes.map((process) => process.ownerAgentId || "__unattributed__")),
    applications: uniqueValues(snapshot.processes.map((process) => process.applicationId || "__unattributed__")),
    operations: uniqueValues(snapshot.processes.map((process) => process.correlation.operationId).filter(Boolean) as string[]),
    states: uniqueValues(snapshot.processes.map((process) => process.state)),
    turns: uniqueValues(snapshot.processes.map((process) => process.correlation.turnId).filter(Boolean) as string[]),
  }), [snapshot.processes]);

  function updateFilter(key: keyof TinyOsSystemMonitorFilters, value: string) {
    setFilters((current) => ({ ...current, [key]: value }));
  }

  return (
    <section className="tinyos-system-monitor">
      <header className="tinyos-system-monitor__summary">
        <SummaryStat label="Processes" value={snapshot.processes.length} />
        <SummaryStat label="Active" value={activeCount} />
        <SummaryStat attention={attentionCount > 0} label="Attention" value={attentionCount} />
        <SummaryStat label="Evidence sources" value={sourceCount} />
      </header>

      <div className="tinyos-system-monitor__toolbar">
        <label className="tinyos-system-monitor__search">
          <Search aria-hidden="true" size={13} />
          <span className="sr-only">Search processes</span>
          <input
            aria-label="Search processes"
            placeholder="Search process or identity"
            type="search"
            value={filters.query}
            onChange={(event) => updateFilter("query", event.currentTarget.value)}
          />
        </label>
        <div aria-label="Process view" className="tinyos-system-monitor__view" role="group">
          <button aria-pressed={view === "tree"} title="Process tree" type="button" onClick={() => setView("tree")}><GitBranch aria-hidden="true" size={13} />Tree</button>
          <button aria-pressed={view === "list"} title="Process list" type="button" onClick={() => setView("list")}><List aria-hidden="true" size={13} />List</button>
        </div>
        <MonitorSelect ariaLabel="Filter by state" value={filters.state} values={options.states} onChange={(value) => updateFilter("state", value)} />
        <MonitorSelect ariaLabel="Filter by Agent" format={formatAgent} value={filters.agentId} values={options.agents} onChange={(value) => updateFilter("agentId", value)} />
        <MonitorSelect ariaLabel="Filter by turn" value={filters.turnId} values={options.turns} onChange={(value) => updateFilter("turnId", value)} />
        <MonitorSelect ariaLabel="Filter by operation" value={filters.operationId} values={options.operations} onChange={(value) => updateFilter("operationId", value)} />
        <MonitorSelect ariaLabel="Filter by application" format={formatApplication} value={filters.applicationId} values={options.applications} onChange={(value) => updateFilter("applicationId", value)} />
      </div>

      <div className="tinyos-system-monitor__body">
        <div className="tinyos-process-list" role="region" aria-label="TinyOS processes">
          <div aria-hidden="true" className="tinyos-process-list__head"><span>Process</span><span>State</span><span>Source</span></div>
          {rows.length ? (
            <ol>
              {rows.map(({ depth, process }) => (
                <li key={process.id} style={{ "--tinyos-process-depth": depth } as CSSProperties}>
                  <button
                    aria-pressed={selected?.id === process.id}
                    data-selected={selected?.id === process.id ? "true" : undefined}
                    type="button"
                    onClick={() => setSelectedProcessId(process.id)}
                    onContextMenu={(event) => {
                      if (!controls?.onOpenProcessMenu) return;
                      event.preventDefault();
                      controls.onOpenProcessMenu(process, event.clientX, event.clientY);
                    }}
                  >
                    <span className="tinyos-process-list__identity">
                      <Activity aria-hidden="true" size={13} />
                      <span><strong>{process.title}</strong><code>{shortId(process.id)}</code></span>
                    </span>
                    <span className="tinyos-process-state" data-state={process.state}>{formatLabel(process.state)}</span>
                    <span className="tinyos-process-list__source">{formatLabel(process.provenance.kind)}</span>
                  </button>
                </li>
              ))}
            </ol>
          ) : <p className="tinyos-system-monitor__empty">No processes match the current filters.</p>}
        </div>

        <aside aria-label="Process details" className="tinyos-process-detail">
          {selected ? (
            <>
              <header>
                <span><Activity aria-hidden="true" size={14} /><strong>{selected.title}</strong></span>
                <span className="tinyos-process-state" data-state={selected.state}>{formatLabel(selected.state)}</span>
              </header>
              <dl>
                <Detail label="Process ID" value={selected.id} code />
                <Detail label="Kind" value={formatLabel(selected.kind)} />
                <Detail label="Agent" value={selected.ownerAgentId || "Unavailable in canonical data"} />
                <Detail label="Turn" value={selected.correlation.turnId || "Unavailable"} code={Boolean(selected.correlation.turnId)} />
                <Detail label="Operation" value={selected.correlation.operationId || "Unavailable"} code={Boolean(selected.correlation.operationId)} />
                <Detail label="Item" value={selected.correlation.itemId || "Unavailable"} code={Boolean(selected.correlation.itemId)} />
                <Detail label="Tool call" value={selected.correlation.toolCallId || "Unavailable"} code={Boolean(selected.correlation.toolCallId)} />
                <Detail label="Related window" value={selected.applicationId ? formatApplication(selected.applicationId) : "Unavailable"} />
              </dl>
              {controls ? (
                <ProcessActions
                  controls={controls}
                  pending={Boolean(commandTargetsSelected && commandLifecycle && isTinyOsCommandInFlight(commandLifecycle))}
                  process={selected}
                />
              ) : null}
              {commandTargetsSelected && commandLifecycle && commandLifecycle.stage !== "idle" ? <CommandState lifecycle={commandLifecycle} /> : null}
              <DetailSection title="Provenance">
                <p><ShieldCheck aria-hidden="true" size={13} /><span><strong>{formatLabel(selected.provenance.kind)}</strong><code>{selected.provenance.sourceId}</code></span></p>
                <small>Revision {selected.provenance.revision ?? "unavailable"} · Observed {selected.provenance.observedAt || "time unavailable"}</small>
              </DetailSection>
              <DetailSection title={`Resources · ${relatedResources.length}`}>
                {relatedResources.length ? relatedResources.map((resource) => <p key={resource.id} onContextMenu={(event) => {
                  if (!controls?.onOpenResourceMenu) return;
                  event.preventDefault();
                  controls.onOpenResourceMenu(resource, event.clientX, event.clientY);
                }}><span><strong>{resource.title}</strong><small>{formatLabel(resource.kind)} · revision {resource.revision ?? "unavailable"}</small></span></p>) : <small>No related resource observation.</small>}
              </DetailSection>
              <DetailSection title={`Capabilities · ${relatedCapabilities.length}`}>
                {relatedCapabilities.length ? relatedCapabilities.map((capability) => <p key={capability.id}><span><strong>{capability.id}</strong><small>{capability.available ? "Available" : capability.reason || "Unavailable"}</small></span></p>) : <small>No backend capability observation is correlated to this process.</small>}
              </DetailSection>
              <DetailSection title={`Measurements · ${relatedMetrics.length}`}>
                {relatedMetrics.length ? relatedMetrics.map((metric) => <p key={metric.id}><span><strong>{metric.label}</strong><small>{metric.value} {metric.unit || ""} · {formatLabel(metric.provenance.kind)}</small></span></p>) : <small>Runtime metrics unavailable. TinyOS does not estimate CPU, memory, disk, or network usage.</small>}
              </DetailSection>
              {relatedDiscrepancies.length ? <DetailSection title={`Discrepancies · ${relatedDiscrepancies.length}`}>{relatedDiscrepancies.map((entry) => <p className="tinyos-process-detail__warning" key={entry.id}><span><strong>{formatLabel(entry.kind)}</strong><small>{entry.message}</small></span></p>)}</DetailSection> : null}
            </>
          ) : <p className="tinyos-system-monitor__empty">Select a process to inspect its evidence.</p>}
        </aside>
      </div>
    </section>
  );
}

function ProcessActions({ controls, pending, process }: { controls: TinyOsSystemMonitorControls; pending: boolean; process: TinyOsProcess }) {
  const targetsActiveTurn = process.correlation.turnId === controls.activeTurnId;
  const targetsRetryTurn = process.correlation.turnId === controls.retryTurnId;
  const inspectable = Boolean(process.correlation.itemId && controls.inspectableItemIds.includes(process.correlation.itemId));
  const revealable = Boolean(process.applicationId && controls.revealableApplicationIds.includes(process.applicationId));
  const historyReason = controls.history ? "History snapshots are read-only." : undefined;
  const targetReason = targetsActiveTurn ? undefined : "This process is not part of the backend-selected active turn.";
  const retryTargetReason = targetsRetryTurn
    ? process.correlation.itemId ? undefined : "Retry requires a correlated canonical item."
    : "This process is not part of the backend-selected retry turn.";
  return (
    <section aria-label="Process controls" className="tinyos-process-actions">
      <h4>Controls</h4>
      <div>
        <ProcessAction available={!pending && !historyReason && !targetReason && controls.canPauseTurn} icon={<Pause aria-hidden="true" size={12} />} label="Pause turn" reason={pending ? "A command is awaiting runtime confirmation." : historyReason || targetReason || controls.pauseUnavailableReason} onClick={controls.onPauseTurn} />
        <ProcessAction available={!pending && !historyReason && !targetReason && controls.canResumeTurn} icon={<Play aria-hidden="true" size={12} />} label="Resume turn" reason={pending ? "A command is awaiting runtime confirmation." : historyReason || targetReason || controls.resumeUnavailableReason} onClick={controls.onResumeTurn} />
        <ProcessAction available={!pending && !historyReason && !targetReason && controls.canCancelTurn} icon={<StopCircle aria-hidden="true" size={12} />} label="Cancel turn" reason={pending ? "A command is awaiting runtime confirmation." : historyReason || targetReason || controls.cancelUnavailableReason} onClick={controls.onCancelTurn} />
        <ProcessAction available={!pending && !historyReason && !retryTargetReason && inspectable && controls.canRetryTurn} icon={<RotateCcw aria-hidden="true" size={12} />} label="Retry operation" reason={pending ? "A command is awaiting runtime confirmation." : historyReason || retryTargetReason || (!inspectable ? "The canonical operation is unavailable in this view." : controls.retryUnavailableReason)} onClick={() => controls.onRetry(process)} />
        <ProcessAction available={revealable} icon={<Eye aria-hidden="true" size={12} />} label="Reveal app" reason={revealable ? undefined : "No related TinyOS application is available."} onClick={() => controls.onReveal(process)} />
        <ProcessAction available={inspectable} icon={<Info aria-hidden="true" size={12} />} label="Inspect evidence" reason={inspectable ? undefined : "No correlated canonical item is available to inspect."} onClick={() => controls.onInspect(process)} />
      </div>
    </section>
  );
}

function ProcessAction({ available, icon, label, onClick, reason }: { available: boolean; icon: ReactNode; label: string; onClick: () => void; reason?: string }) {
  return <button disabled={!available} title={available ? label : reason || `${label} is unavailable.`} type="button" onClick={onClick}>{icon}<span>{label}</span></button>;
}

function CommandState({ lifecycle }: { lifecycle: Exclude<TinyOsCommandLifecycle, { stage: "idle" }> }) {
  const kind = formatLabel(lifecycle.command.kind);
  if (lifecycle.stage === "timed_out") return <p className="tinyos-process-command-state" data-state="error" role="alert"><strong>Acknowledgement timed out</strong><span>{kind} · {lifecycle.error}</span></p>;
  if (lifecycle.stage === "rejected") return <p className="tinyos-process-command-state" data-state="error" role="alert"><strong>Command rejected</strong><span>{kind} · {lifecycle.error}</span></p>;
  if (lifecycle.stage === "completed") return <p className="tinyos-process-command-state" data-state={lifecycle.completion.status === "completed" ? "success" : "error"} role="status"><strong>{formatLabel(lifecycle.completion.status)}</strong><span>{kind} · canonical item {lifecycle.completion.itemId}</span></p>;
  if (lifecycle.stage === "acknowledged") return <p className="tinyos-process-command-state" role="status"><strong>Command acknowledged</strong><span>{kind} · waiting for completion</span></p>;
  return <p className="tinyos-process-command-state" role="status"><strong>Awaiting runtime confirmation</strong><span>{kind}</span></p>;
}

export function tinyOsSystemMonitorRows(
  processes: readonly TinyOsProcess[],
  filters: TinyOsSystemMonitorFilters,
  view: "list" | "tree",
): TinyOsProcessRow[] {
  const byId = new Map(processes.map((process) => [process.id, process]));
  const matchingIds = new Set(processes.filter((process) => processMatches(process, filters)).map((process) => process.id));
  if (view === "list") return processes.filter((process) => matchingIds.has(process.id)).map((process) => ({ depth: 0, process }));
  const includedIds = new Set(matchingIds);
  for (const id of matchingIds) {
    let parentId = byId.get(id)?.parentProcessId;
    const ancestry = new Set<string>();
    while (parentId && !ancestry.has(parentId)) {
      ancestry.add(parentId);
      includedIds.add(parentId);
      parentId = byId.get(parentId)?.parentProcessId;
    }
  }
  const children = new Map<string, TinyOsProcess[]>();
  for (const process of processes) {
    if (!includedIds.has(process.id) || !process.parentProcessId || !includedIds.has(process.parentProcessId)) continue;
    children.set(process.parentProcessId, [...(children.get(process.parentProcessId) ?? []), process]);
  }
  const rows: TinyOsProcessRow[] = [];
  const visited = new Set<string>();
  function visit(process: TinyOsProcess, depth: number) {
    if (visited.has(process.id)) return;
    visited.add(process.id);
    rows.push({ depth, process });
    for (const child of children.get(process.id) ?? []) visit(child, depth + 1);
  }
  for (const process of processes) {
    if (!includedIds.has(process.id) || process.parentProcessId && includedIds.has(process.parentProcessId)) continue;
    visit(process, 0);
  }
  for (const process of processes) if (includedIds.has(process.id)) visit(process, 0);
  return rows;
}

function processMatches(process: TinyOsProcess, filters: TinyOsSystemMonitorFilters): boolean {
  const query = filters.query.trim().toLowerCase();
  return (!filters.state || process.state === filters.state)
    && (!filters.agentId || (process.ownerAgentId || "__unattributed__") === filters.agentId)
    && (!filters.applicationId || (process.applicationId || "__unattributed__") === filters.applicationId)
    && (!filters.turnId || process.correlation.turnId === filters.turnId)
    && (!filters.operationId || process.correlation.operationId === filters.operationId)
    && (!query || [
      process.id,
      process.title,
      process.kind,
      process.state,
      process.ownerAgentId,
      process.applicationId,
      process.correlation.turnId,
      process.correlation.operationId,
      process.correlation.itemId,
      process.correlation.toolCallId,
    ].some((value) => value?.toLowerCase().includes(query)));
}

function targetIdentity(target: Exclude<TinyOsCommandLifecycle, { stage: "idle" }>["command"]["target"]): string | undefined {
  if ("turnId" in target) return target.turnId;
  if ("operationId" in target) return target.operationId;
  return undefined;
}

function processIdentity(process: TinyOsProcess): string | undefined {
  return process.correlation.turnId ?? process.correlation.operationId;
}

function SummaryStat({ attention = false, label, value }: { attention?: boolean; label: string; value: number }) {
  return <span data-attention={attention ? "true" : undefined}><strong>{value}</strong><small>{label}</small></span>;
}

function MonitorSelect({ ariaLabel, format = formatLabel, onChange, value, values }: { ariaLabel: string; format?: (value: string) => string; onChange: (value: string) => void; value: string; values: string[] }) {
  return <select aria-label={ariaLabel} value={value} onChange={(event) => onChange(event.currentTarget.value)}><option value="">{ariaLabel.replace("Filter by ", "All ")}</option>{values.map((option) => <option key={option} value={option}>{format(option)}</option>)}</select>;
}

function Detail({ code = false, label, value }: { code?: boolean; label: string; value: string }) {
  return <><dt>{label}</dt><dd>{code ? <code>{value}</code> : value}</dd></>;
}

function DetailSection({ children, title }: { children: ReactNode; title: string }) {
  return <section><h4>{title}</h4>{children}</section>;
}

function uniqueValues(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function formatAgent(value: string): string {
  return value === "__unattributed__" ? "Unattributed Agent" : value;
}

function formatApplication(value: string): string {
  return value === "__unattributed__" ? "Unrelated application" : formatLabel(value);
}

function formatLabel(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function shortId(value: string): string {
  return value.length <= 36 ? value : `…${value.slice(-35)}`;
}
