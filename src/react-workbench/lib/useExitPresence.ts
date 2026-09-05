import { useLayoutEffect, useState } from "react";

/** Retain only closing content, within its owner scope, until CSS finishes. */
export function useExitPresence<T>(
  value: T | null,
  scope: string,
  readTransitions: () => Animation[],
): T | null {
  const [retained, setRetained] = useState({ scope, value });
  if (retained.scope !== scope || (value !== null && retained.value !== value)) {
    setRetained({ scope, value });
  }
  const present = value ?? (retained.scope === scope ? retained.value : null);

  useLayoutEffect(() => {
    if (value !== null || present === null) return;
    let disposed = false;
    const release = () => {
      if (!disposed) setRetained({ scope, value: null });
    };
    const transitions = readTransitions();
    if (!transitions.length) {
      release();
      return;
    }
    void (async () => {
      let pending = transitions;
      while (pending.length && !disposed) {
        await Promise.all(pending.map((animation) => animation.finished.catch((error: unknown) => {
          // Reversal, breakpoint changes and reduced motion can cancel CSS transitions.
          if (!(error instanceof DOMException && error.name === "AbortError")) throw error;
        })));
        if (disposed) return;
        // A breakpoint can replace the transition that was just cancelled.
        pending = readTransitions();
      }
      release();
    })();
    return () => { disposed = true; };
  }, [value, present, scope, readTransitions]);

  return present;
}

/** Exclude descendant animations (including infinite cursors and spinners). */
export function elementTransitions(element: HTMLElement | null, properties: readonly string[]): Animation[] {
  return (element?.getAnimations?.() ?? []).filter((animation) => (
    "transitionProperty" in animation
    && properties.includes(animation.transitionProperty as string)
    && animation.playState !== "finished"
    && animation.playState !== "idle"
  ));
}
