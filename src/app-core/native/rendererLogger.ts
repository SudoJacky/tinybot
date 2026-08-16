import { invoke as tauriInvoke } from "@tauri-apps/api/core";

export type RendererLogLevel = "debug" | "info" | "warn" | "error";

export interface RendererDebugEntry {
  at: string;
  stage: string;
  details: Record<string, unknown>;
}

export interface RendererLogEntry extends RendererDebugEntry {
  schemaVersion: "tinybot.renderer_log.v1";
  level: RendererLogLevel;
}

export interface RendererLogger {
  log(level: RendererLogLevel, stage: string, details?: Record<string, unknown>): void;
}

type NativeInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

interface RendererLoggerOptions {
  console?: Pick<Console, "error" | "info" | "warn">;
  invoke?: NativeInvoke;
  isDebugEnabled?: () => boolean;
  isNativeRuntime?: () => boolean;
  now?: () => string;
}

declare global {
  interface Window {
    __tinybotNativeChatDebug?: RendererDebugEntry[];
    __tinybotNativeDebug?: RendererDebugEntry[];
    __tinybotRendererLogs?: RendererLogEntry[];
  }
}

const MAX_RENDERER_LOG_ENTRIES = 300;
const MAX_CONTEXT_ARRAY_ITEMS = 12;
const MAX_CONTEXT_DEPTH = 5;
const MAX_CONTEXT_KEYS = 64;
const MAX_CONTEXT_STRING_LENGTH = 500;
const DEBUG_STORAGE_KEY = "tinybot.desktop.nativeDebug";
const LEGACY_DEBUG_STORAGE_KEY = "tinybot.desktop.nativeChatDebug";
const SENSITIVE_CONTEXT_KEY = /(?:authorization|cookie|credential|password|passcode|secret|token|api.?key|prompt|preview|requestBody|responseBody)/i;

export function createRendererLogger(options: RendererLoggerOptions = {}): RendererLogger {
  const consoleSink = options.console ?? console;
  const invoke = options.invoke ?? tauriInvoke;
  const isDebugEnabled = options.isDebugEnabled ?? readDebugEnabled;
  const isNativeRuntime = options.isNativeRuntime ?? (() => "__TAURI_INTERNALS__" in globalThis);
  const now = options.now ?? (() => new Date().toISOString());

  return {
    log(level, stage, details = {}) {
      if (!stage.trim()) {
        throw new Error("renderer log stage must not be empty");
      }
      const diagnosticModeEnabled = isDebugEnabled();
      if (level === "debug" && !diagnosticModeEnabled) {
        return;
      }

      const entry: RendererLogEntry = {
        schemaVersion: "tinybot.renderer_log.v1",
        at: now(),
        level,
        stage,
        details: sanitizeRendererLogDetails(details),
      };
      retainRendererLog(entry);
      writeRendererConsole(consoleSink, entry);

      if ((diagnosticModeEnabled || level === "warn" || level === "error") && isNativeRuntime()) {
        persistRendererLog(invoke, consoleSink, entry);
      }
    },
  };
}

export const rendererLogger = createRendererLogger();

export function logRendererEvent(
  level: RendererLogLevel,
  stage: string,
  details: Record<string, unknown> = {},
): void {
  rendererLogger.log(level, stage, details);
}

export function isRendererDiagnosticModeEnabled(): boolean {
  return readDebugEnabled();
}

export function setRendererDiagnosticModeEnabled(enabled: boolean): void {
  if (typeof window === "undefined") {
    throw new Error("renderer diagnostic mode requires a browser window");
  }
  if (enabled) {
    window.localStorage.setItem(DEBUG_STORAGE_KEY, "on");
    window.localStorage.removeItem(LEGACY_DEBUG_STORAGE_KEY);
    return;
  }
  window.localStorage.removeItem(DEBUG_STORAGE_KEY);
  window.localStorage.removeItem(LEGACY_DEBUG_STORAGE_KEY);
}

export function rendererLogSnapshot(): RendererLogEntry[] {
  if (typeof window === "undefined") {
    return [];
  }
  return (window.__tinybotRendererLogs ?? []).map((entry) => ({
    ...entry,
    details: sanitizeRendererLogDetails(entry.details),
  }));
}

function retainRendererLog(entry: RendererLogEntry): void {
  if (typeof window === "undefined") {
    return;
  }
  const entries = (window.__tinybotNativeDebug as RendererLogEntry[] | undefined)
    ?? window.__tinybotRendererLogs
    ?? (window.__tinybotNativeChatDebug as RendererLogEntry[] | undefined)
    ?? [];
  entries.push(entry);
  if (entries.length > MAX_RENDERER_LOG_ENTRIES) {
    entries.splice(0, entries.length - MAX_RENDERER_LOG_ENTRIES);
  }
  window.__tinybotRendererLogs = entries;
  window.__tinybotNativeDebug = entries;
  window.__tinybotNativeChatDebug = entries;
}

function writeRendererConsole(
  consoleSink: Pick<Console, "error" | "info" | "warn">,
  entry: RendererLogEntry,
): void {
  if (entry.level === "error") {
    consoleSink.error("[tinybot-renderer]", entry.stage, entry.details);
    return;
  }
  if (entry.level === "warn") {
    consoleSink.warn("[tinybot-renderer]", entry.stage, entry.details);
    return;
  }
  consoleSink.info("[tinybot-renderer]", entry.stage, entry.details);
}

function persistRendererLog(
  invoke: NativeInvoke,
  consoleSink: Pick<Console, "error">,
  entry: RendererLogEntry,
): void {
  const reportFailure = (error: unknown) => {
    consoleSink.error("[tinybot-renderer] log persistence failed", {
      error: error instanceof Error ? error.message : String(error),
      stage: entry.stage,
    });
  };
  try {
    void invoke("record_renderer_log", { input: entry }).catch(reportFailure);
  } catch (error) {
    reportFailure(error);
  }
}

function readDebugEnabled(): boolean {
  try {
    if (typeof window === "undefined") {
      return false;
    }
    const value = window.localStorage?.getItem(DEBUG_STORAGE_KEY)
      ?? window.localStorage?.getItem(LEGACY_DEBUG_STORAGE_KEY)
      ?? "";
    return /^(1|true|on)$/i.test(value);
  } catch {
    return false;
  }
}

function sanitizeRendererLogDetails(details: Record<string, unknown>): Record<string, unknown> {
  const sanitized = sanitizeRendererLogValue(details, "", 0, new WeakSet<object>());
  return isRecord(sanitized) ? sanitized : {};
}

function sanitizeRendererLogValue(
  value: unknown,
  key: string,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (SENSITIVE_CONTEXT_KEY.test(key)) {
    return "[redacted]";
  }
  if (typeof value === "string") {
    return value.length > MAX_CONTEXT_STRING_LENGTH
      ? `${value.slice(0, MAX_CONTEXT_STRING_LENGTH)}...`
      : value;
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: sanitizeRendererLogValue(value.message, "message", depth + 1, seen),
      stack: sanitizeRendererLogValue(value.stack, "stack", depth + 1, seen),
    };
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  if (depth >= MAX_CONTEXT_DEPTH) {
    return "[truncated]";
  }
  if (seen.has(value)) {
    return "[circular]";
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value
        .slice(0, MAX_CONTEXT_ARRAY_ITEMS)
        .map((item) => sanitizeRendererLogValue(item, "", depth + 1, seen));
    }
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, MAX_CONTEXT_KEYS)
        .map(([nestedKey, nestedValue]) => [
          nestedKey,
          sanitizeRendererLogValue(nestedValue, nestedKey, depth + 1, seen),
        ]),
    );
  } finally {
    seen.delete(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
