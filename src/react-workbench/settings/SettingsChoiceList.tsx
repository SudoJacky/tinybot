import { Check, ChevronDown } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import "./SettingsChoiceList.css";

export type SettingsChoiceOption = {
  description?: string;
  disabled?: boolean;
  label: string;
  value: string;
};

export function SettingsChoiceList({
  ariaLabel,
  badge,
  description,
  disabled,
  error,
  label,
  menuPosition = "absolute",
  onChange,
  options,
  optionsAriaLabel,
  showMenuDescriptions = true,
  value,
}: {
  ariaLabel?: string;
  badge?: string;
  description?: string;
  disabled?: boolean;
  error?: string;
  label: string;
  menuPosition?: "absolute" | "fixed";
  onChange: (value: string) => void;
  options: SettingsChoiceOption[];
  optionsAriaLabel?: string;
  showMenuDescriptions?: boolean;
  value: string;
}) {
  const { t } = useTranslation("settings");
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>();
  const [placement, setPlacement] = useState<"top" | "bottom">("bottom");
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const errorId = error ? `${id}-error` : undefined;
  const menuId = `${id}-menu`;
  const [open, setOpen] = useState(false);
  const [inputSource, setInputSource] = useState<"pointer" | "keyboard">("pointer");
  const selectedOption = options.find((option) => option.value === value) ?? options[0];
  const selectedIndex = options.findIndex((option) => option.value === selectedOption?.value);
  const defaultFocusIndex = selectedIndex >= 0 && !options[selectedIndex]?.disabled
    ? selectedIndex
    : options.findIndex((option) => !option.disabled);

  useLayoutEffect(() => {
    if (!open || menuPosition !== "fixed") return;
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (!trigger || !menu) return;
    const rect = trigger.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom - 16;
    const above = rect.top - 16;
    const upward = below < Math.min(menu.scrollHeight, 260) && above > below;
    setPlacement(upward ? "top" : "bottom");
    const height = Math.max(0, Math.min(260, upward ? above : below));
    const width = Math.min(Math.max(rect.width, 240), window.innerWidth - 24);
    setMenuStyle({ position: "fixed", width, maxHeight: height, zIndex: 1100,
      left: Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12)),
      right: "auto", top: upward ? "auto" : rect.bottom + 8,
      bottom: upward ? window.innerHeight - rect.top + 8 : "auto" });
    function dismissOnScroll(event: Event) {
      if (event.target instanceof Node && menu?.contains(event.target)) return;
      setOpen(false);
    }
    const dismiss = () => setOpen(false);
    window.addEventListener("scroll", dismissOnScroll, true);
    window.addEventListener("resize", dismiss);
    return () => {
      window.removeEventListener("scroll", dismissOnScroll, true);
      window.removeEventListener("resize", dismiss);
    };
  }, [open, menuPosition]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const focusFrame = window.requestAnimationFrame(() => {
      if (defaultFocusIndex >= 0) {
        optionRefs.current[defaultFocusIndex]?.focus();
      }
    });
    function onPointerDown(event: PointerEvent) {
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) {
        return;
      }
      setOpen(false);
    }
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [defaultFocusIndex, open]);

  function closeAndRestoreFocus() {
    setOpen(false);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  }

  function onMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeAndRestoreFocus();
      return;
    }
    const enabledIndexes = options
      .map((option, index) => option.disabled ? -1 : index)
      .filter((index) => index >= 0);
    if (!enabledIndexes.length || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      return;
    }
    event.preventDefault();
    const currentPosition = enabledIndexes.findIndex((index) => optionRefs.current[index] === document.activeElement);
    let nextPosition = currentPosition;
    if (event.key === "Home") {
      nextPosition = 0;
    } else if (event.key === "End") {
      nextPosition = enabledIndexes.length - 1;
    } else if (event.key === "ArrowDown") {
      nextPosition = (currentPosition + 1 + enabledIndexes.length) % enabledIndexes.length;
    } else if (event.key === "ArrowUp") {
      nextPosition = (currentPosition - 1 + enabledIndexes.length) % enabledIndexes.length;
    }
    optionRefs.current[enabledIndexes[nextPosition]]?.focus();
  }

  return (
    <div
      className="react-settings-choice"
      ref={rootRef}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setOpen(false);
        }
      }}
    >
      <span className="react-settings-choice__label">
        <strong>
          {label}
          {badge ? <em>{badge}</em> : null}
        </strong>
        {description ? <small>{description}</small> : null}
      </span>
      <button
        aria-describedby={errorId}
        aria-controls={menuId}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`${ariaLabel ?? label}: ${selectedOption?.label ?? t("choice.notConfigured")}`}
        className="react-settings-choice-trigger"
        data-press-feedback="true"
        disabled={disabled}
        ref={triggerRef}
        type="button"
        onClick={(event) => {
          setInputSource(event.detail === 0 ? "keyboard" : "pointer");
          setOpen((current) => !current);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setInputSource("keyboard");
            setOpen(true);
          }
        }}
      >
        <span>
          <strong>{selectedOption?.label ?? t("choice.notConfigured")}</strong>
          {selectedOption?.description ? <small>{selectedOption.description}</small> : null}
        </span>
        <ChevronDown aria-hidden="true" size={16} />
      </button>
      {open ? (
        <div
          aria-label={optionsAriaLabel ?? t("choice.options", { label })}
          className="react-popover-surface react-settings-choice-popover"
          data-input-source={inputSource}
          data-placement={placement}
          id={menuId}
          ref={menuRef}
          style={menuPosition === "fixed" ? menuStyle : undefined}
          role="menu"
          onKeyDown={onMenuKeyDown}
        >
        {options.map((option, index) => {
          const selected = option.value === value;
          return (
            <button
              aria-checked={selected}
              className="react-popover-item react-top-menu__menu-item react-settings-choice-item"
              data-press-feedback="true"
              disabled={option.disabled}
              key={option.value}
              ref={(node) => {
                optionRefs.current[index] = node;
              }}
              role="menuitemradio"
              type="button"
              onClick={() => {
                if (!option.disabled) {
                  onChange(option.value);
                  closeAndRestoreFocus();
                }
              }}
            >
              <span className="react-top-menu__menu-label">
                <strong>{option.label}</strong>
                {showMenuDescriptions && option.description ? <small>{option.description}</small> : null}
              </span>
              {selected ? <Check aria-hidden="true" size={15} /> : <span />}
            </button>
          );
        })}
        </div>
      ) : null}
      {error ? <small id={errorId} role="alert">{error}</small> : null}
    </div>
  );
}
