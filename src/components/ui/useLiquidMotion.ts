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
import { animate, useMotionValue, useSpring, useTransform, useVelocity } from "framer-motion";
import { useEffect, useRef } from "react";

export type LiquidMotionOptions = {
  /** Movement speed, from 0 to 100. */
  speed?: number;
  /** Velocity-driven stretch, from 0 to 100. */
  stretch?: number;
};

const clamp = (value: number) => Math.min(100, Math.max(0, value));

/** Positions are measured in steps, so switches and segments share the same motion. */
export function useLiquidMotion(target: number, { speed = 50, stretch = 36 }: LiquidMotionOptions) {
  const instant = useRef(false);
  const position = useMotionValue(target);
  const velocity = useSpring(useVelocity(position), { stiffness: 320, damping: 40, mass: 0.6 });
  const scaleX = useTransform(velocity, (value) => 1 + Math.min(0.4, Math.abs(value) / (600 / 46)) * clamp(stretch) / 100);
  const scaleY = useTransform(scaleX, (value) => 1 / value);

  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const settle = () => { position.jump(target); velocity.jump(0); };
    const animation = preference.matches || instant.current
      ? (settle(), undefined)
      : animate(position, target, { type: "spring", stiffness: 170 + (clamp(speed) - 50) * 1.1, damping: 21.5, mass: 0.9 });
    instant.current = false;
    const onPreferenceChange = () => { if (preference.matches) settle(); };
    preference.addEventListener("change", onPreferenceChange);
    return () => {
      animation?.stop();
      preference.removeEventListener("change", onPreferenceChange);
    };
  }, [target, speed, velocity, position]);

  return { position, scaleX, scaleY, instant };
}
