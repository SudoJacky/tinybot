import { describe, expect, it } from "vitest";
import {
  createTinyOsUiState,
  loadTinyOsLayout,
  reduceTinyOsUiState,
  saveTinyOsLayout,
  tinyOsLayoutModeForWidth,
  tinyOsLayoutStorageKey,
} from "./tinyOsUiState";

const bounds = { height: 500, width: 700 };

describe("TinyOS UI state", () => {
  it("keeps moved and resized windows inside the desktop", () => {
    const initial = createTinyOsUiState({ appIds: ["files"], bounds, layoutMode: "workspace" });
    const next = reduceTinyOsUiState(initial, {
      appId: "files",
      rect: { height: 900, width: 900, x: -300, y: 900 },
      type: "set_rect",
    });

    expect(next.windowLayout.files).toMatchObject({ height: 480, width: 680, x: 10, y: 10 });
  });

  it("minimizes, restores, maximizes, and resets deterministically", () => {
    const initial = createTinyOsUiState({ appIds: ["files", "terminal"], bounds, layoutMode: "workspace" });
    const minimized = reduceTinyOsUiState(initial, { appId: "terminal", type: "minimize" });
    expect(minimized.minimizedAppIds).toEqual(["terminal"]);
    expect(minimized.focusedAppId).toBe("files");

    const restored = reduceTinyOsUiState(minimized, { appId: "terminal", type: "focus" });
    expect(restored.minimizedAppIds).toEqual([]);
    const maximized = reduceTinyOsUiState(restored, { appId: "terminal", type: "maximize_toggle" });
    expect(maximized.windowLayout.terminal).toMatchObject({ height: 480, maximized: true, width: 680, x: 10, y: 10 });
    const unmaximized = reduceTinyOsUiState(maximized, { appId: "terminal", type: "maximize_toggle" });
    expect(unmaximized.windowLayout.terminal?.maximized).toBe(false);

    const reset = reduceTinyOsUiState(unmaximized, { type: "reset" });
    expect(reset.windowLayout).toEqual(initial.windowLayout);
  });

  it("uses one-window compact mode and spatial workspace mode", () => {
    expect(tinyOsLayoutModeForWidth(520)).toBe("compact");
    expect(tinyOsLayoutModeForWidth(521)).toBe("workspace");
    const compact = createTinyOsUiState({ appIds: ["files"], bounds: { height: 400, width: 420 }, layoutMode: "compact" });
    expect(compact.windowLayout.files).toMatchObject({ height: 380, width: 400, x: 10, y: 10 });

    const workspace = createTinyOsUiState({ appIds: ["files", "terminal"], bounds, layoutMode: "workspace" });
    expect(workspace.windowLayout.files).toMatchObject({ height: 365, width: 462, x: 10, y: 28 });
    expect(workspace.windowLayout.terminal).toMatchObject({ height: 307, width: 476, x: 214, y: 68 });
  });

  it("persists only versioned window layout and rejects incompatible data", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
    };
    const state = createTinyOsUiState({ appIds: ["files"], bounds, layoutMode: "workspace" });
    saveTinyOsLayout(storage, "workspace-a", state);
    expect(loadTinyOsLayout(storage, "workspace-a", "workspace")).toEqual(state.windowLayout);

    values.set(tinyOsLayoutStorageKey("workspace-a", "workspace"), JSON.stringify({ version: 0, windowLayout: {} }));
    expect(() => loadTinyOsLayout(storage, "workspace-a", "workspace")).toThrow(/version/i);
  });
});
