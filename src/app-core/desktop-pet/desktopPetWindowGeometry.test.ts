import { describe, expect, it } from "vitest";
import {
  clampDesktopPetWindowTopLeft,
  defaultDesktopPetWindowTopLeft,
  desktopPetWindowCenter,
  desktopPetWindowLogicalSize,
  desktopPetWindowTopLeft,
} from "./desktopPetWindowGeometry";

describe("desktopPetWindowGeometry", () => {
  it("preserves the grabbed window center while converting native coordinates", () => {
    const size = { width: 114, height: 156 };
    const center = desktopPetWindowCenter({ x: -1300, y: 240 }, size);
    expect(center).toEqual({ x: -1243, y: 318 });
    expect(desktopPetWindowTopLeft(center, size)).toEqual({ x: -1300, y: 240 });
  });

  it("clamps against a negative-coordinate monitor work area", () => {
    const workArea = {
      position: { x: -1920, y: 0 },
      size: { width: 1920, height: 1040 },
    };
    const size = { width: 104, height: 104 };

    expect(clampDesktopPetWindowTopLeft({ x: -2100, y: -80 }, size, workArea))
      .toEqual({ x: -1920, y: 0 });
    expect(clampDesktopPetWindowTopLeft({ x: 60, y: 1100 }, size, workArea))
      .toEqual({ x: -104, y: 936 });
  });

  it("places a new pet above the taskbar inside the primary work area", () => {
    const workArea = {
      position: { x: 0, y: 0 },
      size: { width: 2560, height: 1400 },
    };
    expect(defaultDesktopPetWindowTopLeft({ width: 104, height: 104 }, workArea))
      .toEqual({ x: 2444, y: 1284 });
  });

  it("uses a window footprint that contains both the mascot and its toolbar", () => {
    expect(desktopPetWindowLogicalSize("small")).toEqual({ width: 76, height: 56 });
    expect(desktopPetWindowLogicalSize("large")).toEqual({ width: 104, height: 104 });
  });
});
