import {
  DESKTOP_PET_MARGIN,
  desktopPetFootprint,
  type DesktopPetPosition,
  type DesktopPetSize,
} from "./desktopPetState";

export type DesktopPetPixelSize = {
  width: number;
  height: number;
};

export type DesktopPetWorkArea = {
  position: DesktopPetPosition;
  size: DesktopPetPixelSize;
};

export function desktopPetWindowLogicalSize(size: DesktopPetSize): DesktopPetPixelSize {
  return desktopPetFootprint(size);
}

export function desktopPetWindowCenter(
  topLeft: DesktopPetPosition,
  windowSize: DesktopPetPixelSize,
): DesktopPetPosition {
  return {
    x: topLeft.x + windowSize.width / 2,
    y: topLeft.y + windowSize.height / 2,
  };
}

export function desktopPetWindowTopLeft(
  center: DesktopPetPosition,
  windowSize: DesktopPetPixelSize,
): DesktopPetPosition {
  return {
    x: center.x - windowSize.width / 2,
    y: center.y - windowSize.height / 2,
  };
}

export function defaultDesktopPetWindowTopLeft(
  windowSize: DesktopPetPixelSize,
  workArea: DesktopPetWorkArea,
): DesktopPetPosition {
  return clampDesktopPetWindowTopLeft({
    x: workArea.position.x + workArea.size.width - windowSize.width - DESKTOP_PET_MARGIN,
    y: workArea.position.y + workArea.size.height - windowSize.height - DESKTOP_PET_MARGIN,
  }, windowSize, workArea);
}

export function clampDesktopPetWindowTopLeft(
  position: DesktopPetPosition,
  windowSize: DesktopPetPixelSize,
  workArea: DesktopPetWorkArea,
): DesktopPetPosition {
  const maximumX = Math.max(
    workArea.position.x,
    workArea.position.x + workArea.size.width - windowSize.width,
  );
  const maximumY = Math.max(
    workArea.position.y,
    workArea.position.y + workArea.size.height - windowSize.height,
  );
  return {
    x: clamp(position.x, workArea.position.x, maximumX),
    y: clamp(position.y, workArea.position.y, maximumY),
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
