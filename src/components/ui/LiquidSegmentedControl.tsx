import { motion, useTransform } from "framer-motion";
import { useId, type CSSProperties, type ReactNode } from "react";
import { useLiquidMotion, type LiquidMotionOptions } from "./useLiquidMotion";
import "./LiquidSegmentedControl.css";

export type LiquidSegmentOption = {
  value: string;
  label: ReactNode;
  disabled?: boolean;
};

export type LiquidSegmentedControlProps = LiquidMotionOptions & {
  "aria-label": string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
  disabled?: boolean;
  options: readonly LiquidSegmentOption[];
  value: string;
  onChange: (value: string) => void;
};

/** A controlled single choice for short, stable option sets. */
export function LiquidSegmentedControl({
  options, value, onChange, disabled, speed, stretch, ...aria
}: LiquidSegmentedControlProps) {
  const name = useId();
  const selected = options.findIndex((option) => option.value === value);
  const { position, scaleX, scaleY, instant } = useLiquidMotion(Math.max(0, selected), { speed, stretch });
  // Percentages follow the actual segment width when labels, fonts or the viewport change.
  const x = useTransform(position, (step) => `${step * 100}%`);

  return (
    <div
      {...aria}
      className="liquid-segmented"
      data-disabled={disabled || undefined}
      role="radiogroup"
      style={{ "--segment-count": options.length, "--selected-offset": `${selected * 100}%` } as CSSProperties}
    >
      {selected >= 0 ? (
        <motion.span aria-hidden="true" className="liquid-segmented__pill" style={{ x, scaleX, scaleY }} />
      ) : null}
      {options.map((option) => (
        <label className="liquid-segmented__option" key={option.value} data-selected={option.value === value}>
          <input
            checked={option.value === value}
            disabled={disabled || option.disabled}
            name={name}
            type="radio"
            value={option.value}
            onPointerDown={() => { instant.current = false; }}
            onKeyDown={() => { instant.current = true; }}
            onClick={(event) => { instant.current = event.detail === 0; }}
            onChange={() => onChange(option.value)}
          />
          <span>{option.label}</span>
        </label>
      ))}
    </div>
  );
}
