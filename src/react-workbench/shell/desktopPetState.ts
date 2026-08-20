export const DESKTOP_PET_STORAGE_KEY = "tinybot.ui.desktop-pet.v1";
export const DESKTOP_PET_MARGIN = 12;
export const DESKTOP_PET_TOP_INSET = 54;

export const DESKTOP_PET_SIZE_PIXELS = {
  small: 56,
  medium: 76,
  large: 104,
} as const;

export type DesktopPetSize = keyof typeof DESKTOP_PET_SIZE_PIXELS;

export type DesktopPetPosition = {
  x: number;
  y: number;
};

export type DesktopPetPreferences = {
  visible: boolean;
  size: DesktopPetSize;
  position: DesktopPetPosition | null;
};

export type DesktopPetViewport = {
  width: number;
  height: number;
};

export const DEFAULT_DESKTOP_PET_PREFERENCES: DesktopPetPreferences = {
  visible: true,
  size: "medium",
  position: null,
};

const DESKTOP_PET_SIZE_ORDER: DesktopPetSize[] = ["small", "medium", "large"];
const DESKTOP_PET_MIN_TOOLBAR_WIDTH = 76;

export function readDesktopPetPreferences(
  storage: Pick<Storage, "getItem">,
): DesktopPetPreferences {
  const serialized = storage.getItem(DESKTOP_PET_STORAGE_KEY);
  if (!serialized) return { ...DEFAULT_DESKTOP_PET_PREFERENCES };

  try {
    const value = JSON.parse(serialized) as unknown;
    if (!isRecord(value)) throw new Error("Stored desktop pet preferences must be an object.");
    const size = isDesktopPetSize(value.size) ? value.size : DEFAULT_DESKTOP_PET_PREFERENCES.size;
    const position = isRecord(value.position)
      && isFiniteNumber(value.position.x)
      && isFiniteNumber(value.position.y)
      ? { x: value.position.x, y: value.position.y }
      : null;
    return {
      visible: typeof value.visible === "boolean" ? value.visible : DEFAULT_DESKTOP_PET_PREFERENCES.visible,
      size,
      position,
    };
  } catch (error) {
    console.warn("[desktop-pet] Failed to restore saved preferences.", error);
    return { ...DEFAULT_DESKTOP_PET_PREFERENCES };
  }
}

export function writeDesktopPetPreferences(
  storage: Pick<Storage, "setItem">,
  preferences: DesktopPetPreferences,
): void {
  storage.setItem(DESKTOP_PET_STORAGE_KEY, JSON.stringify({
    ...preferences,
    position: preferences.position
      ? { x: Math.round(preferences.position.x), y: Math.round(preferences.position.y) }
      : null,
  }));
}

export function stepDesktopPetSize(size: DesktopPetSize, direction: -1 | 1): DesktopPetSize {
  const index = DESKTOP_PET_SIZE_ORDER.indexOf(size);
  return DESKTOP_PET_SIZE_ORDER[Math.max(0, Math.min(DESKTOP_PET_SIZE_ORDER.length - 1, index + direction))];
}

export function desktopPetFootprint(size: DesktopPetSize): { width: number; height: number } {
  const pixels = DESKTOP_PET_SIZE_PIXELS[size];
  return { width: Math.max(DESKTOP_PET_MIN_TOOLBAR_WIDTH, pixels), height: pixels };
}

export function clampDesktopPetPosition(
  position: DesktopPetPosition,
  size: DesktopPetSize,
  viewport: DesktopPetViewport,
): DesktopPetPosition {
  const footprint = desktopPetFootprint(size);
  const minX = DESKTOP_PET_MARGIN + footprint.width / 2;
  const maxX = Math.max(minX, viewport.width - DESKTOP_PET_MARGIN - footprint.width / 2);
  const minY = DESKTOP_PET_TOP_INSET + footprint.height / 2;
  const maxY = Math.max(minY, viewport.height - DESKTOP_PET_MARGIN - footprint.height / 2);
  return {
    x: clamp(position.x, minX, maxX),
    y: clamp(position.y, minY, maxY),
  };
}

export function defaultDesktopPetPosition(
  size: DesktopPetSize,
  viewport: DesktopPetViewport,
): DesktopPetPosition {
  const footprint = desktopPetFootprint(size);
  return clampDesktopPetPosition({
    x: viewport.width - DESKTOP_PET_MARGIN - footprint.width / 2,
    y: viewport.height - DESKTOP_PET_MARGIN - footprint.height / 2,
  }, size, viewport);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function isDesktopPetSize(value: unknown): value is DesktopPetSize {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(DESKTOP_PET_SIZE_PIXELS, value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
