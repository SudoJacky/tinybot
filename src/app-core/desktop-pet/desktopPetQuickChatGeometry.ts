import type {
  DesktopPetPixelSize,
  DesktopPetWorkArea,
} from "./desktopPetWindowGeometry";
import type { DesktopPetPosition } from "./desktopPetState";

export const DESKTOP_PET_QUICK_CHAT_GAP = 12;
export const DESKTOP_PET_QUICK_CHAT_LOGICAL_SIZE: DesktopPetPixelSize = {
  width: 420,
  height: 600,
};

export type DesktopPetWindowRect = {
  position: DesktopPetPosition;
  size: DesktopPetPixelSize;
};

export function desktopPetQuickChatTopLeft(
  pet: DesktopPetWindowRect,
  panelSize: DesktopPetPixelSize,
  workArea: DesktopPetWorkArea,
  gap = DESKTOP_PET_QUICK_CHAT_GAP,
): DesktopPetPosition {
  const workAreaLeft = workArea.position.x;
  const workAreaRight = workArea.position.x + workArea.size.width;
  const right = pet.position.x + pet.size.width + gap;
  const left = pet.position.x - panelSize.width - gap;
  const fitsRight = right + panelSize.width <= workAreaRight;
  const fitsLeft = left >= workAreaLeft;
  const x = fitsRight || !fitsLeft ? right : left;
  const petCenterY = pet.position.y + pet.size.height / 2;
  const y = petCenterY - panelSize.height / 2;

  return {
    x: clamp(x, workAreaLeft, Math.max(workAreaLeft, workAreaRight - panelSize.width)),
    y: clamp(
      y,
      workArea.position.y,
      Math.max(workArea.position.y, workArea.position.y + workArea.size.height - panelSize.height),
    ),
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
