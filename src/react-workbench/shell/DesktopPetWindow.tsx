import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { MessageCircle, Minus, Plus, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  createDesktopNativePetWindowClient,
  type DesktopPetWindowClient,
  type DesktopPetWindowSnapshot,
} from "../../app-core/native/desktopNativePet";
import {
  createDesktopNativePetQuickChatDropClient,
  type DesktopPetQuickChatDropClient,
} from "../../app-core/native/desktopNativePetQuickChat";
import {
  DESKTOP_PET_SIZE_PIXELS,
  stepDesktopPetSize,
  type DesktopPetPosition,
} from "../../app-core/desktop-pet/desktopPetState";
import { TinybotMascot } from "../chat/TinybotMascot";
import "./DesktopPetWindow.css";

export function DesktopPetWindow({
  client,
  quickChatClient,
}: {
  client?: DesktopPetWindowClient;
  quickChatClient?: DesktopPetQuickChatDropClient;
}) {
  const { t } = useTranslation("common");
  const windowClient = useMemo(() => client ?? createDesktopNativePetWindowClient(), [client]);
  const dropClient = useMemo(
    () => quickChatClient ?? createDesktopNativePetQuickChatDropClient(),
    [quickChatClient],
  );
  const [snapshot, setSnapshot] = useState<DesktopPetWindowSnapshot | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const [dropError, setDropError] = useState("");
  const dragDepth = useRef(0);

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

  function handleDragEnter(event: DragEvent<HTMLDivElement>) {
    if (!hasSupportedDrop(event.dataTransfer.types)) return;
    event.preventDefault();
    dragDepth.current += 1;
    setDropError("");
    setDropActive(true);
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    if (!hasSupportedDrop(event.dataTransfer.types)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  function handleDragLeave(event: DragEvent<HTMLDivElement>) {
    if (!hasSupportedDrop(event.dataTransfer.types)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDropActive(false);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    if (!hasSupportedDrop(event.dataTransfer.types)) return;
    event.preventDefault();
    dragDepth.current = 0;
    setDropActive(false);
    const files = Array.from(event.dataTransfer.files ?? []);
    if (files.length) {
      void dropClient.openWithFiles(files).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        setDropError(message);
        reportDesktopPetWindowError(error);
      });
      return;
    }
    const draft = event.dataTransfer.getData("text/plain") || event.dataTransfer.getData("text");
    if (!draft.trim()) {
      setDropError(t("desktopPet.quickChat.emptyDrop"));
      return;
    }
    void dropClient.openWithDraft(draft).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      setDropError(message);
      reportDesktopPetWindowError(error);
    });
  }

  return (
    <div
      className="react-desktop-pet-window"
      data-drop-active={dropActive ? "true" : "false"}
      style={{ "--desktop-pet-size": `${sizePixels}px` } as CSSProperties}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
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
      {dropActive ? (
        <div aria-live="polite" className="react-desktop-pet-window__drop-cue" role="status">
          <MessageCircle aria-hidden="true" size={16} />
          <span>{t("desktopPet.quickChat.release")}</span>
        </div>
      ) : null}
      {dropError ? <span className="react-desktop-pet-window__drop-error" role="alert">{dropError}</span> : null}
      <button
        aria-label={t("desktopPet.quickChat.open")}
        className="react-desktop-pet-window__quick-chat-button"
        title={t("desktopPet.quickChat.open")}
        type="button"
        onClick={() => void dropClient.openWithDraft("").catch(reportDesktopPetWindowError)}
      >
        <MessageCircle aria-hidden="true" size={14} />
      </button>
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

function hasSupportedDrop(types: readonly string[] | DOMStringList): boolean {
  return Array.from(types).some((type) => type === "Files" || type === "text/plain" || type === "text");
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
