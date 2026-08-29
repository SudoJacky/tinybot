// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDesktopNativePetHost } from "./desktopNativePet";

const mocks = vi.hoisted(() => ({
  eventListeners: new Map<string, () => void>(),
  monitor: {
    workArea: {
      position: { x: 0, y: 0 },
      size: { width: 1920, height: 1040 },
    },
  },
  petWindow: {
    hide: vi.fn(async () => undefined),
    onMoved: vi.fn(async () => () => undefined),
    outerSize: vi.fn(async () => ({ width: 76, height: 76 })),
    setPosition: vi.fn(async () => undefined),
    setSize: vi.fn(async () => undefined),
    show: vi.fn(async () => undefined),
  },
}));

vi.mock("@tauri-apps/api/event", () => ({
  emitTo: vi.fn(async () => undefined),
  listen: vi.fn(async (name: string, listener: () => void) => {
    mocks.eventListeners.set(name, listener);
    return () => mocks.eventListeners.delete(name);
  }),
}));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  WebviewWindow: {
    getByLabel: vi.fn(async () => mocks.petWindow),
  },
}));

vi.mock("@tauri-apps/api/window", () => ({
  LogicalSize: class LogicalSize {
    constructor(public width: number, public height: number) {}
  },
  PhysicalPosition: class PhysicalPosition {
    constructor(public x: number, public y: number) {}
  },
  getCurrentWindow: vi.fn(),
  monitorFromPoint: vi.fn(async () => null),
  primaryMonitor: vi.fn(async () => mocks.monitor),
}));

describe("desktop native pet host", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.eventListeners.clear();
    mocks.monitor.workArea = {
      position: { x: 0, y: 0 },
      size: { width: 1920, height: 1040 },
    };
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue("Windows");
  });

  it("recalculates the safe primary-monitor position when the stored position is already unset", async () => {
    const host = createDesktopNativePetHost();
    expect(host).not.toBeNull();
    await host!.listen(() => undefined);
    mocks.eventListeners.get("desktop-pet-ready")?.();

    const snapshot = {
      label: "Tinybot is calm",
      mood: "calm" as const,
      preferences: {
        appearance: "dimensional" as const,
        visible: true,
        size: "medium" as const,
        position: null,
      },
    };
    await host!.sync(snapshot);
    expect(mocks.petWindow.setPosition).toHaveBeenLastCalledWith(
      expect.objectContaining({ x: 1832, y: 952 }),
    );

    mocks.monitor.workArea = {
      position: { x: 0, y: 0 },
      size: { width: 1280, height: 720 },
    };
    await host!.resetPosition(snapshot);

    expect(mocks.petWindow.setPosition).toHaveBeenCalledTimes(2);
    expect(mocks.petWindow.setPosition).toHaveBeenLastCalledWith(
      expect.objectContaining({ x: 1192, y: 632 }),
    );
  });
});
