import { afterEach, describe, expect, it, vi } from "vitest";
import type { PerformanceMemorySnapshot } from "./desktopNativePerformanceTrace";
import { createMemoryRecording } from "./performanceMemoryRecording";

afterEach(() => { vi.useRealTimers(); });

describe("memory recording lifetime", () => {
  it("keeps collecting without route subscribers and stops at the bounded limit", async () => {
    vi.useFakeTimers();
    const sample = vi.fn(async () => ({ sampledAtUnixMs: Date.now() } as PerformanceMemorySnapshot));
    const recording = createMemoryRecording(sample);
    const unsubscribe = recording.subscribe(() => undefined);
    recording.start();
    await vi.advanceTimersByTimeAsync(0);
    unsubscribe();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(sample).toHaveBeenCalledTimes(300);
    expect(recording.getSnapshot().samples).toHaveLength(300);
    expect(recording.getSnapshot().recording).toBe(false);
  });

  it("ignores an in-flight result after stopping or starting another recording", async () => {
    let resolve!: (value: PerformanceMemorySnapshot) => void;
    const recording = createMemoryRecording(() => new Promise((done) => { resolve = done; }));
    recording.start();
    recording.stop();
    resolve({ sampledAtUnixMs: 1 } as PerformanceMemorySnapshot);
    await Promise.resolve();
    expect(recording.getSnapshot().samples).toEqual([]);
  });

  it("stops and exposes sampling errors", async () => {
    const error = new Error("memory query failed");
    const recording = createMemoryRecording(async () => { throw error; });
    recording.start();
    await Promise.resolve();
    expect(recording.getSnapshot()).toMatchObject({ recording: false, error });
  });
});
