// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDesktopNativePetQuickChatHost } from "./desktopNativePetQuickChat";

const mocks = vi.hoisted(() => ({
  events: new Map<string, (event: { payload?: unknown }) => void>(),
  exists: false,
  invoke: vi.fn(async () => { mocks.exists = true; }),
  emit: vi.fn(async () => undefined),
  panel: {
    outerSize: vi.fn(async () => ({ width: 420, height: 600 })),
    setPosition: vi.fn(async () => undefined), show: vi.fn(async () => undefined), setFocus: vi.fn(async () => undefined),
  },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  emitTo: mocks.emit,
  listen: vi.fn(async (name: string, handler: (event: { payload?: unknown }) => void) => {
    mocks.events.set(name, handler);
    return () => { mocks.events.delete(name); };
  }),
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({ WebviewWindow: {
  getByLabel: vi.fn(async (label: string) => label === "desktop-pet" ? {
    outerPosition: async () => ({ x: 100, y: 100 }), outerSize: async () => ({ width: 76, height: 76 }),
  } : mocks.exists ? mocks.panel : null),
} }));
vi.mock("@tauri-apps/api/window", () => ({
  PhysicalPosition: class { constructor(public x: number, public y: number) {} },
  getCurrentWindow: vi.fn(),
  monitorFromPoint: vi.fn(async () => ({ workArea: { position: { x: 0, y: 0 }, size: { width: 1920, height: 1080 } } })),
  primaryMonitor: vi.fn(),
}));
const request = (id: string) => ({ schemaVersion: "tinybot.desktop_pet_quick_chat.v2", requestId: id, draft: id, attachments: [] });
const fire = (name: string, payload?: unknown) => mocks.events.get(`desktop-pet-quick-chat-${name}`)!({ payload });

beforeEach(() => {
  vi.clearAllMocks(); mocks.events.clear(); mocks.exists = false;
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Windows");
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("lazy quick chat host", () => {
  it("creates only on request, waits for ready and reuses the window", async () => {
    const stop = await createDesktopNativePetQuickChatHost()!.listen(() => undefined);
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.emit).not.toHaveBeenCalled();
    fire("open-request", request("first"));
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("desktop_ensure_pet_quick_chat_window"));
    expect(mocks.panel.show).not.toHaveBeenCalled();
    fire("ready");
    await vi.waitFor(() => expect(mocks.panel.show).toHaveBeenCalledTimes(1));
    expect(mocks.emit).toHaveBeenCalledWith("desktop-pet-chat", "desktop-pet-quick-chat-present", request("first"));
    fire("open-request", request("second"));
    await vi.waitFor(() => expect(mocks.panel.show).toHaveBeenCalledTimes(2));
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    stop();
  });

  it("keeps the newest pending request while a cold window loads", async () => {
    let finish!: () => void;
    mocks.invoke.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const stop = await createDesktopNativePetQuickChatHost()!.listen(() => undefined);
    fire("open-request", request("old"));
    await vi.waitFor(() => expect(finish).toBeDefined());
    fire("open-request", request("new"));
    mocks.exists = true;
    fire("ready");
    finish();
    await vi.waitFor(() => expect(mocks.panel.show).toHaveBeenCalledTimes(1));
    expect(mocks.emit).toHaveBeenCalledWith("desktop-pet-chat", "desktop-pet-quick-chat-present", request("new"));
    stop();
  });

  it("does not present after the host is disposed during creation", async () => {
    let finish!: () => void;
    mocks.invoke.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const stop = await createDesktopNativePetQuickChatHost()!.listen(() => undefined);
    fire("open-request", request("first"));
    await vi.waitFor(() => expect(finish).toBeDefined());
    stop(); finish();
    await Promise.resolve(); await Promise.resolve();
    expect(mocks.panel.show).not.toHaveBeenCalled();
  });
});
