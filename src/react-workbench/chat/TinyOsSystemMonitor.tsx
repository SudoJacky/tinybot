import { Activity, Eye, GitBranch, Info, List, Pause, Play, RotateCcw, Search, ShieldCheck, StopCircle } from "lucide-react";
import type { TFunction } from "i18next";
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { isTinyOsCommandInFlight, type TinyOsCommandLifecycle } from "../../app-core/chat/tinyOsCommand";
import type {
  TinyOsKernelSnapshot,
  TinyOsProcess,
  TinyOsResource,
} from "../../app-core/chat/tinyOsKernelModel";
import type { TinyOsProcessState } from "../../app-core/chat/tinyOsKernelContracts";

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
  const { t } = useTranslation("tinyos");
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
        <SummaryStat label={t("monitor.summary.processes")} value={snapshot.processes.length} />
        <SummaryStat label={t("monitor.summary.active")} value={activeCount} />
        <SummaryStat attention={attentionCount > 0} label={t("monitor.summary.attention")} value={attentionCount} />
        <SummaryStat label={t("monitor.summary.sources")} value={sourceCount} />
      </header>

      <div className="tinyos-system-monitor__toolbar">
        <label className="tinyos-system-monitor__search">
          <Search aria-hidden="true" size={13} />
          <span className="sr-only">{t("monitor.search")}</span>
          <input
            aria-label={t("monitor.search")}
            placeholder={t("monitor.searchPlaceholder")}
            type="search"
            value={filters.query}
            onChange={(event) => updateFilter("query", event.currentTarget.value)}
          />
        </label>
        <div aria-label={t("monitor.processView")} className="tinyos-system-monitor__view" role="group">
          <button aria-pressed={view === "tree"} title={t("monitor.processTree")} type="button" onClick={() => setView("tree")}><GitBranch aria-hidden="true" size={13} />{t("monitor.tree")}</button>
          <button aria-pressed={view === "list"} title={t("monitor.processList")} type="button" onClick={() => setView("list")}><List aria-hidden="true" size={13} />{t("monitor.list")}</button>
        </div>
        <MonitorSelect allLabel={t("monitor.all.state")} ariaLabel={t("monitor.filter.state")} value={filters.state} values={options.states} onChange={(value) => updateFilter("state", value)} />
        <MonitorSelect allLabel={t("monitor.all.agent")} ariaLabel={t("monitor.filter.agent")} format={(value) => formatAgent(value, t)} value={filters.agentId} values={options.agents} onChange={(value) => updateFilter("agentId", value)} />
        <MonitorSelect allLabel={t("monitor.all.turn")} ariaLabel={t("monitor.filter.turn")} value={filters.turnId} values={options.turns} onChange={(value) => updateFilter("turnId", value)} />
        <MonitorSelect allLabel={t("monitor.all.operation")} ariaLabel={t("monitor.filter.operation")} value={filters.operationId} values={options.operations} onChange={(value) => updateFilter("operationId", value)} />
        <MonitorSelect allLabel={t("monitor.all.application")} ariaLabel={t("monitor.filter.application")} format={(value) => formatApplication(value, t)} value={filters.applicationId} values={options.applications} onChange={(value) => updateFilter("applicationId", value)} />
      </div>

      <div className="tinyos-system-monitor__body">
        <div className="tinyos-process-list" role="region" aria-label={t("monitor.processes")}>
          <div aria-hidden="true" className="tinyos-process-list__head"><span>{t("monitor.process")}</span><span>{t("monitor.state")}</span><span>{t("monitor.source")}</span></div>
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
          ) : <p className="tinyos-system-monitor__empty">{t("monitor.noMatches")}</p>}
        </div>

        <aside aria-label={t("monitor.details")} className="tinyos-process-detail">
          {selected ? (
            <>
              <header>
                <span><Activity aria-hidden="true" size={14} /><strong>{selected.title}</strong></span>
                <span className="tinyos-process-state" data-state={selected.state}>{formatLabel(selected.state)}</span>
              </header>
              <dl>
                <Detail label={t("monitor.detail.id")} value={selected.id} code />
                <Detail label={t("monitor.detail.kind")} value={formatLabel(selected.kind)} />
                <Detail label={t("monitor.detail.agent")} value={selected.ownerAgentId || t("monitor.unavailableCanonical")} />
                <Detail label={t("monitor.detail.turn")} value={selected.correlation.turnId || t("monitor.unavailable")} code={Boolean(selected.correlation.turnId)} />
                <Detail label={t("monitor.detail.operation")} value={selected.correlation.operationId || t("monitor.unavailable")} code={Boolean(selected.correlation.operationId)} />
                <Detail label={t("monitor.detail.item")} value={selected.correlation.itemId || t("monitor.unavailable")} code={Boolean(selected.correlation.itemId)} />
                <Detail label={t("monitor.detail.toolCall")} value={selected.correlation.toolCallId || t("monitor.unavailable")} code={Boolean(selected.correlation.toolCallId)} />
                <Detail label={t("monitor.detail.window")} value={selected.applicationId ? formatApplication(selected.applicationId, t) : t("monitor.unavailable")} />
              </dl>
              {controls ? (
                <ProcessActions
                  controls={controls}
                  pending={Boolean(commandTargetsSelected && commandLifecycle && isTinyOsCommandInFlight(commandLifecycle))}
                  process={selected}
                />
              ) : null}
              {commandTargetsSelected && commandLifecycle && commandLifecycle.stage !== "idle" ? <CommandState lifecycle={commandLifecycle} /> : null}
              <DetailSection title={t("monitor.provenance")}>
                <p><ShieldCheck aria-hidden="true" size={13} /><span><strong>{formatLabel(selected.provenance.kind)}</strong><code>{selected.provenance.sourceId}</code></span></p>
                <small>{t("monitor.revisionObserved", { revision: selected.provenance.revision ?? t("monitor.unavailableLower"), observed: selected.provenance.observedAt || t("monitor.timeUnavailable") })}</small>
              </DetailSection>
              <DetailSection title={t("monitor.resources", { count: relatedResources.length })}>
                {relatedResources.length ? relatedResources.map((resource) => <p key={resource.id} onContextMenu={(event) => {
                  if (!controls?.onOpenResourceMenu) return;
                  event.preventDefault();
                  controls.onOpenResourceMenu(resource, event.clientX, event.clientY);
                }}><span><strong>{resource.title}</strong><small>{t("monitor.resourceRevision", { kind: formatLabel(resource.kind), revision: resource.revision ?? t("monitor.unavailableLower") })}</small></span></p>) : <small>{t("monitor.noResources")}</small>}
              </DetailSection>
              <DetailSection title={t("monitor.capabilities", { count: relatedCapabilities.length })}>
                {relatedCapabilities.length ? relatedCapabilities.map((capability) => <p key={capability.id}><span><strong>{capability.id}</strong><small>{capability.available ? t("monitor.available") : capability.reason || t("monitor.unavailable")}</small></span></p>) : <small>{t("monitor.noCapabilities")}</small>}
              </DetailSection>
              <DetailSection title={t("monitor.measurements", { count: relatedMetrics.length })}>
                {relatedMetrics.length ? relatedMetrics.map((metric) => <p key={metric.id}><span><strong>{metric.label}</strong><small>{metric.value} {metric.unit || ""} · {formatLabel(metric.provenance.kind)}</small></span></p>) : <small>{t("monitor.noMetrics")}</small>}
              </DetailSection>
              {relatedDiscrepancies.length ? <DetailSection title={t("monitor.discrepancies", { count: relatedDiscrepancies.length })}>{relatedDiscrepancies.map((entry) => <p className="tinyos-process-detail__warning" key={entry.id}><span><strong>{formatLabel(entry.kind)}</strong><small>{entry.message}</small></span></p>)}</DetailSection> : null}
            </>
          ) : <p className="tinyos-system-monitor__empty">{t("monitor.selectProcess")}</p>}
        </aside>
      </div>
    </section>
  );
}

function ProcessActions({ controls, pending, process }: { controls: TinyOsSystemMonitorControls; pending: boolean; process: TinyOsProcess }) {
  const { t } = useTranslation("tinyos");
  const targetsActiveTurn = process.correlation.turnId === controls.activeTurnId;
  const targetsRetryTurn = process.correlation.turnId === controls.retryTurnId;
  const inspectable = Boolean(process.correlation.itemId && controls.inspectableItemIds.includes(process.correlation.itemId));
  const revealable = Boolean(process.applicationId && controls.revealableApplicationIds.includes(process.applicationId));
  const historyReason = controls.history ? t("monitor.historyReadOnly") : undefined;
  const targetReason = targetsActiveTurn ? undefined : t("monitor.notActiveTurn");
  const retryTargetReason = targetsRetryTurn
    ? process.correlation.itemId ? undefined : t("monitor.retryNeedsItem")
    : t("monitor.notRetryTurn");
  return (
    <section aria-label={t("monitor.processControls")} className="tinyos-process-actions">
      <h4>{t("monitor.controls")}</h4>
      <div>
        <ProcessAction available={!pending && !historyReason && !targetReason && controls.canPauseTurn} icon={<Pause aria-hidden="true" size={12} />} label={t("monitor.pause")} reason={pending ? t("monitor.pendingCommand") : historyReason || targetReason || controls.pauseUnavailableReason} onClick={controls.onPauseTurn} />
        <ProcessAction available={!pending && !historyReason && !targetReason && controls.canResumeTurn} icon={<Play aria-hidden="true" size={12} />} label={t("monitor.resume")} reason={pending ? t("monitor.pendingCommand") : historyReason || targetReason || controls.resumeUnavailableReason} onClick={controls.onResumeTurn} />
        <ProcessAction available={!pending && !historyReason && !targetReason && controls.canCancelTurn} icon={<StopCircle aria-hidden="true" size={12} />} label={t("monitor.cancel")} reason={pending ? t("monitor.pendingCommand") : historyReason || targetReason || controls.cancelUnavailableReason} onClick={controls.onCancelTurn} />
        <ProcessAction available={!pending && !historyReason && !retryTargetReason && inspectable && controls.canRetryTurn} icon={<RotateCcw aria-hidden="true" size={12} />} label={t("monitor.retry")} reason={pending ? t("monitor.pendingCommand") : historyReason || retryTargetReason || (!inspectable ? t("monitor.operationUnavailable") : controls.retryUnavailableReason)} onClick={() => controls.onRetry(process)} />
        <ProcessAction available={revealable} icon={<Eye aria-hidden="true" size={12} />} label={t("monitor.reveal")} reason={revealable ? undefined : t("monitor.noApplication")} onClick={() => controls.onReveal(process)} />
        <ProcessAction available={inspectable} icon={<Info aria-hidden="true" size={12} />} label={t("monitor.inspect")} reason={inspectable ? undefined : t("monitor.noEvidence")} onClick={() => controls.onInspect(process)} />
      </div>
    </section>
  );
}

function ProcessAction({ available, icon, label, onClick, reason }: { available: boolean; icon: ReactNode; label: string; onClick: () => void; reason?: string }) {
  const { t } = useTranslation("tinyos");
  return <button disabled={!available} title={available ? label : reason || t("monitor.actionUnavailable", { label })} type="button" onClick={onClick}>{icon}<span>{label}</span></button>;
}

function CommandState({ lifecycle }: { lifecycle: Exclude<TinyOsCommandLifecycle, { stage: "idle" }> }) {
  const { t } = useTranslation("tinyos");
  const kind = formatLabel(lifecycle.command.kind);
  if (lifecycle.stage === "timed_out") return <p className="tinyos-process-command-state" data-state="error" role="alert"><strong>{t("monitor.command.timeout")}</strong><span>{kind} · {lifecycle.error}</span></p>;
  if (lifecycle.stage === "rejected") return <p className="tinyos-process-command-state" data-state="error" role="alert"><strong>{t("monitor.command.rejected")}</strong><span>{kind} · {lifecycle.error}</span></p>;
  if (lifecycle.stage === "completed") return <p className="tinyos-process-command-state" data-state={lifecycle.completion.status === "completed" ? "success" : "error"} role="status"><strong>{formatLabel(lifecycle.completion.status)}</strong><span>{t("monitor.command.completedItem", { kind, item: lifecycle.completion.itemId })}</span></p>;
  if (lifecycle.stage === "acknowledged") return <p className="tinyos-process-command-state" role="status"><strong>{t("monitor.command.acknowledged")}</strong><span>{t("monitor.command.waitingCompletion", { kind })}</span></p>;
  return <p className="tinyos-process-command-state" role="status"><strong>{t("monitor.command.awaiting")}</strong><span>{kind}</span></p>;
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

function MonitorSelect({ allLabel, ariaLabel, format = formatLabel, onChange, value, values }: { allLabel: string; ariaLabel: string; format?: (value: string) => string; onChange: (value: string) => void; value: string; values: string[] }) {
  return <select aria-label={ariaLabel} value={value} onChange={(event) => onChange(event.currentTarget.value)}><option value="">{allLabel}</option>{values.map((option) => <option key={option} value={option}>{format(option)}</option>)}</select>;
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

function formatAgent(value: string, t: TFunction<"tinyos">): string {
  return value === "__unattributed__" ? t("monitor.unattributedAgent") : value;
}

function formatApplication(value: string, t: TFunction<"tinyos">): string {
  return value === "__unattributed__" ? t("monitor.unrelatedApplication") : formatLabel(value);
}

function formatLabel(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function shortId(value: string): string {
  return value.length <= 36 ? value : `…${value.slice(-35)}`;
}
