import { emitTo, listen } from "@tauri-apps/api/event";
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

export const DESKTOP_PET_QUICK_CHAT_WINDOW_LABEL = "desktop-pet-chat";

const QUICK_CHAT_OPEN_REQUEST_EVENT = "desktop-pet-quick-chat-open-request";
const QUICK_CHAT_PRESENT_EVENT = "desktop-pet-quick-chat-present";
const QUICK_CHAT_READY_EVENT = "desktop-pet-quick-chat-ready";
const QUICK_CHAT_PROBE_EVENT = "desktop-pet-quick-chat-probe";
const QUICK_CHAT_OPEN_MAIN_EVENT = "desktop-pet-quick-chat-open-main";
const QUICK_CHAT_SCHEMA_VERSION = "tinybot.desktop_pet_quick_chat.v1";
const MAX_QUICK_CHAT_DRAFT_LENGTH = 512 * 1024;

export type DesktopPetQuickChatRequest = {
  schemaVersion: typeof QUICK_CHAT_SCHEMA_VERSION;
  requestId: string;
  draft: string;
};

export type DesktopPetQuickChatHostEvent = {
  type: "open-main";
  sessionId?: string;
};

export type DesktopPetQuickChatHost = {
  listen(listener: (event: DesktopPetQuickChatHostEvent) => void): Promise<() => void>;
};

export type DesktopPetQuickChatDropClient = {
  openWithDraft(draft: string): Promise<void>;
};

export type DesktopPetQuickChatWindowClient = {
  dismiss(): Promise<void>;
  listen(listener: (request: DesktopPetQuickChatRequest) => void): Promise<() => void>;
  openInMain(sessionId?: string): Promise<void>;
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

class TauriDesktopPetQuickChatHost implements DesktopPetQuickChatHost {
  private applyQueue: Promise<void> = Promise.resolve();
  private latestRequest: DesktopPetQuickChatRequest | null = null;
  private ready = false;
  private listening = false;

  async listen(listener: (event: DesktopPetQuickChatHostEvent) => void): Promise<() => void> {
    if (this.listening) throw new Error("The desktop pet quick chat host is already listening.");
    this.listening = true;
    try {
      const unlistenRequest = await listen<unknown>(QUICK_CHAT_OPEN_REQUEST_EVENT, ({ payload }) => {
        this.latestRequest = parseDesktopPetQuickChatRequest(payload);
        void this.schedulePresent().catch(reportQuickChatError);
      });
      const unlistenReady = await listen(QUICK_CHAT_READY_EVENT, () => {
        this.ready = true;
        void this.schedulePresent().catch(reportQuickChatError);
      });
      const unlistenOpenMain = await listen<unknown>(QUICK_CHAT_OPEN_MAIN_EVENT, ({ payload }) => {
        const sessionId = parseOpenMainSessionId(payload);
        void (async () => {
          const mainWindow = getCurrentWindow();
          await mainWindow.show();
          await mainWindow.setFocus();
          listener({ type: "open-main", ...(sessionId ? { sessionId } : {}) });
        })().catch(reportQuickChatError);
      });

      await emitTo(DESKTOP_PET_QUICK_CHAT_WINDOW_LABEL, QUICK_CHAT_PROBE_EVENT);

      return () => {
        unlistenOpenMain();
        unlistenReady();
        unlistenRequest();
        this.latestRequest = null;
        this.ready = false;
        this.listening = false;
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
    const request = this.latestRequest;
    if (!this.ready || !request) return;
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
    console.info("[desktop-pet-quick-chat] presented", {
      requestId: request.requestId,
      textLength: request.draft.length,
    });
  }
}

class TauriDesktopPetQuickChatDropClient implements DesktopPetQuickChatDropClient {
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
}

function createQuickChatRequest(draft: string): DesktopPetQuickChatRequest {
  if (draft.length > MAX_QUICK_CHAT_DRAFT_LENGTH) {
    throw new Error(`Dropped text exceeds the ${MAX_QUICK_CHAT_DRAFT_LENGTH} character limit.`);
  }
  return {
    schemaVersion: QUICK_CHAT_SCHEMA_VERSION,
    requestId: `pet-chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    draft,
  };
}

function parseDesktopPetQuickChatRequest(value: unknown): DesktopPetQuickChatRequest {
  if (!isRecord(value)
    || value.schemaVersion !== QUICK_CHAT_SCHEMA_VERSION
    || typeof value.requestId !== "string"
    || !value.requestId.trim()
    || typeof value.draft !== "string"
    || value.draft.length > MAX_QUICK_CHAT_DRAFT_LENGTH) {
    throw new Error("Received an invalid desktop pet quick chat request.");
  }
  return {
    schemaVersion: QUICK_CHAT_SCHEMA_VERSION,
    requestId: value.requestId,
    draft: value.draft,
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
  console.error("[desktop-pet-quick-chat] Native window operation failed.", error);
}
