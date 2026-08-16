import {
  useCallback,
  useLayoutEffect,
  useRef,
  type PointerEventHandler,
  type RefObject,
} from "react";

const FOCUSABLE_SELECTOR = [
  "button:not(:disabled)",
  "input:not(:disabled)",
  "select:not(:disabled)",
  "textarea:not(:disabled)",
  "[href]",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

const activeDialogs: symbol[] = [];
let bodyScrollLockCount = 0;
let bodyOverflowBeforeLock = "";

type ModalDialogOptions = {
  active?: boolean;
  closeEnabled?: boolean;
  onClose: () => void;
};

type ModalDialogController<TDialog extends HTMLElement> = {
  dialogRef: RefObject<TDialog | null>;
  onBackdropPointerDown: PointerEventHandler<HTMLDivElement>;
};

export function useModalDialog<TDialog extends HTMLElement = HTMLElement>({
  active = true,
  closeEnabled = true,
  onClose,
}: ModalDialogOptions): ModalDialogController<TDialog> {
  const dialogRef = useRef<TDialog>(null);
  const dialogIdRef = useRef(Symbol("modal-dialog"));
  const closeEnabledRef = useRef(closeEnabled);
  const onCloseRef = useRef(onClose);
  closeEnabledRef.current = closeEnabled;
  onCloseRef.current = onClose;

  const requestClose = useCallback(() => {
    if (closeEnabledRef.current) {
      onCloseRef.current();
    }
  }, []);

  useLayoutEffect(() => {
    if (!active) {
      return;
    }

    const dialogId = dialogIdRef.current;
    const restoreFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    activeDialogs.push(dialogId);
    const unlockBodyScroll = lockBodyScroll();
    const frame = window.requestAnimationFrame(() => {
      const dialog = dialogRef.current;
      const initialFocus = dialog?.querySelector<HTMLElement>("[data-dialog-initial-focus]")
        ?? focusableElements(dialog)[0];
      initialFocus?.focus({ preventScroll: true });
    });

    function onKeyDown(event: KeyboardEvent) {
      if (activeDialogs[activeDialogs.length - 1] !== dialogId) {
        return;
      }
      if (event.key === "Escape") {
        if (closeEnabledRef.current) {
          event.preventDefault();
          requestClose();
        }
        return;
      }
      if (event.key !== "Tab") {
        return;
      }

      const focusable = focusableElements(dialogRef.current);
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
      } else if (!dialogRef.current?.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => {
      const wasTopmost = activeDialogs[activeDialogs.length - 1] === dialogId;
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKeyDown);
      removeActiveDialog(dialogId);
      unlockBodyScroll();
      if (wasTopmost && restoreFocus?.isConnected) {
        restoreFocus.focus({ preventScroll: true });
      }
    };
  }, [active, requestClose]);

  const onBackdropPointerDown = useCallback<PointerEventHandler<HTMLDivElement>>((event) => {
    if (event.target === event.currentTarget) {
      requestClose();
    }
  }, [requestClose]);

  return { dialogRef, onBackdropPointerDown };
}

function focusableElements(root: HTMLElement | null): HTMLElement[] {
  if (!root) {
    return [];
  }
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter((element) => element.tabIndex >= 0 && element.getAttribute("aria-hidden") !== "true");
}

function lockBodyScroll(): () => void {
  if (bodyScrollLockCount === 0) {
    bodyOverflowBeforeLock = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  bodyScrollLockCount += 1;
  return () => {
    bodyScrollLockCount = Math.max(0, bodyScrollLockCount - 1);
    if (bodyScrollLockCount === 0) {
      document.body.style.overflow = bodyOverflowBeforeLock;
    }
  };
}

function removeActiveDialog(dialogId: symbol) {
  const index = activeDialogs.lastIndexOf(dialogId);
  if (index >= 0) {
    activeDialogs.splice(index, 1);
  }
}
