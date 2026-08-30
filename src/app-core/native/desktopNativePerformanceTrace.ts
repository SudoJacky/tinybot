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

export type PerformanceMemoryStatus = "available" | "partial" | "unsupported";

export type PerformanceProcessMemory = {
  pid: number;
  privateBytes: number;
  workingSetBytes: number;
  peakWorkingSetBytes: number;
};

export type PerformanceWebView2ProcessMemory = PerformanceProcessMemory & {
  kind: string;
  webviewLabels: string[];
};

export type PerformanceMemoryCollectionError = {
  scope: "native" | "webview2";
  code: string;
  message: string;
  pid?: number;
  webviewLabel?: string;
};

export type PerformanceMemorySnapshot = {
  schemaVersion: "tinybot.memory_snapshot.v1";
  sampledAtUnixMs: number;
  status: PerformanceMemoryStatus;
  native: PerformanceProcessMemory | null;
  webview2: {
    privateBytes: number;
    workingSetBytes: number;
    processes: PerformanceWebView2ProcessMemory[];
  };
  totalPrivateBytes: number | null;
  totalWorkingSetBytes: number | null;
  collectionErrors: PerformanceMemoryCollectionError[];
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
  memory: PerformanceMemorySnapshot;
  memorySamples?: PerformanceMemorySnapshot[];
  recentEvents: PerformanceTraceEvent[];
};

export type DiagnosticBundleExportInput = {
  diagnosticModeEnabled: boolean;
  locale?: string;
  timeZone?: string;
  rendererLogs: RendererLogEntry[];
  memorySamples?: readonly PerformanceMemorySnapshot[];
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
    async memorySnapshot(): Promise<PerformanceMemorySnapshot> {
      const value = await invoke("desktop_memory_snapshot");
      return normalizePerformanceMemorySnapshot(value);
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
          ...(input.memorySamples ? { memorySamples: input.memorySamples } : {}),
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
  const memorySamples = snapshot.memorySamples === undefined
    ? undefined
    : requireArray(snapshot.memorySamples, "performance trace memorySamples")
      .map(normalizePerformanceMemorySnapshot);
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
    memory: normalizePerformanceMemorySnapshot(snapshot.memory),
    ...(memorySamples ? { memorySamples } : {}),
    recentEvents: recentEvents.map(normalizePerformanceTraceEvent),
  };
}

export function normalizePerformanceMemorySnapshot(value: unknown): PerformanceMemorySnapshot {
  const snapshot = requireRecord(value, "performance memory snapshot");
  if (snapshot.schemaVersion !== "tinybot.memory_snapshot.v1") {
    throw new Error("Performance memory snapshot has an unsupported schema version");
  }
  const status = requireString(snapshot.status, "performance memory status");
  if (!isPerformanceMemoryStatus(status)) {
    throw new Error("Performance memory snapshot has an unsupported status");
  }
  const webview2 = requireRecord(snapshot.webview2, "performance memory webview2");
  return {
    schemaVersion: "tinybot.memory_snapshot.v1",
    sampledAtUnixMs: requireNonNegativeSafeInteger(snapshot.sampledAtUnixMs, "performance memory sampledAtUnixMs"),
    status,
    native: snapshot.native === null
      ? null
      : normalizeProcessMemory(snapshot.native, "performance memory native"),
    webview2: {
      privateBytes: requireNonNegativeSafeInteger(webview2.privateBytes, "performance memory webview2 privateBytes"),
      workingSetBytes: requireNonNegativeSafeInteger(webview2.workingSetBytes, "performance memory webview2 workingSetBytes"),
      processes: requireArray(webview2.processes, "performance memory webview2 processes")
        .map((process, index) => normalizeWebView2ProcessMemory(process, index)),
    },
    totalPrivateBytes: normalizeNullableBytes(snapshot.totalPrivateBytes, "performance memory totalPrivateBytes"),
    totalWorkingSetBytes: normalizeNullableBytes(snapshot.totalWorkingSetBytes, "performance memory totalWorkingSetBytes"),
    collectionErrors: requireArray(snapshot.collectionErrors, "performance memory collectionErrors")
      .map(normalizeMemoryCollectionError),
  };
}

function normalizeProcessMemory(value: unknown, label: string): PerformanceProcessMemory {
  const process = requireRecord(value, label);
  return {
    pid: requirePositiveSafeInteger(process.pid, `${label} pid`),
    privateBytes: requireNonNegativeSafeInteger(process.privateBytes, `${label} privateBytes`),
    workingSetBytes: requireNonNegativeSafeInteger(process.workingSetBytes, `${label} workingSetBytes`),
    peakWorkingSetBytes: requireNonNegativeSafeInteger(process.peakWorkingSetBytes, `${label} peakWorkingSetBytes`),
  };
}

function normalizeWebView2ProcessMemory(value: unknown, index: number): PerformanceWebView2ProcessMemory {
  const label = `performance memory webview2 process ${index}`;
  const process = requireRecord(value, label);
  return {
    ...normalizeProcessMemory(process, label),
    kind: requireString(process.kind, `${label} kind`),
    webviewLabels: requireArray(process.webviewLabels, `${label} webviewLabels`)
      .map((item, labelIndex) => requireString(item, `${label} webviewLabels ${labelIndex}`)),
  };
}

function normalizeMemoryCollectionError(value: unknown, index: number): PerformanceMemoryCollectionError {
  const label = `performance memory collection error ${index}`;
  const error = requireRecord(value, label);
  const scope = requireString(error.scope, `${label} scope`);
  if (scope !== "native" && scope !== "webview2") {
    throw new Error(`${label} has an unsupported scope`);
  }
  return {
    scope,
    code: requireString(error.code, `${label} code`),
    message: requireString(error.message, `${label} message`),
    ...(error.pid === undefined ? {} : { pid: requirePositiveSafeInteger(error.pid, `${label} pid`) }),
    ...(error.webviewLabel === undefined ? {} : { webviewLabel: requireString(error.webviewLabel, `${label} webviewLabel`) }),
  };
}

function normalizeNullableBytes(value: unknown, label: string): number | null {
  return value === null ? null : requireNonNegativeSafeInteger(value, label);
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

function requireNonNegativeSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function requirePositiveSafeInteger(value: unknown, label: string): number {
  const integer = requireNonNegativeSafeInteger(value, label);
  if (integer === 0) {
    throw new Error(`${label} must be positive`);
  }
  return integer;
}

function isPerformanceTraceLevel(value: string): value is PerformanceTraceEvent["level"] {
  return value === "debug" || value === "info" || value === "warn" || value === "error";
}

function isPerformanceMemoryStatus(value: string): value is PerformanceMemoryStatus {
  return value === "available" || value === "partial" || value === "unsupported";
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parsedTimestamp(value: string, fallback: number): number {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : fallback;
}
