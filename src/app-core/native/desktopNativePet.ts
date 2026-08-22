import { emitTo, listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  LogicalSize,
  PhysicalPosition,
  getCurrentWindow,
  monitorFromPoint,
  primaryMonitor,
  type Monitor,
} from "@tauri-apps/api/window";
import {
  isDesktopPetMood,
  isDesktopPetPreferences,
  isDesktopPetSize,
  type DesktopPetMood,
  type DesktopPetPosition,
  type DesktopPetPreferences,
  type DesktopPetSize,
} from "../desktop-pet/desktopPetState";
import {
  clampDesktopPetWindowTopLeft,
  defaultDesktopPetWindowTopLeft,
  desktopPetWindowCenter,
  desktopPetWindowLogicalSize,
  desktopPetWindowTopLeft,
} from "../desktop-pet/desktopPetWindowGeometry";

export const DESKTOP_PET_WINDOW_LABEL = "desktop-pet";

const DESKTOP_PET_STATE_EVENT = "desktop-pet-state";
const DESKTOP_PET_ACTION_EVENT = "desktop-pet-action";
const DESKTOP_PET_READY_EVENT = "desktop-pet-ready";
const DESKTOP_PET_PROBE_EVENT = "desktop-pet-probe";
const DESKTOP_PET_CLOSE_REQUESTED_EVENT = "desktop-pet-close-requested";
const DESKTOP_PET_MOVE_SETTLE_MS = 120;

export type DesktopPetWindowSnapshot = {
  label: string;
  mood: DesktopPetMood;
  preferences: DesktopPetPreferences;
};

export type DesktopPetPreferencesPatch = {
  position?: DesktopPetPosition | null;
  size?: DesktopPetSize;
  visible?: boolean;
};

export type DesktopPetControlPatch = Pick<DesktopPetPreferencesPatch, "size" | "visible">;

export type DesktopPetHost = {
  sync(snapshot: DesktopPetWindowSnapshot): Promise<void>;
  listen(listener: (patch: DesktopPetPreferencesPatch) => void): Promise<() => void>;
};

export type DesktopPetWindowClient = {
  listen(listener: (snapshot: DesktopPetWindowSnapshot) => void): Promise<() => void>;
  moveBy(delta: DesktopPetPosition): Promise<void>;
  requestPreferences(patch: DesktopPetControlPatch): Promise<void>;
  startDragging(): Promise<void>;
};

export function createDesktopNativePetHost(): DesktopPetHost | null {
  return hasTauriRuntime() && isWindowsRuntime() ? new TauriDesktopPetHost() : null;
}

export function createDesktopNativePetWindowClient(): DesktopPetWindowClient {
  if (!hasTauriRuntime()) {
    throw new Error("The desktop pet window requires the Tauri runtime.");
  }
  return new TauriDesktopPetWindowClient();
}

class TauriDesktopPetHost implements DesktopPetHost {
  private appliedSnapshot: DesktopPetWindowSnapshot | null = null;
  private applyQueue: Promise<void> = Promise.resolve();
  private latestSnapshot: DesktopPetWindowSnapshot | null = null;
  private moveTimer: ReturnType<typeof setTimeout> | null = null;
  private ready = false;
  private listening = false;

  async sync(snapshot: DesktopPetWindowSnapshot): Promise<void> {
    this.latestSnapshot = snapshot;
    if (!this.ready && snapshot.preferences.visible) {
      return;
    }
    await this.scheduleApply();
  }

  async listen(listener: (patch: DesktopPetPreferencesPatch) => void): Promise<() => void> {
    if (this.listening) {
      throw new Error("The desktop pet host is already listening.");
    }
    this.listening = true;
    try {
      const petWindow = await requireDesktopPetWindow();
      const unlistenReady = await listen(DESKTOP_PET_READY_EVENT, () => {
        this.ready = true;
        void this.scheduleApply().catch(reportDesktopPetError);
      });
      const unlistenAction = await listen<unknown>(DESKTOP_PET_ACTION_EVENT, ({ payload }) => {
        listener(parseDesktopPetControlPatch(payload));
      });
      const unlistenClose = await listen(DESKTOP_PET_CLOSE_REQUESTED_EVENT, () => {
        listener({ visible: false });
      });
      const unlistenMoved = await petWindow.onMoved(({ payload }) => {
        if (this.moveTimer !== null) {
          clearTimeout(this.moveTimer);
        }
        this.moveTimer = setTimeout(() => {
          this.moveTimer = null;
          void petWindow.outerSize()
            .then((size) => listener({
              position: desktopPetWindowCenter(payload, size),
            }))
            .catch(reportDesktopPetError);
        }, DESKTOP_PET_MOVE_SETTLE_MS);
      });

      await emitTo(DESKTOP_PET_WINDOW_LABEL, DESKTOP_PET_PROBE_EVENT);

      return () => {
        if (this.moveTimer !== null) {
          clearTimeout(this.moveTimer);
          this.moveTimer = null;
        }
        unlistenMoved();
        unlistenClose();
        unlistenAction();
        unlistenReady();
        this.listening = false;
        this.ready = false;
      };
    } catch (error) {
      this.listening = false;
      throw error;
    }
  }

  private scheduleApply(): Promise<void> {
    const scheduled = this.applyQueue.then(() => this.applyLatestSnapshot());
    this.applyQueue = scheduled.catch(() => undefined);
    return scheduled;
  }

  private async applyLatestSnapshot(): Promise<void> {
    const snapshot = this.latestSnapshot;
    if (!snapshot) {
      return;
    }
    const petWindow = await requireDesktopPetWindow();
    if (!this.ready) {
      if (!snapshot.preferences.visible) {
        await petWindow.hide();
      }
      return;
    }

    const previous = this.appliedSnapshot;
    const sizeChanged = previous?.preferences.size !== snapshot.preferences.size;
    const positionChanged = !samePosition(
      previous?.preferences.position ?? null,
      snapshot.preferences.position,
    );
    if (!previous || sizeChanged || positionChanged) {
      await applyDesktopPetGeometry(petWindow, snapshot, previous, sizeChanged, positionChanged);
    }

    await emitTo(DESKTOP_PET_WINDOW_LABEL, DESKTOP_PET_STATE_EVENT, snapshot);
    if (snapshot.preferences.visible) {
      await petWindow.show();
    } else {
      await petWindow.hide();
    }
    this.appliedSnapshot = snapshot;
  }
}

class TauriDesktopPetWindowClient implements DesktopPetWindowClient {
  async listen(listener: (snapshot: DesktopPetWindowSnapshot) => void): Promise<() => void> {
    const emitReady = () => emitTo("main", DESKTOP_PET_READY_EVENT);
    const unlistenState = await listen<unknown>(DESKTOP_PET_STATE_EVENT, ({ payload }) => {
      listener(parseDesktopPetWindowSnapshot(payload));
    });
    const unlistenProbe = await listen(DESKTOP_PET_PROBE_EVENT, () => {
      void emitReady().catch(reportDesktopPetError);
    });
    await emitReady();
    return () => {
      unlistenProbe();
      unlistenState();
    };
  }

  async moveBy(delta: DesktopPetPosition): Promise<void> {
    const petWindow = getCurrentWindow();
    const [position, scaleFactor] = await Promise.all([
      petWindow.outerPosition(),
      petWindow.scaleFactor(),
    ]);
    await petWindow.setPosition(new PhysicalPosition(
      position.x + delta.x * scaleFactor,
      position.y + delta.y * scaleFactor,
    ));
  }

  requestPreferences(patch: DesktopPetControlPatch): Promise<void> {
    return emitTo("main", DESKTOP_PET_ACTION_EVENT, patch);
  }

  async startDragging(): Promise<void> {
    await getCurrentWindow().startDragging();
  }
}

async function applyDesktopPetGeometry(
  petWindow: WebviewWindow,
  snapshot: DesktopPetWindowSnapshot,
  previous: DesktopPetWindowSnapshot | null,
  sizeChanged: boolean,
  positionChanged: boolean,
): Promise<void> {
  let currentCenter: DesktopPetPosition | null = null;
  if (previous && sizeChanged && !positionChanged) {
    const [position, size] = await Promise.all([
      petWindow.outerPosition(),
      petWindow.outerSize(),
    ]);
    currentCenter = desktopPetWindowCenter(position, size);
  }

  if (!previous || sizeChanged) {
    const logicalSize = desktopPetWindowLogicalSize(snapshot.preferences.size);
    await petWindow.setSize(new LogicalSize(logicalSize.width, logicalSize.height));
  }
  const windowSize = await petWindow.outerSize();
  const desiredCenter = positionChanged
    ? snapshot.preferences.position
    : currentCenter ?? snapshot.preferences.position;
  const monitor = await resolveDesktopPetMonitor(desiredCenter);
  const desiredTopLeft = desiredCenter
    ? desktopPetWindowTopLeft(desiredCenter, windowSize)
    : defaultDesktopPetWindowTopLeft(windowSize, monitor.workArea);
  const topLeft = clampDesktopPetWindowTopLeft(desiredTopLeft, windowSize, monitor.workArea);
  await petWindow.setPosition(new PhysicalPosition(topLeft.x, topLeft.y));
}

async function resolveDesktopPetMonitor(position: DesktopPetPosition | null): Promise<Monitor> {
  const monitor = position ? await monitorFromPoint(position.x, position.y) : null;
  const fallback = monitor ?? await primaryMonitor();
  if (!fallback) {
    throw new Error("No Windows monitor is available for the desktop pet.");
  }
  return fallback;
}

async function requireDesktopPetWindow(): Promise<WebviewWindow> {
  const window = await WebviewWindow.getByLabel(DESKTOP_PET_WINDOW_LABEL);
  if (!window) {
    throw new Error(`The ${DESKTOP_PET_WINDOW_LABEL} window was not created.`);
  }
  return window;
}

function parseDesktopPetWindowSnapshot(value: unknown): DesktopPetWindowSnapshot {
  if (!isRecord(value)
    || typeof value.label !== "string"
    || !isDesktopPetMood(value.mood)
    || !isDesktopPetPreferences(value.preferences)) {
    throw new Error("Received an invalid desktop pet window snapshot.");
  }
  return {
    label: value.label,
    mood: value.mood,
    preferences: value.preferences,
  };
}

function parseDesktopPetControlPatch(value: unknown): DesktopPetControlPatch {
  if (!isRecord(value)) {
    throw new Error("Received an invalid desktop pet control update.");
  }
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.some((key) => key !== "size" && key !== "visible")) {
    throw new Error("Received an unsupported desktop pet control update.");
  }
  if (value.size !== undefined && !isDesktopPetSize(value.size)) {
    throw new Error("Received an invalid desktop pet size update.");
  }
  if (value.visible !== undefined && typeof value.visible !== "boolean") {
    throw new Error("Received an invalid desktop pet visibility update.");
  }
  return {
    ...(value.size === undefined ? {} : { size: value.size }),
    ...(value.visible === undefined ? {} : { visible: value.visible }),
  };
}

function samePosition(left: DesktopPetPosition | null, right: DesktopPetPosition | null): boolean {
  return left === right || (
    left !== null
    && right !== null
    && left.x === right.x
    && left.y === right.y
  );
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

function reportDesktopPetError(error: unknown): void {
  console.error("[desktop-pet] Native window operation failed.", error);
}
