import { useId } from "react";
import { LiquidSegmentedControl } from "../../components/ui/LiquidSegmentedControl";
import type { SettingsChoiceOption } from "./SettingsChoiceList";
import "./SettingsChoiceList.css";
import "./SettingsSegmentedChoice.css";

export function SettingsSegmentedChoice({
  ariaLabel, description, disabled, error, label, onChange, options, value,
}: {
  ariaLabel?: string;
  description?: string;
  disabled?: boolean;
  error?: string;
  label: string;
  onChange: (value: string) => void;
  options: SettingsChoiceOption[];
  value: string;
}) {
  const id = useId();
  const selectedDescription = options.find((option) => option.value === value)?.description;
  const describedBy = [description && `${id}-description`, selectedDescription && `${id}-selection`, error && `${id}-error`]
    .filter(Boolean).join(" ") || undefined;
  return (
    <div className="react-settings-choice react-settings-choice--segmented">
      <span className="react-settings-choice__label">
        <strong>{label}</strong>
        {description ? <small id={`${id}-description`}>{description}</small> : null}
      </span>
      <div className="react-settings-choice__control">
        <LiquidSegmentedControl
          aria-label={ariaLabel ?? label}
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          disabled={disabled}
          options={options}
          value={value}
          onChange={onChange}
        />
        {selectedDescription ? <small id={`${id}-selection`}>{selectedDescription}</small> : null}
      </div>
      {error ? <small id={`${id}-error`} role="alert">{error}</small> : null}
    </div>
  );
}
