import { describe, expect, it } from "vitest";
import { desktopPetQuickChatTopLeft } from "./desktopPetQuickChatGeometry";

describe("desktop pet quick chat geometry", () => {
  it("opens beside the pet and keeps the panel inside the work area", () => {
    expect(desktopPetQuickChatTopLeft(
      { position: { x: 120, y: 800 }, size: { width: 76, height: 76 } },
      { width: 420, height: 600 },
      { position: { x: 0, y: 0 }, size: { width: 1920, height: 1040 } },
    )).toEqual({ x: 208, y: 440 });
  });

  it("opens to the left when the pet is close to the right edge", () => {
    expect(desktopPetQuickChatTopLeft(
      { position: { x: 1810, y: 400 }, size: { width: 76, height: 76 } },
      { width: 420, height: 600 },
      { position: { x: 0, y: 0 }, size: { width: 1920, height: 1040 } },
    )).toEqual({ x: 1378, y: 138 });
  });

  it("supports negative-coordinate monitors", () => {
    expect(desktopPetQuickChatTopLeft(
      { position: { x: -1900, y: 20 }, size: { width: 76, height: 76 } },
      { width: 420, height: 600 },
      { position: { x: -1920, y: 0 }, size: { width: 1920, height: 1040 } },
    )).toEqual({ x: -1812, y: 0 });
  });
});
