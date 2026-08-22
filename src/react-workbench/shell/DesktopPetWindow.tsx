import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { Minus, Plus, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  createDesktopNativePetWindowClient,
  type DesktopPetWindowClient,
  type DesktopPetWindowSnapshot,
} from "../../app-core/native/desktopNativePet";
import {
  DESKTOP_PET_SIZE_PIXELS,
  stepDesktopPetSize,
  type DesktopPetPosition,
} from "../../app-core/desktop-pet/desktopPetState";
import { TinybotMascot } from "../chat/TinybotMascot";
import "./DesktopPetWindow.css";

export function DesktopPetWindow({ client }: { client?: DesktopPetWindowClient }) {
  const { t } = useTranslation("common");
  const windowClient = useMemo(() => client ?? createDesktopNativePetWindowClient(), [client]);
  const [snapshot, setSnapshot] = useState<DesktopPetWindowSnapshot | null>(null);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void windowClient.listen((nextSnapshot) => {
      if (!disposed) {
        setSnapshot(nextSnapshot);
      }
    }).then((stopListening) => {
      if (disposed) {
        stopListening();
      } else {
        unlisten = stopListening;
      }
    }).catch(reportDesktopPetWindowError);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [windowClient]);

  if (!snapshot) {
    return <div aria-busy="true" className="react-desktop-pet-window" />;
  }

  const currentSnapshot = snapshot;
  const sizePixels = DESKTOP_PET_SIZE_PIXELS[currentSnapshot.preferences.size];

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    void windowClient.startDragging().catch(reportDesktopPetWindowError);
  }

  function handleMoveKey(event: KeyboardEvent<HTMLDivElement>) {
    const direction = keyboardDirection(event.key);
    if (!direction) return;
    event.preventDefault();
    const step = event.shiftKey ? 24 : 10;
    void windowClient.moveBy({
      x: direction.x * step,
      y: direction.y * step,
    }).catch(reportDesktopPetWindowError);
  }

  function handleSizeChange(direction: -1 | 1) {
    const size = stepDesktopPetSize(currentSnapshot.preferences.size, direction);
    if (size === currentSnapshot.preferences.size) return;
    void windowClient.requestPreferences({ size }).catch(reportDesktopPetWindowError);
  }

  return (
    <div
      className="react-desktop-pet-window"
      style={{ "--desktop-pet-size": `${sizePixels}px` } as CSSProperties}
    >
      <div
        aria-label={t("desktopPet.move")}
        className="react-desktop-pet-window__drag-surface"
        role="group"
        tabIndex={0}
        title={t("desktopPet.move")}
        onKeyDown={handleMoveKey}
        onPointerDown={handlePointerDown}
      >
        <TinybotMascot label={snapshot.label} mood={snapshot.mood} />
      </div>
      <div
        aria-label={t("desktopPet.sizeControls", { size: t(`desktopPet.sizes.${snapshot.preferences.size}`) })}
        className="react-desktop-pet-window__toolbar"
        role="toolbar"
      >
        <button
          aria-label={t("desktopPet.smaller")}
          disabled={snapshot.preferences.size === "small"}
          title={t("desktopPet.smaller")}
          type="button"
          onClick={() => handleSizeChange(-1)}
        >
          <Minus aria-hidden="true" size={13} />
        </button>
        <button
          aria-label={t("desktopPet.larger")}
          disabled={snapshot.preferences.size === "large"}
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
          onClick={() => void windowClient.requestPreferences({ visible: false }).catch(reportDesktopPetWindowError)}
        >
          <X aria-hidden="true" size={13} />
        </button>
      </div>
    </div>
  );
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

function reportDesktopPetWindowError(error: unknown): void {
  console.error("[desktop-pet] Window interaction failed.", error);
}
