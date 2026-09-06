import { emitTo, listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  PhysicalPosition,
  getCurrentWindow,
  monitorFromPoint,
  primaryMonitor,
} from "@tauri-apps/api/window";
import {
  desktopPetQuickChatTopLeft,
} from "../desktop-pet/desktopPetQuickChatGeometry";
import { desktopPetWindowCenter } from "../desktop-pet/desktopPetWindowGeometry";
import type { DesktopPetPosition } from "../desktop-pet/desktopPetState";
import { DESKTOP_PET_WINDOW_LABEL } from "./desktopNativePet";
import {
  importDesktopPetDroppedFiles,
  parseNativePickedFiles,
} from "./desktopNativePetFileDrop";
import type { NativePickedFile } from "./desktopNativeFilePicker";
import { logRendererEvent } from "./rendererLogger";

export const DESKTOP_PET_QUICK_CHAT_WINDOW_LABEL = "desktop-pet-chat";

const QUICK_CHAT_OPEN_REQUEST_EVENT = "desktop-pet-quick-chat-open-request";
const QUICK_CHAT_PRESENT_EVENT = "desktop-pet-quick-chat-present";
const QUICK_CHAT_READY_EVENT = "desktop-pet-quick-chat-ready";
const QUICK_CHAT_PROBE_EVENT = "desktop-pet-quick-chat-probe";
const QUICK_CHAT_OPEN_MAIN_EVENT = "desktop-pet-quick-chat-open-main";
const QUICK_CHAT_SCHEMA_VERSION = "tinybot.desktop_pet_quick_chat.v2";
const MAX_QUICK_CHAT_DRAFT_LENGTH = 512 * 1024;

export type DesktopPetQuickChatRequest = {
  schemaVersion: typeof QUICK_CHAT_SCHEMA_VERSION;
  requestId: string;
  draft: string;
  attachments: NativePickedFile[];
};

export type DesktopPetQuickChatHostEvent = {
  type: "open-main";
  sessionId?: string;
};

export type DesktopPetQuickChatHost = {
  listen(listener: (event: DesktopPetQuickChatHostEvent) => void): Promise<() => void>;
};

export type DesktopPetQuickChatDropClient = {
  openWithFiles(files: readonly File[]): Promise<void>;
  openWithDraft(draft: string): Promise<void>;
};

export type DesktopPetQuickChatWindowClient = {
  dismiss(): Promise<void>;
  listen(listener: (request: DesktopPetQuickChatRequest) => void): Promise<() => void>;
  openInMain(sessionId?: string): Promise<void>;
  startDragging(): Promise<void>;
};

export function createDesktopNativePetQuickChatHost(): DesktopPetQuickChatHost | null {
  return hasTauriRuntime() && isWindowsRuntime() ? new TauriDesktopPetQuickChatHost() : null;
}

export function createDesktopNativePetQuickChatDropClient(): DesktopPetQuickChatDropClient {
  if (!hasTauriRuntime()) {
    throw new Error("Desktop pet quick chat requires the Tauri runtime.");
  }
  return new TauriDesktopPetQuickChatDropClient();
}

export function createDesktopNativePetQuickChatWindowClient(): DesktopPetQuickChatWindowClient {
  if (!hasTauriRuntime()) {
    throw new Error("Desktop pet quick chat requires the Tauri runtime.");
  }
  return new TauriDesktopPetQuickChatWindowClient();
}

export async function presentMainWindowForQuickChat(
  mainWindow: Pick<WebviewWindow, "show" | "unminimize" | "setFocus">,
): Promise<void> {
  await mainWindow.show();
  await mainWindow.unminimize();
  await mainWindow.setFocus();
}

class TauriDesktopPetQuickChatHost implements DesktopPetQuickChatHost {
  private applyQueue: Promise<void> = Promise.resolve();
  private latestRequest: DesktopPetQuickChatRequest | null = null;
  private ready = false;
  private listening = false;
  private requestedAt = 0;
  private readyTimer: ReturnType<typeof setTimeout> | undefined;

  async listen(listener: (event: DesktopPetQuickChatHostEvent) => void): Promise<() => void> {
    if (this.listening) throw new Error("The desktop pet quick chat host is already listening.");
    this.listening = true;
    try {
      const unlistenRequest = await listen<unknown>(QUICK_CHAT_OPEN_REQUEST_EVENT, ({ payload }) => {
        this.latestRequest = parseDesktopPetQuickChatRequest(payload);
        this.requestedAt = performance.now();
        void this.schedulePresent().catch(reportQuickChatError);
      });
      const unlistenReady = await listen(QUICK_CHAT_READY_EVENT, () => {
        this.ready = true;
        clearTimeout(this.readyTimer);
        this.readyTimer = undefined;
        void this.schedulePresent().catch(reportQuickChatError);
      });
      const unlistenOpenMain = await listen<unknown>(QUICK_CHAT_OPEN_MAIN_EVENT, ({ payload }) => {
        const sessionId = parseOpenMainSessionId(payload);
        void (async () => {
          const mainWindow = getCurrentWindow();
          await presentMainWindowForQuickChat(mainWindow);
          listener({ type: "open-main", ...(sessionId ? { sessionId } : {}) });
        })().catch(reportQuickChatError);
      });

      if (await WebviewWindow.getByLabel(DESKTOP_PET_QUICK_CHAT_WINDOW_LABEL)) {
        await emitTo(DESKTOP_PET_QUICK_CHAT_WINDOW_LABEL, QUICK_CHAT_PROBE_EVENT);
      }

      return () => {
        unlistenOpenMain();
        unlistenReady();
        unlistenRequest();
        this.latestRequest = null;
        this.ready = false;
        this.listening = false;
        clearTimeout(this.readyTimer);
        this.readyTimer = undefined;
      };
    } catch (error) {
      this.listening = false;
      throw error;
    }
  }

  private schedulePresent(): Promise<void> {
    const scheduled = this.applyQueue.then(() => this.presentLatestRequest());
    this.applyQueue = scheduled.catch(() => undefined);
    return scheduled;
  }

  private async presentLatestRequest(): Promise<void> {
    if (!this.listening || !this.latestRequest) return;
    if (!this.ready) {
      await invoke("desktop_ensure_pet_quick_chat_window");
      if (!this.listening) return;
      // A newly created renderer announces ready after installing its listeners.
      // A reused window may have announced before this host mounted, so probe it.
      await emitTo(DESKTOP_PET_QUICK_CHAT_WINDOW_LABEL, QUICK_CHAT_PROBE_EVENT);
      if (!this.ready) {
        if (this.readyTimer === undefined) {
          this.readyTimer = setTimeout(() => {
            this.readyTimer = undefined;
            if (!this.ready && this.latestRequest) {
              reportQuickChatError(new Error("Quick chat renderer did not become ready within 15 seconds."));
            }
          }, 15_000);
        }
        return;
      }
    }
    if (!this.listening) return;
    const request = this.latestRequest;
    if (!request) return;
    const requestedAt = this.requestedAt;
    this.latestRequest = null;
    const [petWindow, quickChatWindow] = await Promise.all([
      requireWindow(DESKTOP_PET_WINDOW_LABEL),
      requireWindow(DESKTOP_PET_QUICK_CHAT_WINDOW_LABEL),
    ]);
    const [petPosition, petSize, panelSize] = await Promise.all([
      petWindow.outerPosition(),
      petWindow.outerSize(),
      quickChatWindow.outerSize(),
    ]);
    const petCenter = desktopPetWindowCenter(petPosition, petSize);
    const monitor = await resolveMonitor(petCenter);
    const panelPosition = desktopPetQuickChatTopLeft(
      { position: petPosition, size: petSize },
      panelSize,
      monitor.workArea,
    );
    await quickChatWindow.setPosition(new PhysicalPosition(panelPosition.x, panelPosition.y));
    await emitTo(DESKTOP_PET_QUICK_CHAT_WINDOW_LABEL, QUICK_CHAT_PRESENT_EVENT, request);
    await quickChatWindow.show();
    await quickChatWindow.setFocus();
    logRendererEvent("info", "desktop_pet_quick_chat.presented", {
      requestId: request.requestId,
      textLength: request.draft.length,
      durationMs: performance.now() - requestedAt,
    });
  }
}

class TauriDesktopPetQuickChatDropClient implements DesktopPetQuickChatDropClient {
  async openWithFiles(files: readonly File[]): Promise<void> {
    const attachments = await importDesktopPetDroppedFiles(files);
    await emitTo("main", QUICK_CHAT_OPEN_REQUEST_EVENT, createQuickChatRequest("", attachments));
  }

  openWithDraft(draft: string): Promise<void> {
    return emitTo("main", QUICK_CHAT_OPEN_REQUEST_EVENT, createQuickChatRequest(draft));
  }
}

class TauriDesktopPetQuickChatWindowClient implements DesktopPetQuickChatWindowClient {
  async listen(listener: (request: DesktopPetQuickChatRequest) => void): Promise<() => void> {
    const emitReady = () => emitTo("main", QUICK_CHAT_READY_EVENT);
    const unlistenPresent = await listen<unknown>(QUICK_CHAT_PRESENT_EVENT, ({ payload }) => {
      listener(parseDesktopPetQuickChatRequest(payload));
    });
    const unlistenProbe = await listen(QUICK_CHAT_PROBE_EVENT, () => {
      void emitReady().catch(reportQuickChatError);
    });
    await emitReady();
    return () => {
      unlistenProbe();
      unlistenPresent();
    };
  }

  dismiss(): Promise<void> {
    return getCurrentWindow().hide();
  }

  async openInMain(sessionId?: string): Promise<void> {
    if (sessionId !== undefined && !sessionId.trim()) {
      throw new Error("Cannot open an empty quick chat session ID.");
    }
    await emitTo("main", QUICK_CHAT_OPEN_MAIN_EVENT, sessionId ? { sessionId } : {});
    await this.dismiss();
  }

  async startDragging(): Promise<void> {
    await getCurrentWindow().startDragging();
  }
}

function createQuickChatRequest(
  draft: string,
  attachments: NativePickedFile[] = [],
): DesktopPetQuickChatRequest {
  if (draft.length > MAX_QUICK_CHAT_DRAFT_LENGTH) {
    throw new Error(`Dropped text exceeds the ${MAX_QUICK_CHAT_DRAFT_LENGTH} character limit.`);
  }
  return {
    schemaVersion: QUICK_CHAT_SCHEMA_VERSION,
    requestId: `pet-chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    draft,
    attachments: parseNativePickedFiles(attachments),
  };
}

function parseDesktopPetQuickChatRequest(value: unknown): DesktopPetQuickChatRequest {
  if (!isRecord(value)
    || value.schemaVersion !== QUICK_CHAT_SCHEMA_VERSION
    || typeof value.requestId !== "string"
    || !value.requestId.trim()
    || typeof value.draft !== "string"
    || value.draft.length > MAX_QUICK_CHAT_DRAFT_LENGTH
    || value.attachments === undefined) {
    throw new Error("Received an invalid desktop pet quick chat request.");
  }
  return {
    schemaVersion: QUICK_CHAT_SCHEMA_VERSION,
    requestId: value.requestId,
    draft: value.draft,
    attachments: parseNativePickedFiles(value.attachments),
  };
}

function parseOpenMainSessionId(value: unknown): string | undefined {
  if (!isRecord(value)
    || (value.sessionId !== undefined
      && (typeof value.sessionId !== "string" || !value.sessionId.trim()))) {
    throw new Error("Received an invalid desktop pet open-main request.");
  }
  return typeof value.sessionId === "string" ? value.sessionId : undefined;
}

async function resolveMonitor(position: DesktopPetPosition) {
  const monitor = await monitorFromPoint(position.x, position.y) ?? await primaryMonitor();
  if (!monitor) throw new Error("No monitor is available for desktop pet quick chat.");
  return monitor;
}

async function requireWindow(label: string): Promise<WebviewWindow> {
  const window = await WebviewWindow.getByLabel(label);
  if (!window) throw new Error(`The ${label} window was not created.`);
  return window;
}

function hasTauriRuntime(): boolean {
  return "__TAURI_INTERNALS__" in globalThis;
}

function isWindowsRuntime(): boolean {
  return typeof navigator !== "undefined" && navigator.userAgent.includes("Windows");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reportQuickChatError(error: unknown): void {
  logRendererEvent("error", "desktop_pet_quick_chat.failed", { error });
}
