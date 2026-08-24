import type { RendererLogEntry } from "./rendererLogger";

export type PerformanceTraceDuration = {
  count: number;
  totalMs: number;
  maxMs: number;
  averageMs: number;
};

export type PerformanceTraceMetrics = {
  schemaVersion: number;
  generatedAtUnixMs: number;
  counters: Record<string, number>;
  durations: Record<string, PerformanceTraceDuration>;
  gauges: Record<string, number>;
};

export type PerformanceTraceEvent = {
  schemaVersion: string;
  timestampUnixMs: number;
  stream: string;
  level: "debug" | "info" | "warn" | "error";
  event: string;
  context: Record<string, unknown>;
};

export type PerformanceTraceSnapshot = {
  schemaVersion: "tinybot.performance_trace.v1";
  generatedAtUnixMs: number;
  metrics: PerformanceTraceMetrics;
  recentEvents: PerformanceTraceEvent[];
};

export type DiagnosticBundleExportInput = {
  diagnosticModeEnabled: boolean;
  locale?: string;
  timeZone?: string;
  rendererLogs: RendererLogEntry[];
};

export type DiagnosticBundleExportResult = {
  schemaVersion: "tinybot.diagnostic_bundle.v1";
  path: string;
  sizeBytes: number;
  includedFiles: string[];
};

export type PerformanceTraceExportResult = {
  path: string;
};

type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export function createDesktopNativePerformanceTraceApi({ invoke }: { invoke: Invoke }) {
  return {
    async snapshot(): Promise<PerformanceTraceSnapshot> {
      const value = await invoke("desktop_performance_snapshot");
      return normalizePerformanceTraceSnapshot(value);
    },
    async exportSnapshot(
      snapshot: PerformanceTraceSnapshot,
    ): Promise<PerformanceTraceExportResult | null> {
      const value = await invoke("save_export_file", {
        options: {
          title: "Export Tinybot performance trace",
          defaultPath: `tinybot-performance-trace-${new Date(snapshot.generatedAtUnixMs).toISOString().replace(/:/g, "-")}.json`,
          filters: [{ name: "JSON", extensions: ["json"] }],
          contents: `${JSON.stringify(snapshot, null, 2)}\n`,
        },
      });
      return value === null ? null : normalizePerformanceTraceExportResult(value);
    },
    async exportDiagnosticBundle(
      input: DiagnosticBundleExportInput,
    ): Promise<DiagnosticBundleExportResult | null> {
      const value = await invoke("desktop_export_diagnostic_bundle", {
        input: {
          schemaVersion: "tinybot.diagnostic_bundle_input.v1",
          diagnosticModeEnabled: input.diagnosticModeEnabled,
          locale: input.locale,
          timeZone: input.timeZone,
          rendererLogs: input.rendererLogs,
        },
      });
      return value === null ? null : normalizeDiagnosticBundleExportResult(value);
    },
  };
}

export function normalizePerformanceTraceExportResult(value: unknown): PerformanceTraceExportResult {
  const result = requireRecord(value, "performance trace export result");
  return { path: requireString(result.path, "performance trace export path") };
}

export function normalizeDiagnosticBundleExportResult(value: unknown): DiagnosticBundleExportResult {
  const result = requireRecord(value, "diagnostic bundle export result");
  if (result.schemaVersion !== "tinybot.diagnostic_bundle.v1") {
    throw new Error("Diagnostic bundle export result has an unsupported schema version");
  }
  return {
    schemaVersion: "tinybot.diagnostic_bundle.v1",
    path: requireString(result.path, "diagnostic bundle path"),
    sizeBytes: requireFiniteNumber(result.sizeBytes, "diagnostic bundle sizeBytes"),
    includedFiles: requireArray(result.includedFiles, "diagnostic bundle includedFiles")
      .map((item, index) => requireString(item, `diagnostic bundle includedFiles ${index}`)),
  };
}

export function normalizePerformanceTraceSnapshot(value: unknown): PerformanceTraceSnapshot {
  const snapshot = requireRecord(value, "performance trace snapshot");
  if (snapshot.schemaVersion !== "tinybot.performance_trace.v1") {
    throw new Error("Performance trace snapshot has an unsupported schema version");
  }
  const metrics = requireRecord(snapshot.metrics, "performance trace metrics");
  const recentEvents = requireArray(snapshot.recentEvents, "performance trace recent events");
  return {
    schemaVersion: "tinybot.performance_trace.v1",
    generatedAtUnixMs: requireFiniteNumber(snapshot.generatedAtUnixMs, "snapshot generatedAtUnixMs"),
    metrics: {
      schemaVersion: requireFiniteNumber(metrics.schemaVersion, "metrics schemaVersion"),
      generatedAtUnixMs: requireFiniteNumber(metrics.generatedAtUnixMs, "metrics generatedAtUnixMs"),
      counters: normalizeNumericRecord(metrics.counters, "metrics counters"),
      durations: normalizeDurationRecord(metrics.durations),
      gauges: normalizeNumericRecord(metrics.gauges, "metrics gauges"),
    },
    recentEvents: recentEvents.map(normalizePerformanceTraceEvent),
  };
}

const MAX_MERGED_RECENT_EVENTS = 300;

export function mergeRendererStartupTrace(
  snapshot: PerformanceTraceSnapshot,
  rendererLogs: readonly RendererLogEntry[],
): PerformanceTraceSnapshot {
  const startupLogs = rendererLogs.filter((entry) => entry.stage.startsWith("startup."));
  if (!startupLogs.length) {
    return snapshot;
  }

  const durations = { ...snapshot.metrics.durations };
  const gauges = { ...snapshot.metrics.gauges };
  for (const entry of startupLogs) {
    const phaseMatch = /^startup\.(.+)\.(?:complete|failed)$/.exec(entry.stage);
    const durationMs = finiteNumber(entry.details.durationMs);
    if (phaseMatch && durationMs !== undefined) {
      const name = `renderer.startup.${phaseMatch[1]}.durationMs`;
      const current = durations[name];
      const count = (current?.count ?? 0) + 1;
      const totalMs = (current?.totalMs ?? 0) + durationMs;
      durations[name] = {
        count,
        totalMs,
        maxMs: Math.max(current?.maxMs ?? 0, durationMs),
        averageMs: totalMs / count,
      };
    }
    const sinceStartMs = finiteNumber(entry.details.sinceStartMs);
    if (sinceStartMs !== undefined) {
      gauges[`renderer.${entry.stage}.sinceStartMs`] = sinceStartMs;
    }
  }

  const existingRendererEvents = new Set(snapshot.recentEvents.map((event) => {
    const rendererAt = typeof event.context.rendererAt === "string" ? event.context.rendererAt : "";
    return `${event.event}\u0000${rendererAt}`;
  }));
  const rendererEvents = startupLogs
    .filter((entry) => !existingRendererEvents.has(`${entry.stage}\u0000${entry.at}`))
    .map((entry): PerformanceTraceEvent => ({
      schemaVersion: entry.schemaVersion,
      timestampUnixMs: parsedTimestamp(entry.at, snapshot.generatedAtUnixMs),
      stream: "renderer",
      level: entry.level,
      event: entry.stage,
      context: { details: entry.details, rendererAt: entry.at },
    }));
  const recentEvents = [...snapshot.recentEvents, ...rendererEvents]
    .sort((left, right) => left.timestampUnixMs - right.timestampUnixMs)
    .slice(-MAX_MERGED_RECENT_EVENTS);

  return {
    ...snapshot,
    metrics: {
      ...snapshot.metrics,
      durations,
      gauges,
    },
    recentEvents,
  };
}

function normalizeDurationRecord(value: unknown): Record<string, PerformanceTraceDuration> {
  const durations = requireRecord(value, "metrics durations");
  return Object.fromEntries(Object.entries(durations).map(([name, rawDuration]) => {
    const duration = requireRecord(rawDuration, `duration ${name}`);
    return [name, {
      count: requireFiniteNumber(duration.count, `duration ${name} count`),
      totalMs: requireFiniteNumber(duration.totalMs, `duration ${name} totalMs`),
      maxMs: requireFiniteNumber(duration.maxMs, `duration ${name} maxMs`),
      averageMs: requireFiniteNumber(duration.averageMs, `duration ${name} averageMs`),
    }];
  }));
}

function normalizeNumericRecord(value: unknown, label: string): Record<string, number> {
  const record = requireRecord(value, label);
  return Object.fromEntries(Object.entries(record).map(([name, item]) => [
    name,
    requireFiniteNumber(item, `${label} ${name}`),
  ]));
}

function normalizePerformanceTraceEvent(value: unknown, index: number): PerformanceTraceEvent {
  const event = requireRecord(value, `performance trace event ${index}`);
  const level = requireString(event.level, `performance trace event ${index} level`);
  if (!isPerformanceTraceLevel(level)) {
    throw new Error(`Performance trace event ${index} has an unsupported level`);
  }
  return {
    schemaVersion: requireString(event.schemaVersion, `performance trace event ${index} schemaVersion`),
    timestampUnixMs: requireFiniteNumber(event.timestampUnixMs, `performance trace event ${index} timestampUnixMs`),
    stream: requireString(event.stream, `performance trace event ${index} stream`),
    level,
    event: requireString(event.event, `performance trace event ${index} event`),
    context: requireRecord(event.context, `performance trace event ${index} context`),
  };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requireFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
}

function isPerformanceTraceLevel(value: string): value is PerformanceTraceEvent["level"] {
  return value === "debug" || value === "info" || value === "warn" || value === "error";
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parsedTimestamp(value: string, fallback: number): number {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : fallback;
}
