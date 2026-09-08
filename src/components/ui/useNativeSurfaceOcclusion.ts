import { useLayoutEffect, useState, type RefObject } from "react";

// Shared overlay semantics, including portals. Custom retained overlays use
// data-native-overlay="modal" (whole window) or "local" (intersection only).
const OVERLAYS = '.react-popover-surface, [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], dialog[open], [data-native-overlay]';
type Occlusion = "modal" | "overlap" | null;

/** Coordinate native surfaces with rendered overlays, independently of routes. */
export function useNativeSurfaceOcclusion(
  hostRef: RefObject<HTMLElement | null>,
  enabled: boolean,
): Occlusion {
  const [occlusion, setOcclusion] = useState<Occlusion>(null);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!enabled || !host) {
      setOcclusion(null);
      return;
    }
    const document = host.ownerDocument;
    const window = document.defaultView!;
    let overlays: HTMLElement[] = [];
    let frame = 0;
    let disposed = false;

    const measure = () => {
      if (disposed) return;
      const surface = host.getBoundingClientRect();
      let next: Occlusion = null;
      for (const overlay of overlays) {
        if (!isPresented(overlay, window)) continue;
        if (overlay.getAttribute("aria-modal") === "true"
          || overlay.matches("dialog[open], [data-native-overlay='modal']")) {
          next = "modal";
          break;
        }
        const rect = overlay.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 && surface.width > 0 && surface.height > 0
          && rect.left < surface.right && rect.right > surface.left
          && rect.top < surface.bottom && rect.bottom > surface.top) next = "overlap";
      }
      setOcclusion((current) => current === next ? current : next);
    };

    const schedule = () => {
      if (frame || disposed) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        measure();
        // Follow finite overlay motion; never poll an idle page or a spinner.
        if (overlays.some((overlay) => (overlay.getAnimations?.() ?? []).some((animation) => (
          animation.playState === "running"
          && animation.effect?.getComputedTiming().iterations !== Infinity
        )))) schedule();
      });
    };
    const resize = new ResizeObserver(schedule);
    const refresh = () => {
      overlays = Array.from(document.querySelectorAll<HTMLElement>(OVERLAYS))
        .filter((overlay) => !overlay.contains(host) && !host.contains(overlay));
      resize.disconnect();
      resize.observe(host);
      overlays.forEach((overlay) => resize.observe(overlay));
      // A modal must suppress the native surface as soon as it enters the DOM.
      measure();
      schedule();
    };
    const mutations = new MutationObserver((records) => {
      const relevant = records.some((record) => {
        const target = record.target instanceof Element ? record.target : record.target.parentElement;
        if (target && (target.matches(OVERLAYS)
          || overlays.some((overlay) => target.contains(overlay) || overlay.contains(target)))) return true;
        return [...record.addedNodes, ...record.removedNodes].some((node) => (
          node instanceof Element && (node.matches(OVERLAYS) || node.querySelector(OVERLAYS))
        ));
      });
      if (relevant) refresh();
    });
    mutations.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["class", "style", "hidden", "open", "role", "aria-modal", "aria-hidden", "data-state", "data-native-overlay"],
    });
    const onMotion = (event: Event) => {
      if (event.target instanceof Element && overlays.some((overlay) => (
        overlay === event.target || (event.target as Element).contains(overlay)
      ))) schedule();
    };
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    document.addEventListener("transitionrun", onMotion, true);
    document.addEventListener("animationstart", onMotion, true);
    refresh();
    return () => {
      disposed = true;
      window.cancelAnimationFrame(frame);
      resize.disconnect();
      mutations.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      document.removeEventListener("transitionrun", onMotion, true);
      document.removeEventListener("animationstart", onMotion, true);
    };
  }, [enabled, hostRef]);

  return enabled ? occlusion : null;
}

function isPresented(overlay: HTMLElement, window: Window): boolean {
  if (!overlay.isConnected) return false;
  const retained = overlay.dataset.state === "closing" || overlay.hasAttribute("data-native-overlay");
  for (let node: HTMLElement | null = overlay; node; node = node.parentElement) {
    if (node.hidden || (!retained && node.getAttribute("aria-hidden") === "true")) return false;
    const style = window.getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
  }
  return true;
}
