import { Archive, Download, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  DiagnosticBundleExportResult,
  PerformanceTraceExportResult,
  PerformanceTraceDuration,
  PerformanceTraceSnapshot,
} from "../../app-core/native/desktopNativePerformanceTrace";
import {
  isRendererDiagnosticModeEnabled,
  logRendererEvent,
  setRendererDiagnosticModeEnabled,
} from "../../app-core/native/rendererLogger";
import type { AppServices } from "../services";
import "./PerformanceTraceRoute.css";

type TraceState =
  | { status: "loading" }
  | { status: "ready"; snapshot: PerformanceTraceSnapshot }
  | { status: "failed"; error: Error };

export default function PerformanceTraceRoute({ services }: { services: AppServices }) {
  const { t } = useTranslation("common");
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<TraceState>({ status: "loading" });
  const [exportError, setExportError] = useState<Error | null>(null);
  const [snapshotExporting, setSnapshotExporting] = useState(false);
  const [snapshotResult, setSnapshotResult] = useState<PerformanceTraceExportResult | null>(null);
  const [bundleExporting, setBundleExporting] = useState(false);
  const [bundleResult, setBundleResult] = useState<DiagnosticBundleExportResult | null>(null);
  const [diagnosticModeEnabled, setDiagnosticModeEnabled] = useState(isRendererDiagnosticModeEnabled);
  const performanceStore = services.performanceStore;

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    if (!performanceStore) {
      setState({ status: "failed", error: new Error(t("performanceTrace.unavailable")) });
      return () => {
        cancelled = true;
      };
    }
    void performanceStore.load()
      .then((snapshot) => {
        if (!cancelled) setState({ status: "ready", snapshot });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        const error = cause instanceof Error ? cause : new Error(String(cause));
        console.error("[tinybot-performance-trace]", { attempt: attempt + 1, error });
        setState({ status: "failed", error });
      });
    return () => {
      cancelled = true;
    };
  }, [attempt, performanceStore, t]);

  const refresh = () => {
    setExportError(null);
    setSnapshotResult(null);
    setBundleResult(null);
    setAttempt((value) => value + 1);
  };

  const exportSnapshot = async () => {
    if (!performanceStore || state.status !== "ready") return;
    setExportError(null);
    setSnapshotResult(null);
    setBundleResult(null);
    setSnapshotExporting(true);
    try {
      const result = await performanceStore.exportSnapshot(state.snapshot);
      if (result) {
        setSnapshotResult(result);
        logRendererEvent("info", "performance_trace.snapshot.exported");
      }
    } catch (cause: unknown) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      logRendererEvent("error", "performance_trace.snapshot.export_failed", { error });
      setExportError(error);
    } finally {
      setSnapshotExporting(false);
    }
  };

  const exportDiagnosticBundle = async () => {
    if (!performanceStore || state.status !== "ready") return;
    setExportError(null);
    setSnapshotResult(null);
    setBundleResult(null);
    setBundleExporting(true);
    try {
      const result = await performanceStore.exportDiagnosticBundle();
      if (result) {
        setBundleResult(result);
        logRendererEvent("info", "diagnostics.bundle.exported", {
          includedFileCount: result.includedFiles.length,
          sizeBytes: result.sizeBytes,
        });
      }
    } catch (cause: unknown) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      logRendererEvent("error", "diagnostics.bundle.export_failed", { error });
      setExportError(error);
    } finally {
      setBundleExporting(false);
    }
  };

  const toggleDiagnosticMode = (enabled: boolean) => {
    setExportError(null);
    setBundleResult(null);
    try {
      if (enabled) {
        setRendererDiagnosticModeEnabled(true);
        logRendererEvent("info", "diagnostics.mode.enabled");
      } else {
        logRendererEvent("info", "diagnostics.mode.disabled");
        setRendererDiagnosticModeEnabled(false);
      }
      setDiagnosticModeEnabled(enabled);
    } catch (cause: unknown) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      logRendererEvent("error", "diagnostics.mode.update_failed", { enabled, error });
      setExportError(error);
    }
  };

  return (
    <div className="react-performance-trace-page">
      <header className="react-performance-trace-header">
        <div>
          <h1>{t("routes.performanceTrace")}</h1>
          <p>{t("performanceTrace.description")}</p>
        </div>
        <div className="react-performance-trace-actions">
          <button disabled={state.status === "loading"} type="button" onClick={refresh}>
            <RefreshCw aria-hidden="true" size={15} />
            {state.status === "loading" ? t("performanceTrace.refreshing") : t("generic.refresh")}
          </button>
          <button
            disabled={state.status !== "ready" || snapshotExporting || bundleExporting}
            type="button"
            onClick={() => void exportSnapshot()}
          >
            <Download aria-hidden="true" size={15} />
            {snapshotExporting ? t("performanceTrace.exportingSnapshot") : t("performanceTrace.export")}
          </button>
          <button
            disabled={state.status !== "ready" || snapshotExporting || bundleExporting}
            type="button"
            onClick={() => void exportDiagnosticBundle()}
          >
            <Archive aria-hidden="true" size={15} />
            {bundleExporting ? t("performanceTrace.exportingBundle") : t("performanceTrace.exportBundle")}
          </button>
        </div>
      </header>

      <p className="react-performance-trace-note">{t("performanceTrace.processLocal")}</p>
      <section aria-labelledby="performance-diagnostic-mode-title" className="react-performance-trace-diagnostics">
        <label>
          <input
            checked={diagnosticModeEnabled}
            type="checkbox"
            onChange={(event) => toggleDiagnosticMode(event.currentTarget.checked)}
          />
          <span>
            <strong id="performance-diagnostic-mode-title">{t("performanceTrace.diagnosticMode")}</strong>
            <small>{t("performanceTrace.diagnosticModeDescription")}</small>
          </span>
        </label>
        <p>{t("performanceTrace.bundlePrivacy")}</p>
      </section>
      {exportError ? (
        <p className="react-performance-trace-error" role="alert">
          {t("performanceTrace.exportFailed", { message: exportError.message })}
        </p>
      ) : null}
      {bundleResult ? (
        <p className="react-performance-trace-success" role="status">
          {t("performanceTrace.bundleSaved", { path: bundleResult.path })}
        </p>
      ) : null}
      {snapshotResult ? (
        <p className="react-performance-trace-success" role="status">
          {t("performanceTrace.snapshotSaved", { path: snapshotResult.path })}
        </p>
      ) : null}
      {state.status === "loading" ? (
        <p aria-live="polite" className="react-performance-trace-status" role="status">
          {t("performanceTrace.loading")}
        </p>
      ) : null}
      {state.status === "failed" ? (
        <div className="react-performance-trace-error" role="alert">
          <p>{t("performanceTrace.loadFailed", { message: state.error.message })}</p>
          <button type="button" onClick={refresh}>{t("generic.retry")}</button>
        </div>
      ) : null}
      {state.status === "ready" ? <TraceSnapshot snapshot={state.snapshot} /> : null}
    </div>
  );
}

function TraceSnapshot({ snapshot }: { snapshot: PerformanceTraceSnapshot }) {
  const { t } = useTranslation("common");
  const counters = Object.entries(snapshot.metrics.counters).sort(byName);
  const gauges = Object.entries(snapshot.metrics.gauges).sort(byName);
  const durations = Object.entries(snapshot.metrics.durations)
    .sort((left, right) => right[1].maxMs - left[1].maxMs);
  const events = [...snapshot.recentEvents].reverse();

  return (
    <div className="react-performance-trace-content">
      <section aria-labelledby="performance-summary-title" className="react-performance-trace-section">
        <div className="react-performance-trace-section__heading">
          <div>
            <h2 id="performance-summary-title">{t("performanceTrace.summary")}</h2>
            <p>{t("performanceTrace.captured", { time: formatTimestamp(snapshot.generatedAtUnixMs) })}</p>
          </div>
        </div>
        <div className="react-performance-trace-summary">
          <SummaryCard label={t("performanceTrace.durationMetrics")} value={durations.length} />
          <SummaryCard label={t("performanceTrace.counters")} value={counters.length} />
          <SummaryCard label={t("performanceTrace.gauges")} value={gauges.length} />
          <SummaryCard label={t("performanceTrace.recentEvents")} value={events.length} />
        </div>
      </section>

      <section aria-labelledby="performance-durations-title" className="react-performance-trace-section">
        <SectionHeading description={t("performanceTrace.durationsDescription")} id="performance-durations-title" title={t("performanceTrace.durations")} />
        {durations.length ? <DurationTable durations={durations} /> : <EmptyState>{t("performanceTrace.noDurations")}</EmptyState>}
      </section>

      <div className="react-performance-trace-pair">
        <MetricList entries={counters} title={t("performanceTrace.counters")} empty={t("performanceTrace.noCounters")} />
        <MetricList entries={gauges} title={t("performanceTrace.gauges")} empty={t("performanceTrace.noGauges")} />
      </div>

      <section aria-labelledby="performance-events-title" className="react-performance-trace-section">
        <SectionHeading description={t("performanceTrace.eventsDescription")} id="performance-events-title" title={t("performanceTrace.recentEvents")} />
        {events.length ? (
          <ol className="react-performance-trace-events">
            {events.map((event, index) => (
              <li key={`${event.timestampUnixMs}-${event.stream}-${event.event}-${index}`}>
                <div className="react-performance-trace-event__heading">
                  <span className="react-performance-trace-level" data-level={event.level}>{event.level}</span>
                  <strong>{event.event}</strong>
                  <span>{event.stream}</span>
                  <time dateTime={new Date(event.timestampUnixMs).toISOString()}>{formatTimestamp(event.timestampUnixMs)}</time>
                </div>
                {Object.keys(event.context).length ? (
                  <details>
                    <summary>{t("performanceTrace.context")}</summary>
                    <pre>{JSON.stringify(event.context, null, 2)}</pre>
                  </details>
                ) : null}
              </li>
            ))}
          </ol>
        ) : <EmptyState>{t("performanceTrace.noEvents")}</EmptyState>}
      </section>
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: number }) {
  return <article><strong>{value.toLocaleString()}</strong><span>{label}</span></article>;
}

function SectionHeading({ description, id, title }: { description?: string; id: string; title: string }) {
  return <div className="react-performance-trace-section__heading"><div><h2 id={id}>{title}</h2>{description ? <p>{description}</p> : null}</div></div>;
}

function DurationTable({ durations }: { durations: Array<[string, PerformanceTraceDuration]> }) {
  const { t } = useTranslation("common");
  const largest = Math.max(...durations.map(([, duration]) => duration.maxMs), 1);
  return (
    <div className="react-performance-trace-table-wrap">
      <table className="react-performance-trace-table">
        <thead><tr><th>{t("performanceTrace.metric")}</th><th>{t("performanceTrace.count")}</th><th>{t("performanceTrace.average")}</th><th>{t("performanceTrace.maximum")}</th><th>{t("performanceTrace.total")}</th></tr></thead>
        <tbody>
          {durations.map(([name, duration]) => (
            <tr key={name}>
              <th scope="row"><span>{name}</span><span className="react-performance-trace-bar"><i style={{ width: `${Math.max(2, (duration.maxMs / largest) * 100)}%` }} /></span></th>
              <td>{formatNumber(duration.count)}</td><td>{formatDuration(duration.averageMs)}</td><td>{formatDuration(duration.maxMs)}</td><td>{formatDuration(duration.totalMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MetricList({ empty, entries, title }: { empty: string; entries: Array<[string, number]>; title: string }) {
  return (
    <section className="react-performance-trace-section">
      <SectionHeading id={`performance-${title.toLowerCase().replace(/\s+/g, "-")}`} title={title} />
      {entries.length ? <dl className="react-performance-trace-metrics">{entries.map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{formatNumber(value)}</dd></div>)}</dl> : <EmptyState>{empty}</EmptyState>}
    </section>
  );
}

function EmptyState({ children }: { children: string }) {
  return <p className="react-performance-trace-empty">{children}</p>;
}

function byName(left: [string, number], right: [string, number]): number {
  return left[0].localeCompare(right[0]);
}

function formatDuration(value: number): string {
  if (value < 1) return `${value.toFixed(2)} ms`;
  if (value < 1_000) return `${value.toFixed(value < 10 ? 1 : 0)} ms`;
  return `${(value / 1_000).toFixed(2)} s`;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? value.toLocaleString() : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function formatTimestamp(value: number): string {
  return new Date(value).toLocaleString();
}
