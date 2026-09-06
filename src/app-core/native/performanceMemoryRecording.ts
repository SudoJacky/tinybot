import type { PerformanceMemorySnapshot } from "./desktopNativePerformanceTrace";

type MemorySampler = { sampleMemory(): Promise<PerformanceMemorySnapshot> };
type RecordingState = {
  recording: boolean;
  samples: PerformanceMemorySnapshot[];
  error: Error | null;
};
const recordings = new WeakMap<MemorySampler, ReturnType<typeof createMemoryRecording>>();

/** Keep a manually started recording alive while navigating between app routes. */
export function memoryRecordingFor(sampler: MemorySampler) {
  let recording = recordings.get(sampler);
  if (!recording) {
    recording = createMemoryRecording(() => sampler.sampleMemory());
    recordings.set(sampler, recording);
  }
  return recording;
}

export function createMemoryRecording(sample: () => Promise<PerformanceMemorySnapshot>) {
  let state: RecordingState = { recording: false, samples: [], error: null };
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();
  const publish = (next: RecordingState) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const stop = () => {
    generation += 1;
    clearTimeout(timer);
    publish({ ...state, recording: false });
  };
  const collect = async (run: number) => {
    try {
      const next = await sample();
      if (run !== generation) return;
      const samples = [...state.samples, next];
      // Finish after 300 observations instead of silently losing the baseline.
      const recording = samples.length < 300;
      publish({ recording, samples, error: null });
      if (recording) timer = setTimeout(() => void collect(run), 2_000);
    } catch (cause) {
      if (run !== generation) return;
      const error = cause instanceof Error ? cause : new Error(String(cause));
      console.error("[tinybot-performance-trace-memory]", { error });
      publish({ ...state, recording: false, error });
    }
  };
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    start() {
      stop();
      publish({ recording: true, samples: [], error: null });
      void collect(generation);
    },
    stop,
    reset() {
      stop();
      publish({ recording: false, samples: [], error: null });
    },
  };
}
