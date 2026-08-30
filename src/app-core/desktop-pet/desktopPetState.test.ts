import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_DESKTOP_PET_PREFERENCES,
  DESKTOP_PET_STORAGE_KEY,
  clampDesktopPetPosition,
  defaultDesktopPetPosition,
  isDesktopPetPreferences,
  readDesktopPetPreferences,
  stepDesktopPetSize,
  writeDesktopPetPreferences,
} from "./desktopPetState";

describe("desktopPetState", () => {
  it("restores valid preferences and rejects malformed saved state", () => {
    const validStorage = {
      getItem: vi.fn(() => JSON.stringify({
        appearance: "classic",
        visible: false,
        size: "large",
        position: { x: 320, y: 240 },
      })),
      removeItem: vi.fn(),
      setItem: vi.fn(),
    };
    expect(readDesktopPetPreferences(validStorage)).toEqual({
      appearance: "classic",
      visible: false,
      size: "large",
      position: { x: 320, y: 240 },
    });
    expect(validStorage.setItem).not.toHaveBeenCalled();
    expect(validStorage.removeItem.mock.calls).toEqual([
      ["tinybot.ui.desktop-pet.v2"],
      ["tinybot.ui.desktop-pet.v1"],
    ]);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const malformedStorage = {
      getItem: vi.fn(() => "{"),
      removeItem: vi.fn(),
      setItem: vi.fn(),
    };
    expect(readDesktopPetPreferences(malformedStorage)).toEqual(DEFAULT_DESKTOP_PET_PREFERENCES);
    expect(warn).toHaveBeenCalledWith(
      "[desktop-pet] Failed to restore saved preferences.",
      expect.any(Error),
    );
    expect(malformedStorage.setItem).not.toHaveBeenCalled();
    expect(malformedStorage.removeItem).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("surfaces storage cleanup failures after parsing valid preferences", () => {
    const cleanupError = new Error("storage cleanup failed");
    const storage = {
      getItem: vi.fn(() => JSON.stringify({
        appearance: "dimensional",
        visible: true,
        size: "medium",
        position: null,
      })),
      removeItem: vi.fn(() => {
        throw cleanupError;
      }),
      setItem: vi.fn(),
    };

    expect(() => readDesktopPetPreferences(storage)).toThrow(cleanupError);
  });

  it("preserves physical positions and adds the default appearance when migrating v2 preferences", () => {
    const storage = {
      getItem: vi.fn((key: string) => key === "tinybot.ui.desktop-pet.v2"
        ? JSON.stringify({ visible: false, size: "large", position: { x: -320, y: 240 } })
        : null),
      removeItem: vi.fn(),
      setItem: vi.fn(),
    };

    expect(readDesktopPetPreferences(storage)).toEqual({
      appearance: "dimensional",
      visible: false,
      size: "large",
      position: { x: -320, y: 240 },
    });
    expect(storage.getItem.mock.calls).toEqual([
      ["tinybot.ui.desktop-pet.v3"],
      ["tinybot.ui.desktop-pet.v2"],
    ]);
    expect(storage.setItem).toHaveBeenCalledWith("tinybot.ui.desktop-pet.v3", JSON.stringify({
      appearance: "dimensional",
      visible: false,
      size: "large",
      position: { x: -320, y: 240 },
    }));
    expect(storage.removeItem.mock.calls).toEqual([
      ["tinybot.ui.desktop-pet.v2"],
      ["tinybot.ui.desktop-pet.v1"],
    ]);
  });

  it("discards viewport-relative positions when migrating v1 preferences", () => {
    const storage = {
      getItem: vi.fn((key: string) => key === "tinybot.ui.desktop-pet.v1"
        ? JSON.stringify({ visible: false, size: "large", position: { x: 320, y: 240 } })
        : null),
      removeItem: vi.fn(),
      setItem: vi.fn(),
    };

    expect(readDesktopPetPreferences(storage)).toEqual({
      appearance: "dimensional",
      visible: false,
      size: "large",
      position: null,
    });
    expect(storage.getItem.mock.calls).toEqual([
      ["tinybot.ui.desktop-pet.v3"],
      ["tinybot.ui.desktop-pet.v2"],
      ["tinybot.ui.desktop-pet.v1"],
    ]);
    expect(storage.setItem).toHaveBeenCalledWith("tinybot.ui.desktop-pet.v3", JSON.stringify({
      appearance: "dimensional",
      visible: false,
      size: "large",
      position: null,
    }));
    expect(storage.removeItem.mock.calls).toEqual([
      ["tinybot.ui.desktop-pet.v2"],
      ["tinybot.ui.desktop-pet.v1"],
    ]);
  });

  it("persists rounded coordinates", () => {
    const storage = { setItem: vi.fn() };
    writeDesktopPetPreferences(storage, {
      appearance: "classic",
      visible: true,
      size: "small",
      position: { x: 123.6, y: 456.2 },
    });

    expect(storage.setItem).toHaveBeenCalledWith(DESKTOP_PET_STORAGE_KEY, JSON.stringify({
      appearance: "classic",
      visible: true,
      size: "small",
      position: { x: 124, y: 456 },
    }));
  });

  it("uses bounded three-step sizing", () => {
    expect(stepDesktopPetSize("small", -1)).toBe("small");
    expect(stepDesktopPetSize("small", 1)).toBe("medium");
    expect(stepDesktopPetSize("medium", 1)).toBe("large");
    expect(stepDesktopPetSize("large", 1)).toBe("large");
  });

  it("keeps every size below the window frame and inside the visible viewport", () => {
    const viewport = { width: 800, height: 600 };
    expect(clampDesktopPetPosition({ x: -100, y: -100 }, "medium", viewport)).toEqual({ x: 50, y: 92 });
    expect(clampDesktopPetPosition({ x: 900, y: 700 }, "medium", viewport)).toEqual({ x: 750, y: 550 });
    expect(defaultDesktopPetPosition("large", viewport)).toEqual({ x: 736, y: 536 });
  });

  it("validates complete preference payloads", () => {
    expect(isDesktopPetPreferences({ appearance: "dimensional", visible: true, size: "medium", position: { x: -120, y: 80 } })).toBe(true);
    expect(isDesktopPetPreferences({ appearance: "glossy", visible: true, size: "medium", position: null })).toBe(false);
    expect(isDesktopPetPreferences({ appearance: "classic", visible: true, size: "huge", position: null })).toBe(false);
    expect(isDesktopPetPreferences({ appearance: "classic", visible: true, size: "small", position: { x: Number.NaN, y: 80 } })).toBe(false);
  });
});
