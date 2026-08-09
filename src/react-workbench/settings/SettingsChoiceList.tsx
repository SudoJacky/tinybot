import { Check, ChevronDown } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

export type SettingsChoiceOption = {
  description?: string;
  disabled?: boolean;
  label: string;
  value: string;
};

export function SettingsChoiceList({
  description,
  error,
  label,
  onChange,
  options,
  optionsAriaLabel,
  value,
}: {
  description?: string;
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
  const errorId = error ? `${id}-error` : undefined;
  const [open, setOpen] = useState(false);
  const selectedOption = options.find((option) => option.value === value) ?? options[0];

  useEffect(() => {
    if (!open) {
      return;
    }
    function onPointerDown(event: PointerEvent) {
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) {
        return;
      }
      setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div
      aria-describedby={errorId}
      className="react-settings-choice"
      ref={rootRef}
    >
      <span className="react-settings-choice__label">
        <strong>{label}</strong>
        {description ? <small>{description}</small> : null}
      </span>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`${label}: ${selectedOption?.label ?? t("choice.notConfigured")}`}
        className="react-settings-choice-trigger"
        data-press-feedback="true"
        type="button"
        onClick={() => setOpen((current) => !current)}
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
          className="react-top-menu__popover react-settings-choice-popover"
          role="menu"
        >
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <button
              aria-checked={selected}
              className="react-top-menu__menu-item react-settings-choice-item"
              data-press-feedback="true"
              disabled={option.disabled}
              key={option.value}
              role="menuitemradio"
              type="button"
              onClick={() => {
                if (!option.disabled) {
                  onChange(option.value);
                  setOpen(false);
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
