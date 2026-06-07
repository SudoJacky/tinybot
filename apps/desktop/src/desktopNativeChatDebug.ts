export type DesktopNativeChatDebugStage =
  | "socket.open"
  | "socket.close"
  | "socket.error"
  | "socket.send"
  | "socket.frame"
  | "gateway.event"
  | "runtime.before"
  | "runtime.after"
  | "state.event.before"
  | "state.event.after"
  | "shell.update"
  | "vue.thread.update"
  | "vue.composer.update";

export interface DesktopNativeChatDebugEntry {
  at: string;
  details: Record<string, unknown>;
  stage: DesktopNativeChatDebugStage;
}

declare global {
  interface Window {
    __tinybotNativeChatDebug?: DesktopNativeChatDebugEntry[];
  }
}

const MAX_DEBUG_ENTRIES = 300;
const DEBUG_STORAGE_KEY = "tinybot.desktop.nativeChatDebug";

export function logDesktopNativeChatDebug(
  stage: DesktopNativeChatDebugStage,
  details: Record<string, unknown> = {},
): void {
  if (!isDesktopNativeChatDebugEnabled()) {
    return;
  }
  const entry: DesktopNativeChatDebugEntry = {
    at: new Date().toISOString(),
    stage,
    details: sanitizeDebugDetails(details),
  };
  const targetWindow = typeof window === "undefined" ? null : window;
  if (targetWindow) {
    const entries = targetWindow.__tinybotNativeChatDebug ?? [];
    entries.push(entry);
    if (entries.length > MAX_DEBUG_ENTRIES) {
      entries.splice(0, entries.length - MAX_DEBUG_ENTRIES);
    }
    targetWindow.__tinybotNativeChatDebug = entries;
  }
  console.info("[Tinybot native chat]", stage, entry.details);
}

export function summarizeDebugText(value: string | undefined): { length: number; preview: string } {
  const text = value ?? "";
  return {
    length: text.length,
    preview: text.slice(0, 80),
  };
}

function isDesktopNativeChatDebugEnabled(): boolean {
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
    return typeof window === "undefined" ? "" : window.localStorage?.getItem(DEBUG_STORAGE_KEY) ?? "";
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
