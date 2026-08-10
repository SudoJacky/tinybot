import { describe, expect, test, vi } from "vitest";
import { DEFAULT_SHORTCUT_PREFERENCES } from "../settings/appShortcuts";
import { createDesktopNativeShortcutClient } from "./desktopNativeShortcuts";

describe("desktop native shortcuts", () => {
  test("stays inactive outside the Tauri runtime", () => {
    const client = createDesktopNativeShortcutClient({
      hasTauriRuntime: () => false,
      invoke: vi.fn(),
      listen: vi.fn(),
    });

    expect(client).toBeNull();
  });

  test("syncs every configurable shortcut including cleared bindings", async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    const client = createDesktopNativeShortcutClient({
      hasTauriRuntime: () => true,
      invoke,
      listen: vi.fn(),
    });

    await client?.sync({
      ...DEFAULT_SHORTCUT_PREFERENCES,
      "open-docs": null,
      "toggle-sidebar": "Ctrl+Alt+B",
    });

    expect(invoke).toHaveBeenCalledWith("desktop_set_menu_shortcuts", {
      bindings: [
        { id: "new-chat", accelerator: "Ctrl+N" },
        { id: "stop-generation", accelerator: "Ctrl+." },
        { id: "toggle-theme", accelerator: "Ctrl+Shift+T" },
        { id: "toggle-sidebar", accelerator: "Ctrl+Alt+B" },
        { id: "open-settings", accelerator: "Ctrl+," },
        { id: "open-docs", accelerator: null },
      ],
    });
  });

  test("forwards native menu commands and returns the unlisten callback", async () => {
    const unlisten = vi.fn();
    let dispatch: ((event: { payload: { id: string } }) => void) | undefined;
    const client = createDesktopNativeShortcutClient({
      hasTauriRuntime: () => true,
      invoke: vi.fn(),
      listen: vi.fn(async (_event, listener) => {
        dispatch = listener;
        return unlisten;
      }),
    });
    const listener = vi.fn();

    const stop = await client?.listen(listener);
    dispatch?.({ payload: { id: "open-settings" } });
    stop?.();

    expect(listener).toHaveBeenCalledWith("open-settings");
    expect(unlisten).toHaveBeenCalledOnce();
  });
});
