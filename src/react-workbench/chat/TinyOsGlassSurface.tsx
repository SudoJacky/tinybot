import { gsap } from "gsap";
import { useLayoutEffect, useMemo, useRef } from "react";

interface GlassTargetDetail {
  visible: boolean;
  x: number;
}

type GlassTargetEvent = CustomEvent<GlassTargetDetail>;

const SURFACE_SIZE = 64;

export default function TinyOsGlassSurface() {
  const hostRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLSpanElement>(null);
  const reducedMotion = useMemo(() => globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false, []);

  useLayoutEffect(() => {
    const host = hostRef.current;
    const surface = surfaceRef.current;
    const eventHost = host?.parentElement;
    const launcher = eventHost?.closest<HTMLElement>(".tinyos-launcher");
    if (!host || !surface || !eventHost || !launcher) return;

    const positionSurface = (detail: GlassTargetDetail, immediate = false) => {
      const x = detail.x * eventHost.getBoundingClientRect().width - SURFACE_SIZE / 2;
      gsap.to(surface, {
        duration: immediate || reducedMotion ? .001 : .22,
        ease: "power3.out",
        opacity: detail.visible ? 1 : 0,
        overwrite: "auto",
        x,
        yPercent: -50,
      });
    };
    const syncFromDom = () => {
      const current = launcher.querySelector<HTMLElement>(".tinyos-launcher__app[data-lens-target=\"true\"]");
      const eventBounds = eventHost.getBoundingClientRect();
      const currentBounds = current?.getBoundingClientRect();
      if (!currentBounds || eventBounds.width < 1) return;
      positionSurface({
        visible: launcher.hasAttribute("data-lens-visible"),
        x: (currentBounds.left + currentBounds.width / 2 - eventBounds.left) / eventBounds.width,
      }, true);
    };
    const handleTarget = (event: Event) => positionSurface((event as GlassTargetEvent).detail);
    const resizeObserver = new ResizeObserver(syncFromDom);

    eventHost.addEventListener("tinyos:glass-target", handleTarget);
    resizeObserver.observe(eventHost);
    syncFromDom();
    return () => {
      eventHost.removeEventListener("tinyos:glass-target", handleTarget);
      resizeObserver.disconnect();
      gsap.killTweensOf(surface);
    };
  }, [reducedMotion]);

  return (
    <div className="tinyos-launcher__glass-surface-host" ref={hostRef}>
      <span aria-hidden="true" className="tinyos-launcher__glass-surface" ref={surfaceRef} />
    </div>
  );
}
