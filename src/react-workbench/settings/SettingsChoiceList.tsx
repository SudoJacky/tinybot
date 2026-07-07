import { Check, ChevronDown } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

export type SettingsChoiceOption = {
  description?: string;
  disabled?: boolean;
  label: string;
  value: string;
};

export function SettingsChoiceList({
  error,
  label,
  onChange,
  options,
  value,
}: {
  error?: string;
  label: string;
  onChange: (value: string) => void;
  options: SettingsChoiceOption[];
  value: string;
}) {
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
      <span className="react-settings-choice__label">{label}</span>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`${label}: ${selectedOption?.label ?? "Not configured"}`}
        className="react-settings-choice-trigger"
        type="button"
        onClick={() => setOpen((current) => !current)}
      >
        <span>
          <strong>{selectedOption?.label ?? "Not configured"}</strong>
          {selectedOption?.description ? <small>{selectedOption.description}</small> : null}
        </span>
        <ChevronDown aria-hidden="true" size={16} />
      </button>
      {open ? (
        <div
          aria-label={`${label} options`}
          className="react-top-menu__popover react-settings-choice-popover"
          role="menu"
        >
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <button
              aria-checked={selected}
              className="react-top-menu__menu-item react-settings-choice-item"
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
