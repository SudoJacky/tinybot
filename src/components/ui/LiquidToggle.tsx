/*!
 * Liquid motion adapted from Bencho's Liquid Toggle (https://bencho.dev/blocks/liq-toggle).
 * MIT License — Copyright (c) 2026 Lorenzo Cabra
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
 * of the Software, and to permit persons to whom the Software is furnished to do
 * so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { motion, useTransform } from "framer-motion";
import { useState, type InputHTMLAttributes } from "react";
import { useLiquidMotion, type LiquidMotionOptions } from "./useLiquidMotion";
import "./LiquidToggle.css";

export type LiquidToggleProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "size"> & LiquidMotionOptions;

export function LiquidToggle({
  checked, defaultChecked = false, disabled, speed = 50, stretch = 36,
  className = "", onChange, onClick, onKeyDown, role, ...props
}: LiquidToggleProps) {
  const [localChecked, setLocalChecked] = useState(defaultChecked);
  const enabled = checked ?? localChecked;
  const { position, scaleX, scaleY, instant } = useLiquidMotion(enabled ? 1 : 0, { speed, stretch });
  const x = useTransform(position, (value) => value * 16);

  return (
    <span className="liquid-toggle" data-checked={enabled} data-disabled={disabled || undefined}>
      <input
        {...props}
        aria-checked={role === "switch" ? enabled : undefined}
        checked={enabled}
        className={`liquid-toggle__input ${className}`}
        disabled={disabled}
        role={role}
        type="checkbox"
        onClick={(event) => { instant.current = event.detail === 0; onClick?.(event); }}
        onKeyDown={(event) => {
          onKeyDown?.(event);
          if (!event.defaultPrevented && role === "switch" && event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.click();
          }
        }}
        onChange={(event) => {
          if (checked === undefined) setLocalChecked(event.currentTarget.checked);
          onChange?.(event);
        }}
      />
      <span className="liquid-toggle__track" aria-hidden="true">
        <motion.span className="liquid-toggle__thumb" style={{ x, scaleX, scaleY }} />
      </span>
    </span>
  );
}
