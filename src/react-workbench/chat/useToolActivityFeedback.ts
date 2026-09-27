import { useEffect, useRef } from "react";
import type { ChatStepStatus } from "../../app-core/chat/chatTurnContracts";

/** Feedback belongs to a live transition, never to mounting a recorded result. */
export function useToolActivityFeedback(status: ChatStepStatus) {
  const root = useRef<HTMLElement>(null);
  const previousStatus = useRef(status);
  useEffect(() => {
    const previous = previousStatus.current;
    previousStatus.current = status;
    if (previous !== "running" || (status !== "completed" && status !== "failed")) return;
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const header = root.current?.querySelector<HTMLElement>(".react-timeline-activity__header");
    if (!header?.animate || preference.matches) return;

    const animations: Animation[] = [];
    const glyph = header.querySelector<HTMLElement>(".react-tool-call-chip__glyph");
    if (glyph) animations.push(glyph.animate([
      { transform: "translateY(70%)", opacity: 0 },
      { transform: "translateY(0)", opacity: 1 },
    ], { duration: 180, easing: "cubic-bezier(0.2, 0, 0, 1)" }));

    if (status === "completed") {
      animations.push(header.animate([
        { backgroundColor: "color-mix(in srgb, var(--color-success) 14%, var(--color-panel))" },
        { backgroundColor: getComputedStyle(header).backgroundColor },
      ], { duration: 420, easing: "ease-out" }));
    } else {
      animations.push(header.animate([
        { transform: "translateX(0)" }, { transform: "translateX(-2px)" },
        { transform: "translateX(2px)" }, { transform: "translateX(-1px)" },
        { transform: "translateX(0)" },
      ], { duration: 240, easing: "ease-out" }));
    }
    for (const animation of animations) {
      // Interrupting decorative feedback rejects the Web Animations completion promise.
      void animation.finished.catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) throw error;
      });
    }
    const cancel = () => animations.forEach((animation) => animation.cancel());
    const onPreferenceChange = () => { if (preference.matches) cancel(); };
    preference.addEventListener("change", onPreferenceChange);
    return () => {
      cancel();
      preference.removeEventListener("change", onPreferenceChange);
    };
  }, [status]);
  return root;
}
