import { logRendererEvent, type RendererDebugEntry } from "./rendererLogger";

export type DesktopNativeDebugStage = string;
export type DesktopNativeChatDebugStage = DesktopNativeDebugStage;

export type DesktopNativeDebugEntry = RendererDebugEntry;

export type DesktopNativeChatDebugEntry = DesktopNativeDebugEntry;

export interface DesktopNativeStartupTrace {
  complete(phase: string, details?: Record<string, unknown>): void;
  fail(phase: string, error: unknown, details?: Record<string, unknown>): void;
  mark(stage: string, details?: Record<string, unknown>): void;
  start(phase: string, details?: Record<string, unknown>): void;
}

export function logDesktopNativeDebug(
  stage: DesktopNativeDebugStage,
  details: Record<string, unknown> = {},
): void {
  logRendererEvent("debug", stage, details);
}

export function logDesktopNativeChatDebug(
  stage: DesktopNativeChatDebugStage,
  details: Record<string, unknown> = {},
): void {
  logDesktopNativeDebug(stage, details);
}

export async function traceDesktopNativeDebugAsync<T>(
  stage: DesktopNativeDebugStage,
  run: () => Promise<T>,
  details: Record<string, unknown> = {},
  options: { now?: () => number } = {},
): Promise<T> {
  const now = options.now ?? readMonotonicNow;
  const startedAt = now();
  logDesktopNativeDebug(`${stage}.start`, details);
  try {
    const result = await run();
    logDesktopNativeDebug(`${stage}.complete`, {
      ...details,
      durationMs: roundedDuration(now() - startedAt),
    });
    return result;
  } catch (error) {
    logDesktopNativeDebug(`${stage}.failed`, {
      ...details,
      durationMs: roundedDuration(now() - startedAt),
      error: stringifyDebugError(error),
    });
    throw error;
  }
}

export function createDesktopNativeStartupTrace(
  options: { now?: () => number } = {},
): DesktopNativeStartupTrace {
  const now = options.now ?? readMonotonicNow;
  const startedAt = now();
  const activePhases = new Map<string, number>();

  const elapsedDetails = (at: number, details: Record<string, unknown> = {}) => ({
    ...details,
    sinceStartMs: roundedDuration(at - startedAt),
  });

  return {
    mark(stage, details = {}) {
      logDesktopNativeDebug(`startup.${stage}`, elapsedDetails(now(), details));
    },
    start(phase, details = {}) {
      const phaseStartedAt = now();
      activePhases.set(phase, phaseStartedAt);
      logDesktopNativeDebug(`startup.${phase}.start`, elapsedDetails(phaseStartedAt, details));
    },
    complete(phase, details = {}) {
      const completedAt = now();
      const phaseStartedAt = activePhases.get(phase) ?? completedAt;
      activePhases.delete(phase);
      logDesktopNativeDebug(`startup.${phase}.complete`, elapsedDetails(completedAt, {
        ...details,
        durationMs: roundedDuration(completedAt - phaseStartedAt),
      }));
    },
    fail(phase, error, details = {}) {
      const failedAt = now();
      const phaseStartedAt = activePhases.get(phase) ?? failedAt;
      activePhases.delete(phase);
      logDesktopNativeDebug(`startup.${phase}.failed`, elapsedDetails(failedAt, {
        ...details,
        durationMs: roundedDuration(failedAt - phaseStartedAt),
        error: stringifyDebugError(error),
      }));
    },
  };
}

export function summarizeDebugText(value: string | undefined): { length: number; preview: string } {
  const text = value ?? "";
  return {
    length: text.length,
    preview: text.slice(0, 80),
  };
}

function readMonotonicNow(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function roundedDuration(value: number): number {
  return Math.round(value * 10) / 10;
}

function stringifyDebugError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
