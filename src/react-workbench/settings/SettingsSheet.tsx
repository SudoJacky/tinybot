import { X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type TransitionEvent as ReactTransitionEvent,
} from "react";

const CLOSE_FALLBACK_MS = 340;
const REDUCED_MOTION_CLOSE_FALLBACK_MS = 180;
const FOCUSABLE_SELECTOR = [
  "button:not(:disabled)",
  "input:not(:disabled)",
  "select:not(:disabled)",
  "textarea:not(:disabled)",
  "[href]",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

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
  const panelRef = useRef<HTMLElement>(null);
  const closeTimerRef = useRef<number | null>(null);
  const closingRef = useRef(false);
  const finishedRef = useRef(false);
  const onCloseRef = useRef(onClose);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
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

  useEffect(() => {
    restoreFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = window.requestAnimationFrame(() => {
      const panel = panelRef.current;
      const target = panel?.querySelector<HTMLElement>("[data-settings-sheet-focus]")
        ?? focusableElements(panel)[0];
      target?.focus({ preventScroll: true });
    });
    return () => {
      window.cancelAnimationFrame(frame);
      document.body.style.overflow = previousBodyOverflow;
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current);
      }
      const target = restoreFocusRef.current;
      if (target?.isConnected) {
        target.focus({ preventScroll: true });
      }
    };
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        requestClose();
        return;
      }
      if (event.key !== "Tab") {
        return;
      }
      const focusable = focusableElements(panelRef.current);
      if (!focusable.length) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (!panelRef.current?.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [requestClose]);

  function onBackdropPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget) {
      requestClose();
    }
  }

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

function focusableElements(root: HTMLElement | null): HTMLElement[] {
  if (!root) {
    return [];
  }
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter((element) => element.tabIndex >= 0 && element.getAttribute("aria-hidden") !== "true");
}
