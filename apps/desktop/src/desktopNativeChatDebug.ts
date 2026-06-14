export type DesktopNativeDebugStage = string;
export type DesktopNativeChatDebugStage = DesktopNativeDebugStage;

export interface DesktopNativeDebugEntry {
  at: string;
  details: Record<string, unknown>;
  stage: DesktopNativeDebugStage;
}

export type DesktopNativeChatDebugEntry = DesktopNativeDebugEntry;

export interface DesktopNativeStartupTrace {
  complete(phase: string, details?: Record<string, unknown>): void;
  fail(phase: string, error: unknown, details?: Record<string, unknown>): void;
  mark(stage: string, details?: Record<string, unknown>): void;
  start(phase: string, details?: Record<string, unknown>): void;
}

declare global {
  interface Window {
    __tinybotNativeChatDebug?: DesktopNativeDebugEntry[];
    __tinybotNativeDebug?: DesktopNativeDebugEntry[];
  }
}

const MAX_DEBUG_ENTRIES = 300;
const DEBUG_STORAGE_KEY = "tinybot.desktop.nativeDebug";
const LEGACY_DEBUG_STORAGE_KEY = "tinybot.desktop.nativeChatDebug";

export function logDesktopNativeDebug(
  stage: DesktopNativeDebugStage,
  details: Record<string, unknown> = {},
): void {
  if (!isDesktopNativeDebugEnabled()) {
    return;
  }
  const entry: DesktopNativeDebugEntry = {
    at: new Date().toISOString(),
    stage,
    details: sanitizeDebugDetails(details),
  };
  const targetWindow = typeof window === "undefined" ? null : window;
  if (targetWindow) {
    const entries = targetWindow.__tinybotNativeDebug ?? targetWindow.__tinybotNativeChatDebug ?? [];
    entries.push(entry);
    if (entries.length > MAX_DEBUG_ENTRIES) {
      entries.splice(0, entries.length - MAX_DEBUG_ENTRIES);
    }
    targetWindow.__tinybotNativeDebug = entries;
    targetWindow.__tinybotNativeChatDebug = entries;
  }
  console.info("[Tinybot native]", stage, entry.details);
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

function isDesktopNativeDebugEnabled(): boolean {
  const storageValue = readDebugStorageValue();
  if (/^(0|false|off)$/i.test(storageValue)) {
    return false;
  }
  if (/^(1|true|on)$/i.test(storageValue)) {
    return true;
  }
  return !isTestRuntime();
}

function readDebugStorageValue(): string {
  try {
    if (typeof window === "undefined") {
      return "";
    }
    return window.localStorage?.getItem(DEBUG_STORAGE_KEY)
      ?? window.localStorage?.getItem(LEGACY_DEBUG_STORAGE_KEY)
      ?? "";
  } catch {
    return "";
  }
}

function isTestRuntime(): boolean {
  const processLike = globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> };
  };
  return processLike.process?.env?.VITEST === "true" || processLike.process?.env?.NODE_ENV === "test";
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

function sanitizeDebugDetails(details: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(details).map(([key, value]) => [key, sanitizeDebugValue(value)]));
}

function sanitizeDebugValue(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > 500 ? `${value.slice(0, 500)}...` : value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 12).map(sanitizeDebugValue);
  }
  if (typeof value === "object" && value !== null) {
    return sanitizeDebugDetails(value as Record<string, unknown>);
  }
  return value;
}
