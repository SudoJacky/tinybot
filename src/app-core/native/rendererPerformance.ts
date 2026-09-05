const SAMPLE_LIMIT = 120;

export type RendererPerformanceSample = {
  startTime: number;
  duration: number;
  name: string;
  transferSize?: number;
  decodedBodySize?: number;
  interactionId?: number;
  inputDelayMs?: number;
};

export type RendererPerformanceSnapshot = {
  schemaVersion: "tinybot.renderer_performance.v1";
  instanceId: string;
  surface: string;
  timeOriginUnixMs: number;
  sampledAtUnixMs: number;
  observationStartedAtMs: number;
  visibility: string;
  support: Record<string, "available" | "unsupported" | "failed">;
  errors: string[];
  streams: Record<string, {
    count: number;
    totalDurationMs: number;
    maxDurationMs: number;
    droppedSamples: number;
    samples: RendererPerformanceSample[];
  }>;
  navigation: Record<string, number> | null;
  jsHeap: { usedBytes: number; totalBytes: number; limitBytes: number } | null;
};

/** Query strings, remote URLs and workspace paths never enter resource records. */
export function resourcePerformanceName(name: string, pageUrl: string): string {
  const url = new URL(name, pageUrl);
  const page = new URL(pageUrl);
  return url.origin === page.origin && /^\/assets\/[a-zA-Z0-9_.-]+$/.test(url.pathname)
    ? url.pathname
    : url.origin === page.origin ? "[same-origin resource]" : "[external resource]";
}

export function createRendererPerformanceCollector(identity: {
  instanceId: string; surface: string; timeOriginUnixMs: number; observationStartedAtMs: number;
}) {
  const streams: RendererPerformanceSnapshot["streams"] = {};
  return {
    record(type: string, sample: RendererPerformanceSample) {
      const stream = streams[type] ??= {
        count: 0, totalDurationMs: 0, maxDurationMs: 0, droppedSamples: 0, samples: [],
      };
      stream.count += 1;
      stream.totalDurationMs += sample.duration;
      stream.maxDurationMs = Math.max(stream.maxDurationMs, sample.duration);
      if (stream.samples.length === SAMPLE_LIMIT) {
        stream.samples.shift();
        stream.droppedSamples += 1;
      }
      stream.samples.push(sample);
    },
    snapshot(): Pick<RendererPerformanceSnapshot, keyof typeof identity | "streams" | "schemaVersion"> {
      return {
        schemaVersion: "tinybot.renderer_performance.v1",
        ...identity,
        streams: Object.fromEntries(Object.entries(streams).map(([name, stream]) => [name, {
          ...stream, samples: stream.samples.map((sample) => ({ ...sample })),
        }])),
      };
    },
  };
}

let tracking: {
  collector: ReturnType<typeof createRendererPerformanceCollector>;
  support: RendererPerformanceSnapshot["support"];
  errors: string[];
  observers: PerformanceObserver[];
  consume: (entries: PerformanceEntry[]) => void;
} | undefined;

export function rendererPerformanceIdentity() {
  const requestedSurface = new URLSearchParams(window.location.search).get("surface");
  const surface = requestedSurface === "desktop-pet" || requestedSurface === "desktop-pet-chat"
    ? requestedSurface : "main";
  return {
    instanceId: `${surface}:${performance.timeOrigin}`,
    surface,
    timeOriginUnixMs: performance.timeOrigin,
  };
}

/** One bounded observer set per page lifetime; no per-entry console or IPC writes. */
export function installRendererPerformanceTracking(): void {
  if (tracking) return;
  const collector = createRendererPerformanceCollector({
    ...rendererPerformanceIdentity(), observationStartedAtMs: performance.now(),
  });
  const support: RendererPerformanceSnapshot["support"] = {};
  const errors: string[] = [];
  const observers: PerformanceObserver[] = [];
  const consume = (entries: PerformanceEntry[]) => {
    for (const entry of entries) {
      const event = entry as PerformanceEventTiming & { interactionId?: number };
      const resource = entry as PerformanceResourceTiming;
      if (entry.entryType === "event" && !event.interactionId) continue;
      collector.record(entry.entryType, {
        startTime: entry.startTime,
        duration: entry.duration,
        name: entry.entryType === "resource"
          ? resourcePerformanceName(entry.name, window.location.href) : entry.name,
        ...(entry.entryType === "resource" ? {
          transferSize: resource.transferSize, decodedBodySize: resource.decodedBodySize,
        } : {}),
        ...(entry.entryType === "event" ? {
          interactionId: event.interactionId,
          inputDelayMs: event.processingStart - entry.startTime,
        } : {}),
      });
    }
  };
  for (const type of ["resource", "longtask", "event", "paint"]) {
    if (typeof PerformanceObserver === "undefined" || !PerformanceObserver.supportedEntryTypes.includes(type)) {
      support[type] = "unsupported";
      continue;
    }
    const observer = new PerformanceObserver((list) => consume(list.getEntries()));
    try {
      observer.observe({ type, buffered: true, ...(type === "event" ? { durationThreshold: 40 } : {}) });
      observers.push(observer);
      support[type] = "available";
    } catch (error) {
      observer.disconnect();
      support[type] = "failed";
      const message = `${type}: ${String(error)}`;
      errors.push(message);
      console.error("[tinybot-performance-observer]", message);
    }
  }
  tracking = { collector, support, errors, observers, consume };
}

export function rendererPerformanceSnapshot(): RendererPerformanceSnapshot | undefined {
  if (!tracking) return undefined;
  for (const observer of tracking.observers) tracking.consume(observer.takeRecords());
  const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  const memory = (performance as Performance & {
    memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number };
  }).memory;
  return {
    ...tracking.collector.snapshot(),
    sampledAtUnixMs: Date.now(),
    visibility: document.visibilityState,
    support: { ...tracking.support },
    errors: [...tracking.errors],
    navigation: navigation ? {
      responseStart: navigation.responseStart,
      responseEnd: navigation.responseEnd,
      domInteractive: navigation.domInteractive,
      domContentLoadedEventEnd: navigation.domContentLoadedEventEnd,
      loadEventEnd: navigation.loadEventEnd,
    } : null,
    jsHeap: memory ? {
      usedBytes: memory.usedJSHeapSize, totalBytes: memory.totalJSHeapSize, limitBytes: memory.jsHeapSizeLimit,
    } : null,
  };
}
