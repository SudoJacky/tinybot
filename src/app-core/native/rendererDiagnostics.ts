import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import type { DesktopNativeDebugEntry } from "./desktopNativeChatDebug";

export type RendererDiagnosticType = "react.render" | "window.error" | "window.unhandledrejection";

export interface RendererDiagnosticDebugStage {
  at: string;
  stage: string;
}

export interface RendererDiagnostic {
  componentStack?: string;
  id: string;
  message: string;
  name?: string;
  recentDebugStages: RendererDiagnosticDebugStage[];
  stack?: string;
  timestamp: string;
  type: RendererDiagnosticType;
  url?: string;
  userAgent?: string;
}

type NativeInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

const RENDERER_DIAGNOSTICS_STORAGE_KEY = "tinybot.renderer.diagnostics";
const MAX_LOCAL_DIAGNOSTICS = 20;
const MAX_STACK_LENGTH = 4000;
const MAX_MESSAGE_LENGTH = 500;
const MAX_RECENT_DEBUG_STAGES = 20;
const RENDERER_DIAGNOSTIC_OVERLAY_ID = "tinybot-renderer-diagnostic-overlay";

export function buildRendererDiagnostic(
  type: RendererDiagnosticType,
  error: unknown,
  options: {
    componentStack?: string;
    now?: () => string;
    url?: string;
    userAgent?: string;
  } = {},
): RendererDiagnostic {
  const timestamp = options.now?.() ?? new Date().toISOString();
  return {
    id: createRendererDiagnosticId(timestamp),
    type,
    timestamp,
    message: truncateText(errorMessage(error), MAX_MESSAGE_LENGTH),
    name: errorName(error),
    stack: truncateOptionalText(errorStack(error), MAX_STACK_LENGTH),
    componentStack: truncateOptionalText(options.componentStack, MAX_STACK_LENGTH),
    url: options.url ?? readLocationHref(),
    userAgent: options.userAgent ?? readUserAgent(),
    recentDebugStages: recentDebugStages(),
  };
}

export async function recordRendererDiagnostic(
  diagnostic: RendererDiagnostic,
  options: {
    invoke?: NativeInvoke;
    storage?: Pick<Storage, "getItem" | "setItem">;
  } = {},
): Promise<void> {
  const invoke = options.invoke ?? tauriInvoke;
  try {
    await invoke("record_renderer_diagnostic", { input: diagnostic });
  } catch (error) {
    persistLocalDiagnostic(diagnostic, options.storage);
    console.error("[tinybot-renderer-diagnostic]", diagnostic, error);
  }
}

export function showRendererDiagnosticOverlay(diagnostic: RendererDiagnostic): void {
  if (typeof document === "undefined") {
    return;
  }

  const existingOverlay = document.getElementById(RENDERER_DIAGNOSTIC_OVERLAY_ID);
  const overlay = existingOverlay ?? document.createElement("section");
  overlay.id = RENDERER_DIAGNOSTIC_OVERLAY_ID;
  overlay.setAttribute("role", "alert");
  overlay.setAttribute("aria-live", "assertive");
  overlay.replaceChildren();
  Object.assign(overlay.style, {
    position: "fixed",
    inset: "0",
    zIndex: "2147483647",
    display: "grid",
    alignContent: "center",
    justifyItems: "start",
    gap: "10px",
    padding: "40px",
    boxSizing: "border-box",
    background: "#fff",
    color: "#191816",
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif",
  });

  const title = document.createElement("h1");
  title.textContent = "Tinybot UI crashed";
  Object.assign(title.style, {
    margin: "0",
    fontSize: "18px",
    fontWeight: "750",
  });

  const message = document.createElement("p");
  message.textContent = diagnostic.message || "An unexpected renderer error occurred.";
  Object.assign(message.style, {
    maxWidth: "760px",
    margin: "0",
    color: "#5f5a54",
    fontSize: "13px",
    lineHeight: "1.5",
    overflowWrap: "anywhere",
  });

  const crashId = document.createElement("p");
  crashId.textContent = `Crash ID: ${diagnostic.id}`;
  Object.assign(crashId.style, {
    maxWidth: "760px",
    margin: "0",
    color: "#5f5a54",
    fontSize: "13px",
    lineHeight: "1.5",
    overflowWrap: "anywhere",
  });

  const reloadButton = document.createElement("button");
  reloadButton.type = "button";
  reloadButton.textContent = "Reload";
  Object.assign(reloadButton.style, {
    minHeight: "34px",
    border: "1px solid #d8d1c7",
    borderRadius: "8px",
    background: "#191816",
    padding: "0 12px",
    color: "#fff",
    fontSize: "12px",
    fontWeight: "650",
    cursor: "pointer",
  });
  reloadButton.addEventListener("click", () => window.location.reload());

  overlay.append(title, message, crashId, reloadButton);
  if (!existingOverlay) {
    document.body.append(overlay);
  }
}

export function installRendererDiagnosticHandlers(options: {
  record?: (diagnostic: RendererDiagnostic) => void | Promise<void>;
} = {}): () => void {
  const record = options.record ?? ((diagnostic: RendererDiagnostic) => {
    void recordRendererDiagnostic(diagnostic);
  });
  const handleError = (event: ErrorEvent) => {
    void record(buildRendererDiagnostic("window.error", event.error ?? event.message, {
      url: event.filename || undefined,
    }));
  };
  const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
    void record(buildRendererDiagnostic("window.unhandledrejection", event.reason));
  };

  window.addEventListener("error", handleError);
  window.addEventListener("unhandledrejection", handleUnhandledRejection);

  return () => {
    window.removeEventListener("error", handleError);
    window.removeEventListener("unhandledrejection", handleUnhandledRejection);
  };
}

function persistLocalDiagnostic(
  diagnostic: RendererDiagnostic,
  storage: Pick<Storage, "getItem" | "setItem"> | undefined,
): void {
  const targetStorage = storage ?? readLocalStorage();
  if (!targetStorage) {
    return;
  }
  try {
    const existing = JSON.parse(targetStorage.getItem(RENDERER_DIAGNOSTICS_STORAGE_KEY) ?? "[]");
    const diagnostics = Array.isArray(existing) ? existing : [];
    diagnostics.push(diagnostic);
    const start = diagnostics.length > MAX_LOCAL_DIAGNOSTICS
      ? diagnostics.length - MAX_LOCAL_DIAGNOSTICS
      : 0;
    targetStorage.setItem(RENDERER_DIAGNOSTICS_STORAGE_KEY, JSON.stringify(diagnostics.slice(start)));
  } catch {
    targetStorage.setItem(RENDERER_DIAGNOSTICS_STORAGE_KEY, JSON.stringify([diagnostic]));
  }
}

function recentDebugStages(): RendererDiagnosticDebugStage[] {
  const entries = readDebugEntries();
  return entries.slice(-MAX_RECENT_DEBUG_STAGES).map((entry) => ({
    at: entry.at,
    stage: entry.stage,
  }));
}

function readDebugEntries(): DesktopNativeDebugEntry[] {
  if (typeof window === "undefined") {
    return [];
  }
  return window.__tinybotNativeDebug ?? window.__tinybotNativeChatDebug ?? [];
}

function readLocalStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

function readLocationHref(): string | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.location.href;
  } catch {
    return undefined;
  }
}

function readUserAgent(): string | undefined {
  try {
    return typeof navigator === "undefined" ? undefined : navigator.userAgent;
  } catch {
    return undefined;
  }
}

function createRendererDiagnosticId(timestamp: string): string {
  const compactTime = timestamp.replace(/\D/g, "").slice(0, 14) || String(Date.now());
  return `renderer-${compactTime}-${Math.random().toString(36).slice(2, 8)}`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name;
  }
  return typeof error === "string" ? error : String(error);
}

function errorName(error: unknown): string | undefined {
  return error instanceof Error ? error.name : undefined;
}

function errorStack(error: unknown): string | undefined {
  return error instanceof Error ? error.stack : undefined;
}

function truncateOptionalText(value: string | undefined, maxLength: number): string | undefined {
  if (!value) {
    return undefined;
  }
  return truncateText(value, maxLength);
}

function truncateText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}
