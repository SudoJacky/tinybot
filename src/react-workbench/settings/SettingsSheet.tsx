import { X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type TransitionEvent as ReactTransitionEvent,
} from "react";
import { useModalDialog } from "../../components/ui/useModalDialog";

const CLOSE_FALLBACK_MS = 340;
const REDUCED_MOTION_CLOSE_FALLBACK_MS = 180;
type SettingsSheetProps = {
  ariaLabel: string;
  children: (requestClose: () => void) => ReactNode;
  closeLabel: string;
  compact?: boolean;
  description?: string;
  onClose: () => void;
  title: string;
  wide?: boolean;
};

export function SettingsSheet({
  ariaLabel,
  children,
  closeLabel,
  compact = false,
  description,
  onClose,
  title,
  wide = false,
}: SettingsSheetProps) {
  const closeTimerRef = useRef<number | null>(null);
  const closingRef = useRef(false);
  const finishedRef = useRef(false);
  const onCloseRef = useRef(onClose);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const finishClose = useCallback(() => {
    if (finishedRef.current) {
      return;
    }
    finishedRef.current = true;
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    onCloseRef.current();
  }, []);

  const requestClose = useCallback(() => {
    if (closingRef.current) {
      return;
    }
    closingRef.current = true;
    setClosing(true);
    const closeFallback = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
      ? REDUCED_MOTION_CLOSE_FALLBACK_MS
      : CLOSE_FALLBACK_MS;
    closeTimerRef.current = window.setTimeout(finishClose, closeFallback);
  }, [finishClose]);

  const { dialogRef: panelRef, onBackdropPointerDown } = useModalDialog<HTMLElement>({
    closeEnabled: !closing,
    onClose: requestClose,
  });

  useEffect(() => {
    return () => {
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current);
      }
    };
  }, []);

  function onPanelTransitionEnd(event: ReactTransitionEvent<HTMLElement>) {
    if (closing && event.target === panelRef.current && event.propertyName === "transform") {
      finishClose();
    }
  }

  return (
    <div
      className="react-settings-dialog-backdrop"
      data-state={closing ? "closing" : "open"}
      onPointerDown={onBackdropPointerDown}
    >
      <section
        aria-label={ariaLabel}
        aria-modal="true"
        className={wide
          ? "react-settings-dialog react-settings-dialog--wide"
          : compact
            ? "react-settings-dialog react-settings-dialog--compact"
            : "react-settings-dialog"}
        data-state={closing ? "closing" : "open"}
        onTransitionEnd={onPanelTransitionEnd}
        ref={panelRef}
        role="dialog"
      >
        <header>
          <div>
            <h2>{title}</h2>
            {description ? <p>{description}</p> : null}
          </div>
          <button data-press-feedback="true" type="button" aria-label={closeLabel} onClick={requestClose}>
            <X aria-hidden="true" size={17} />
          </button>
        </header>
        {children(requestClose)}
      </section>
    </div>
  );
}
