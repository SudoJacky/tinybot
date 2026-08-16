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

type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export function createDesktopNativePerformanceTraceApi({ invoke }: { invoke: Invoke }) {
  return {
    async snapshot(): Promise<PerformanceTraceSnapshot> {
      const value = await invoke("desktop_performance_snapshot");
      return normalizePerformanceTraceSnapshot(value);
    },
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
