import { afterEach, describe, expect, it, vi } from "vitest";
import { createRendererPerformanceCollector, resourcePerformanceName } from "./rendererPerformance";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("renderer performance collection", () => {
  it("retains the slowest resources after the recent buffer rolls over", () => {
    const collector = createRendererPerformanceCollector({
      instanceId: "main:1000", surface: "main", timeOriginUnixMs: 1000, observationStartedAtMs: 0,
    });
    collector.record("resource", { name: "/src/main.ts", startTime: 0, duration: 900 });
    for (let index = 1; index < 150; index += 1) {
      collector.record("resource", { name: "/src/fast.ts", startTime: index, duration: index });
    }
    const stream = collector.snapshot().streams.resource;
    expect(stream.samples.some((sample) => sample.duration === 900)).toBe(false);
    expect(stream.slowestSamples).toHaveLength(20);
    expect(stream.slowestSamples?.[0].duration).toBe(900);
    stream.slowestSamples![0].duration = 0;
    expect(collector.snapshot().streams.resource.slowestSamples?.[0].duration).toBe(900);
  });

  it("bounds each stream, keeps lifetime totals and exports immutable samples", () => {
    const collector = createRendererPerformanceCollector({
      instanceId: "main:1000", surface: "main", timeOriginUnixMs: 1000, observationStartedAtMs: 3,
    });
    for (let index = 0; index < 125; index += 1) {
      collector.record("longtask", { name: "self", startTime: index * 100, duration: 60 });
    }
    const snapshot = collector.snapshot();
    expect(snapshot.streams.longtask).toMatchObject({ count: 125, totalDurationMs: 7500, droppedSamples: 5 });
    expect(snapshot.streams.longtask.samples).toHaveLength(120);
    expect(snapshot.streams.longtask.samples[0].startTime).toBe(500);
    snapshot.streams.longtask.samples[0].duration = 999;
    expect(collector.snapshot().streams.longtask.samples[0].duration).toBe(60);
  });

  it("retains asset identity without leaking request queries or workspace paths", () => {
    const page = "http://tauri.localhost/";
    expect(resourcePerformanceName(`${page}assets/main-abc.js?secret=123`, page)).toBe("/assets/main-abc.js");
    expect(resourcePerformanceName(`${page}workspace/private-project/notes.md`, page)).toBe("[same-origin resource]");
    expect(resourcePerformanceName(`${page}src/react-workbench/App.tsx?t=secret`, page)).toBe("/src/react-workbench/App.tsx");
    expect(resourcePerformanceName(`${page}node_modules/.vite/deps/react-dom_client.js?v=secret`, page)).toBe("/node_modules/.vite/deps/react-dom_client.js");
    expect(resourcePerformanceName(`${page}@fs/D:/private/secret.ts`, page)).toBe("[same-origin resource]");
    expect(resourcePerformanceName("https://user:password@example.org/private?token=abc", page)).toBe("[external resource]");
  });

  it("flushes pending observer entries at export and explicitly reports unsupported streams", async () => {
    vi.stubGlobal("window", { location: { search: "", href: "http://tauri.localhost/" } });
    vi.stubGlobal("document", { visibilityState: "visible" });
    const observers: Observer[] = [];
    class Observer {
      static supportedEntryTypes = ["longtask"];
      pending: PerformanceEntry[] = [];
      observe = vi.fn();
      disconnect = vi.fn();
      constructor() { observers.push(this); }
      takeRecords() { return this.pending.splice(0); }
    }
    vi.stubGlobal("PerformanceObserver", Observer);
    const { installRendererPerformanceTracking, rendererPerformanceSnapshot } = await import("./rendererPerformance");
    installRendererPerformanceTracking();
    installRendererPerformanceTracking();
    expect(observers).toHaveLength(1);
    expect(observers[0].observe).toHaveBeenCalledWith({ type: "longtask", buffered: true });
    observers[0].pending.push({ entryType: "longtask", name: "self", startTime: 10, duration: 65 } as PerformanceEntry);
    const snapshot = rendererPerformanceSnapshot();
    expect(snapshot?.support).toMatchObject({ longtask: "available", resource: "unsupported", event: "unsupported" });
    expect(snapshot?.streams.longtask.count).toBe(1);
    expect(rendererPerformanceSnapshot()?.streams.longtask.count).toBe(1);
  });
});
