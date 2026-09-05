import { Check, ChevronDown } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
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
  onChange,
  options,
  optionsAriaLabel,
  value,
}: {
  ariaLabel?: string;
  badge?: string;
  description?: string;
  disabled?: boolean;
  error?: string;
  label: string;
  onChange: (value: string) => void;
  options: SettingsChoiceOption[];
  optionsAriaLabel?: string;
  value: string;
}) {
  const { t } = useTranslation("settings");
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
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
          id={menuId}
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
                {option.description ? <small>{option.description}</small> : null}
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
