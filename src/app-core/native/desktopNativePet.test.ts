// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDesktopNativePetHost } from "./desktopNativePet";

const mocks = vi.hoisted(() => ({
  eventListeners: new Map<string, () => void>(),
  mainWindow: {
    innerPosition: vi.fn(async () => ({ x: 100, y: 80 })),
    innerSize: vi.fn(async () => ({ width: 1120, height: 760 })),
  },
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
  getCurrentWindow: vi.fn(() => mocks.mainWindow),
  currentMonitor: vi.fn(async () => mocks.monitor),
  monitorFromPoint: vi.fn(async () => null),
  primaryMonitor: vi.fn(async () => mocks.monitor),
}));

describe("desktop native pet host", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.eventListeners.clear();
    mocks.mainWindow.innerPosition.mockResolvedValue({ x: 100, y: 80 });
    mocks.mainWindow.innerSize.mockResolvedValue({ width: 1120, height: 760 });
    mocks.petWindow.outerSize.mockResolvedValue({ width: 76, height: 76 });
    mocks.monitor.workArea = {
      position: { x: 0, y: 0 },
      size: { width: 1920, height: 1040 },
    };
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue("Windows");
  });

  it("recalculates the main window bottom-right after moving and resizing main, even with no stored position", async () => {
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
      expect.objectContaining({ x: 1132, y: 752 }),
    );

    mocks.mainWindow.innerPosition.mockResolvedValue({ x: 300, y: 120 });
    mocks.mainWindow.innerSize.mockResolvedValue({ width: 800, height: 600 });
    await host!.resetPosition(snapshot);

    expect(mocks.petWindow.setPosition).toHaveBeenCalledTimes(2);
    expect(mocks.petWindow.setPosition).toHaveBeenLastCalledWith(
      expect.objectContaining({ x: 1012, y: 632 }),
    );
  });

  it("uses physical main-window bounds on a secondary display with negative coordinates", async () => {
    mocks.monitor.workArea = { position: { x: -3840, y: 0 }, size: { width: 3840, height: 2080 } };
    mocks.mainWindow.innerPosition.mockResolvedValue({ x: -3600, y: 160 });
    mocks.mainWindow.innerSize.mockResolvedValue({ width: 2240, height: 1520 });
    mocks.petWindow.outerSize.mockResolvedValue({ width: 152, height: 152 });
    const host = createDesktopNativePetHost()!;
    await host.listen(() => undefined);
    mocks.eventListeners.get("desktop-pet-ready")?.();
    await host.resetPosition({ label: "Tinybot", mood: "calm", preferences: {
      appearance: "dimensional", visible: true, size: "medium", position: { x: 700, y: 500 },
    } });
    expect(mocks.petWindow.setPosition).toHaveBeenLastCalledWith(expect.objectContaining({ x: -1524, y: 1516 }));
  });

  it("keeps the pet visible when the main window's corner extends beyond the work area", async () => {
    mocks.mainWindow.innerPosition.mockResolvedValue({ x: 1500, y: 700 });
    const host = createDesktopNativePetHost()!;
    await host.listen(() => undefined);
    mocks.eventListeners.get("desktop-pet-ready")?.();
    await host.resetPosition({ label: "Tinybot", mood: "calm", preferences: {
      appearance: "dimensional", visible: true, size: "medium", position: null,
    } });
    expect(mocks.petWindow.setPosition).toHaveBeenLastCalledWith(expect.objectContaining({ x: 1844, y: 964 }));
  });

  it("preserves a manually saved position during normal startup", async () => {
    const host = createDesktopNativePetHost()!;
    await host.listen(() => undefined);
    mocks.eventListeners.get("desktop-pet-ready")?.();
    await host.sync({ label: "Tinybot", mood: "calm", preferences: {
      appearance: "dimensional", visible: true, size: "medium", position: { x: 700, y: 500 },
    } });
    expect(mocks.petWindow.setPosition).toHaveBeenLastCalledWith(expect.objectContaining({ x: 662, y: 462 }));
    expect(mocks.mainWindow.innerPosition).not.toHaveBeenCalled();
  });
});
