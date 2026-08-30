import { Archive, CircleStop, Download, Play, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  DiagnosticBundleExportResult,
  PerformanceMemorySnapshot,
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

const MEMORY_SAMPLE_INTERVAL_MS = 2_000;
const MAX_MEMORY_SAMPLES = 300;

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
  const [memoryRecording, setMemoryRecording] = useState(false);
  const [memorySamples, setMemorySamples] = useState<PerformanceMemorySnapshot[]>([]);
  const [memoryError, setMemoryError] = useState<Error | null>(null);
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

  useEffect(() => {
    if (!memoryRecording) return;
    if (!performanceStore?.sampleMemory) {
      setMemoryError(new Error(t("performanceTrace.memorySamplingUnavailable")));
      setMemoryRecording(false);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sample = async () => {
      try {
        const next = await performanceStore.sampleMemory();
        if (cancelled) return;
        setMemorySamples((current) => [...current, next].slice(-MAX_MEMORY_SAMPLES));
        timer = setTimeout(() => void sample(), MEMORY_SAMPLE_INTERVAL_MS);
      } catch (cause: unknown) {
        if (cancelled) return;
        const error = cause instanceof Error ? cause : new Error(String(cause));
        console.error("[tinybot-performance-trace-memory]", { error });
        setMemoryError(error);
        setMemoryRecording(false);
      }
    };
    void sample();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [memoryRecording, performanceStore, t]);

  const refresh = () => {
    setExportError(null);
    setSnapshotResult(null);
    setBundleResult(null);
    setMemoryRecording(false);
    setMemorySamples([]);
    setMemoryError(null);
    setAttempt((value) => value + 1);
  };

  const startMemoryRecording = () => {
    if (state.status !== "ready") return;
    setMemoryError(null);
    setMemorySamples([state.snapshot.memory]);
    setMemoryRecording(true);
  };

  const exportSnapshot = async () => {
    if (!performanceStore || state.status !== "ready") return;
    setExportError(null);
    setSnapshotResult(null);
    setBundleResult(null);
    setSnapshotExporting(true);
    try {
      const result = await performanceStore.exportSnapshot(memorySamples.length
        ? {
            ...state.snapshot,
            memory: memorySamples[memorySamples.length - 1],
            memorySamples,
          }
        : state.snapshot);
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
      const result = await performanceStore.exportDiagnosticBundle(
        memorySamples.length ? memorySamples : undefined,
      );
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
      {state.status === "ready" ? (
        <TraceSnapshot
          memoryError={memoryError}
          memoryRecording={memoryRecording}
          memorySamples={memorySamples}
          samplingAvailable={Boolean(performanceStore?.sampleMemory)}
          snapshot={state.snapshot}
          onStartMemoryRecording={startMemoryRecording}
          onStopMemoryRecording={() => setMemoryRecording(false)}
        />
      ) : null}
    </div>
  );
}

function TraceSnapshot({
  memoryError,
  memoryRecording,
  memorySamples,
  onStartMemoryRecording,
  onStopMemoryRecording,
  samplingAvailable,
  snapshot,
}: {
  memoryError: Error | null;
  memoryRecording: boolean;
  memorySamples: PerformanceMemorySnapshot[];
  onStartMemoryRecording(): void;
  onStopMemoryRecording(): void;
  samplingAvailable: boolean;
  snapshot: PerformanceTraceSnapshot;
}) {
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

      <MemorySnapshotSection
        error={memoryError}
        recording={memoryRecording}
        samples={memorySamples.length ? memorySamples : [snapshot.memory]}
        samplingAvailable={samplingAvailable && snapshot.memory.status !== "unsupported"}
        onStart={onStartMemoryRecording}
        onStop={onStopMemoryRecording}
      />

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

function MemorySnapshotSection({
  error,
  onStart,
  onStop,
  recording,
  samples,
  samplingAvailable,
}: {
  error: Error | null;
  onStart(): void;
  onStop(): void;
  recording: boolean;
  samples: PerformanceMemorySnapshot[];
  samplingAvailable: boolean;
}) {
  const { t } = useTranslation("common");
  const current = samples[samples.length - 1];
  const unsupported = current.status === "unsupported";

  return (
    <section aria-labelledby="performance-memory-title" className="react-performance-trace-section">
      <div className="react-performance-trace-section__heading react-performance-memory-heading">
        <div>
          <h2 id="performance-memory-title">{t("performanceTrace.memoryTitle")}</h2>
          <p>{t("performanceTrace.memoryDescription")}</p>
        </div>
        <div className="react-performance-memory-controls">
          <span className="react-performance-memory-status" data-status={current.status}>
            {t(memoryStatusKey(current.status))}
          </span>
          {recording ? (
            <button type="button" onClick={onStop}>
              <CircleStop aria-hidden="true" size={15} />
              {t("performanceTrace.memoryStop")}
            </button>
          ) : (
            <button disabled={!samplingAvailable} type="button" onClick={onStart}>
              <Play aria-hidden="true" size={15} />
              {t("performanceTrace.memoryStart")}
            </button>
          )}
        </div>
      </div>
      <p className="react-performance-memory-sampling" aria-live="polite">
        {recording
          ? t("performanceTrace.memoryRecording", { count: samples.length })
          : t("performanceTrace.memorySamplingDescription", { count: samples.length })}
      </p>
      {error ? (
        <p className="react-performance-trace-error" role="alert">
          {t("performanceTrace.memorySamplingFailed", { message: error.message })}
        </p>
      ) : null}
      <div className="react-performance-memory-summary">
        <MemorySummaryCard label={t("performanceTrace.memoryTotalPrivate")} value={current.totalPrivateBytes} />
        <MemorySummaryCard label={t("performanceTrace.memoryNative")} value={current.native?.privateBytes ?? null} />
        <MemorySummaryCard label={t("performanceTrace.memoryWebView2")} value={unsupported ? null : current.webview2.privateBytes} />
        <MemorySummaryCard label={t("performanceTrace.memoryTotalWorkingSet")} value={current.totalWorkingSetBytes} />
      </div>
      <MemoryTrend samples={samples} />
      {current.collectionErrors.length ? (
        <div className="react-performance-memory-errors">
          <h3>{t("performanceTrace.memoryCollectionErrors")}</h3>
          <ul>
            {current.collectionErrors.map((collectionError, index) => (
              <li key={`${collectionError.code}-${collectionError.pid ?? "none"}-${index}`}>
                <strong>{collectionError.scope}: {collectionError.code}</strong>
                <span>{collectionError.message}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <h3 className="react-performance-memory-process-title">{t("performanceTrace.memoryProcesses")}</h3>
      {current.native || current.webview2.processes.length ? (
        <div className="react-performance-trace-table-wrap">
          <table className="react-performance-trace-table react-performance-memory-table">
            <thead>
              <tr>
                <th>{t("performanceTrace.memoryProcessKind")}</th>
                <th>{t("performanceTrace.memoryPid")}</th>
                <th>{t("performanceTrace.memoryWebviews")}</th>
                <th>{t("performanceTrace.memoryPrivate")}</th>
                <th>{t("performanceTrace.memoryWorkingSet")}</th>
                <th>{t("performanceTrace.memoryPeakWorkingSet")}</th>
              </tr>
            </thead>
            <tbody>
              {current.native ? (
                <tr>
                  <th scope="row">{t("performanceTrace.memoryNativeProcess")}</th>
                  <td>{current.native.pid}</td>
                  <td>—</td>
                  <td>{formatBytes(current.native.privateBytes)}</td>
                  <td>{formatBytes(current.native.workingSetBytes)}</td>
                  <td>{formatBytes(current.native.peakWorkingSetBytes)}</td>
                </tr>
              ) : null}
              {current.webview2.processes.map((process) => (
                <tr key={process.pid}>
                  <th scope="row">{process.kind}</th>
                  <td>{process.pid}</td>
                  <td>{process.webviewLabels.join(", ") || "—"}</td>
                  <td>{formatBytes(process.privateBytes)}</td>
                  <td>{formatBytes(process.workingSetBytes)}</td>
                  <td>{formatBytes(process.peakWorkingSetBytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <EmptyState>{t("performanceTrace.memoryNoProcesses")}</EmptyState>}
    </section>
  );
}

function MemorySummaryCard({ label, value }: { label: string; value: number | null }) {
  const { t } = useTranslation("common");
  return (
    <article>
      <strong>{value === null ? t("performanceTrace.memoryUnavailable") : formatBytes(value)}</strong>
      <span>{label}</span>
    </article>
  );
}

function MemoryTrend({ samples }: { samples: PerformanceMemorySnapshot[] }) {
  const { t } = useTranslation("common");
  if (samples.length < 2) {
    return <p className="react-performance-trace-empty">{t("performanceTrace.memoryNoTrend")}</p>;
  }
  const total = samples.map((sample) => sample.totalPrivateBytes);
  const native = samples.map((sample) => sample.native?.privateBytes ?? null);
  const webview2 = samples.map((sample) => sample.status === "unsupported" ? null : sample.webview2.privateBytes);
  const maximum = Math.max(
    1,
    ...total.flatMap((value) => value === null ? [] : [value]),
    ...native.flatMap((value) => value === null ? [] : [value]),
    ...webview2.flatMap((value) => value === null ? [] : [value]),
  );
  return (
    <figure className="react-performance-memory-trend">
      <svg aria-label={t("performanceTrace.memoryTrendLabel")} role="img" viewBox="0 0 600 160">
        <title>{t("performanceTrace.memoryTrendLabel")}</title>
        <line className="react-performance-memory-grid" x1="12" x2="588" y1="148" y2="148" />
        <polyline className="react-performance-memory-line" data-series="total" points={memoryTrendPoints(total, maximum)} />
        <polyline className="react-performance-memory-line" data-series="native" points={memoryTrendPoints(native, maximum)} />
        <polyline className="react-performance-memory-line" data-series="webview2" points={memoryTrendPoints(webview2, maximum)} />
      </svg>
      <figcaption>
        <span><i data-series="total" />{t("performanceTrace.memoryTotalPrivate")}: {formatOptionalBytes(total[total.length - 1])}</span>
        <span><i data-series="native" />{t("performanceTrace.memoryNative")}: {formatOptionalBytes(native[native.length - 1])}</span>
        <span><i data-series="webview2" />{t("performanceTrace.memoryWebView2")}: {formatOptionalBytes(webview2[webview2.length - 1])}</span>
      </figcaption>
    </figure>
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

function formatBytes(value: number): string {
  if (value < 1024) return `${value.toLocaleString()} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let scaled = value / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && scaled >= 1024; index += 1) {
    scaled /= 1024;
    unit = units[index];
  }
  return `${scaled.toLocaleString(undefined, {
    maximumFractionDigits: scaled >= 10 ? 0 : 1,
  })} ${unit}`;
}

function formatOptionalBytes(value: number | null): string {
  return value === null ? "—" : formatBytes(value);
}

function memoryStatusKey(status: PerformanceMemorySnapshot["status"]):
  | "performanceTrace.memoryStatusAvailable"
  | "performanceTrace.memoryStatusPartial"
  | "performanceTrace.memoryStatusUnsupported" {
  if (status === "available") return "performanceTrace.memoryStatusAvailable";
  if (status === "partial") return "performanceTrace.memoryStatusPartial";
  return "performanceTrace.memoryStatusUnsupported";
}

function memoryTrendPoints(values: Array<number | null>, maximum: number): string {
  const width = 576;
  const height = 132;
  return values.flatMap((value, index) => {
    if (value === null) return [];
    const x = 12 + (index / Math.max(values.length - 1, 1)) * width;
    const y = 148 - (value / maximum) * height;
    return [`${x.toFixed(1)},${y.toFixed(1)}`];
  }).join(" ");
}

function formatTimestamp(value: number): string {
  return new Date(value).toLocaleString();
}
