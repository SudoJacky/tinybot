import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Minus, Plus, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { TinybotMascot, type TinybotMascotMood } from "../chat/TinybotMascot";
import {
  DESKTOP_PET_SIZE_PIXELS,
  clampDesktopPetPosition,
  defaultDesktopPetPosition,
  desktopPetFootprint,
  stepDesktopPetSize,
  type DesktopPetPosition,
  type DesktopPetPreferences,
  type DesktopPetViewport,
} from "./desktopPetState";
import "./DesktopPet.css";

type DragState = {
  pointerId: number;
  pointerX: number;
  pointerY: number;
  position: DesktopPetPosition;
};

export function DesktopPet({
  label,
  mood,
  onPreferencesChange,
  preferences,
}: {
  label: string;
  mood: TinybotMascotMood;
  onPreferencesChange: (preferences: DesktopPetPreferences) => void;
  preferences: DesktopPetPreferences;
}) {
  const { t } = useTranslation("common");
  const initialPosition = preferences.position
    ? clampDesktopPetPosition(preferences.position, preferences.size, currentViewport())
    : defaultDesktopPetPosition(preferences.size, currentViewport());
  const [position, setPosition] = useState(initialPosition);
  const [dragging, setDragging] = useState(false);
  const positionRef = useRef(position);
  const dragRef = useRef<DragState | null>(null);
  const sizePixels = DESKTOP_PET_SIZE_PIXELS[preferences.size];
  const footprint = desktopPetFootprint(preferences.size);

  useEffect(() => {
    positionRef.current = position;
  }, [position]);

  useEffect(() => {
    function handleResize() {
      const nextPosition = clampDesktopPetPosition(positionRef.current, preferences.size, currentViewport());
      setCurrentPosition(nextPosition);
      onPreferencesChange({ ...preferences, position: nextPosition });
    }

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [onPreferencesChange, preferences]);

  function setCurrentPosition(nextPosition: DesktopPetPosition) {
    positionRef.current = nextPosition;
    setPosition(nextPosition);
  }

  function moveTo(nextPosition: DesktopPetPosition, persist: boolean) {
    const clamped = clampDesktopPetPosition(nextPosition, preferences.size, currentViewport());
    setCurrentPosition(clamped);
    if (persist) onPreferencesChange({ ...preferences, position: clamped });
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      pointerX: event.clientX,
      pointerY: event.clientY,
      position: positionRef.current,
    };
    setDragging(true);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    moveTo({
      x: drag.position.x + event.clientX - drag.pointerX,
      y: drag.position.y + event.clientY - drag.pointerY,
    }, false);
  }

  function finishDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragRef.current = null;
    setDragging(false);
    onPreferencesChange({ ...preferences, position: positionRef.current });
  }

  function handleMoveKey(event: ReactKeyboardEvent<HTMLDivElement>) {
    const direction = keyboardDirection(event.key);
    if (!direction) return;
    event.preventDefault();
    const step = event.shiftKey ? 24 : 10;
    moveTo({
      x: positionRef.current.x + direction.x * step,
      y: positionRef.current.y + direction.y * step,
    }, true);
  }

  function handleSizeChange(direction: -1 | 1) {
    const size = stepDesktopPetSize(preferences.size, direction);
    if (size === preferences.size) return;
    const nextPosition = clampDesktopPetPosition(positionRef.current, size, currentViewport());
    setCurrentPosition(nextPosition);
    onPreferencesChange({ ...preferences, position: nextPosition, size });
  }

  function handleHide() {
    onPreferencesChange({ ...preferences, position: positionRef.current, visible: false });
  }

  return (
    <div
      className="react-desktop-pet"
      data-dragging={dragging ? "true" : undefined}
      style={{
        "--desktop-pet-size": `${sizePixels}px`,
        "--desktop-pet-stage-width": `${footprint.width}px`,
        transform: `translate3d(${position.x}px, ${position.y}px, 0)`,
      } as CSSProperties}
    >
      <div className="react-desktop-pet__stage">
        <div
          aria-label={t("desktopPet.move")}
          className="react-desktop-pet__drag-surface"
          role="group"
          tabIndex={0}
          title={t("desktopPet.move")}
          onKeyDown={handleMoveKey}
          onPointerCancel={finishDrag}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={finishDrag}
        >
          <TinybotMascot label={label} mood={mood} />
        </div>
        <div
          aria-label={t("desktopPet.sizeControls", { size: t(`desktopPet.sizes.${preferences.size}`) })}
          className="react-desktop-pet__toolbar"
          role="toolbar"
        >
          <button
            aria-label={t("desktopPet.smaller")}
            disabled={preferences.size === "small"}
            title={t("desktopPet.smaller")}
            type="button"
            onClick={() => handleSizeChange(-1)}
          >
            <Minus aria-hidden="true" size={13} />
          </button>
          <button
            aria-label={t("desktopPet.larger")}
            disabled={preferences.size === "large"}
            title={t("desktopPet.larger")}
            type="button"
            onClick={() => handleSizeChange(1)}
          >
            <Plus aria-hidden="true" size={13} />
          </button>
          <button
            aria-label={t("desktopPet.hide")}
            title={t("desktopPet.hide")}
            type="button"
            onClick={handleHide}
          >
            <X aria-hidden="true" size={13} />
          </button>
        </div>
      </div>
    </div>
  );
}

function currentViewport(): DesktopPetViewport {
  return { width: window.innerWidth, height: window.innerHeight };
}

function keyboardDirection(key: string): DesktopPetPosition | null {
  switch (key) {
    case "ArrowLeft": return { x: -1, y: 0 };
    case "ArrowRight": return { x: 1, y: 0 };
    case "ArrowUp": return { x: 0, y: -1 };
    case "ArrowDown": return { x: 0, y: 1 };
    default: return null;
  }
}
