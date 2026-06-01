import { describe, expect, test } from "vitest";
import {
  DESKTOP_WORKBENCH_LAYOUT_STORAGE_KEY,
  createDefaultWorkbenchLayout,
  loadWorkbenchLayout,
  persistWorkbenchLayout,
  resizeWorkbenchPanel,
  toggleWorkbenchPanel,
} from "./desktopWorkbenchLayout";

class MemoryStorage implements Pick<Storage, "getItem" | "setItem"> {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe("desktop workbench layout state", () => {
  test("creates a stable default desktop layout", () => {
    expect(createDefaultWorkbenchLayout()).toEqual({
      sidebar: { visible: true, size: 260 },
      inspector: { visible: true, size: 360 },
      bottom: { visible: false, size: 220 },
    });
  });

  test("clamps resized panels within desktop min and max constraints", () => {
    const layout = createDefaultWorkbenchLayout();

    expect(resizeWorkbenchPanel(layout, "sidebar", 120).sidebar.size).toBe(220);
    expect(resizeWorkbenchPanel(layout, "inspector", 900).inspector.size).toBe(520);
    expect(resizeWorkbenchPanel(layout, "bottom", 80).bottom.size).toBe(160);
  });

  test("toggles optional panel visibility without changing its last valid size", () => {
    const layout = createDefaultWorkbenchLayout();
    const hiddenInspector = toggleWorkbenchPanel(layout, "inspector", false);
    const restoredInspector = toggleWorkbenchPanel(hiddenInspector, "inspector", true);

    expect(hiddenInspector.inspector).toEqual({ visible: false, size: 360 });
    expect(restoredInspector.inspector).toEqual({ visible: true, size: 360 });
  });

  test("persists and restores valid panel preferences", () => {
    const storage = new MemoryStorage();
    const layout = resizeWorkbenchPanel(
      toggleWorkbenchPanel(createDefaultWorkbenchLayout(), "bottom", true),
      "bottom",
      260,
    );

    persistWorkbenchLayout(layout, storage);

    expect(storage.getItem(DESKTOP_WORKBENCH_LAYOUT_STORAGE_KEY)).toContain("\"bottom\"");
    expect(loadWorkbenchLayout({ storage, viewportWidth: 1440 })).toEqual(layout);
  });

  test("normalizes corrupted storage and invalid narrow-window panel state", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      DESKTOP_WORKBENCH_LAYOUT_STORAGE_KEY,
      JSON.stringify({
        sidebar: { visible: true, size: 999 },
        inspector: { visible: true, size: 480 },
        bottom: { visible: true, size: 90 },
      }),
    );

    expect(loadWorkbenchLayout({ storage, viewportWidth: 920 })).toEqual({
      sidebar: { visible: true, size: 300 },
      inspector: { visible: false, size: 480 },
      bottom: { visible: false, size: 160 },
    });
  });
});
