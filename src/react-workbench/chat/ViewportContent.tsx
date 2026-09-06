import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import "./ViewportContent.css";

const OVERSCAN = 800;

/** Keep interaction state in the parent; only expensive, reproducible content belongs here. */
export function ViewportContent({ children, placeholder, estimatedHeight = 240, pinned = false }: {
  children: ReactNode;
  placeholder?: string;
  estimatedHeight?: number;
  pinned?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const height = useRef(estimatedHeight);
  const scrollAnchor = useRef<{ root: Element; bottom: boolean; element: Element | null; top: number } | null>(null);
  const [nearby, setNearby] = useState(false);
  const [interacting, setInteracting] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const mounted = pinned || nearby || interacting || revealed;

  useLayoutEffect(() => {
    const element = ref.current!;
    const root = element.closest(".react-conversation-view");
    const updateNearby = (value: boolean) => {
      if (value) setRevealed(false);
      if (root) {
        const rect = root.getBoundingClientRect();
        const anchor = document.elementFromPoint(rect.left + 24, rect.top + 8)
          ?.closest(".react-viewport-content, .react-canonical-turn") ?? null;
        scrollAnchor.current = {
          root, bottom: root.scrollHeight - root.scrollTop - root.clientHeight < 4,
          element: anchor, top: anchor?.getBoundingClientRect().top ?? 0,
        };
      }
      setNearby(value);
    };
    const bounds = element.getBoundingClientRect();
    const viewport = root?.getBoundingClientRect();
    updateNearby(bounds.bottom >= (viewport?.top ?? 0) - OVERSCAN
      && bounds.top <= (viewport?.bottom ?? window.innerHeight) + OVERSCAN);
    const observer = new IntersectionObserver(([entry]) => updateNearby(entry.isIntersecting), {
      root, rootMargin: `${OVERSCAN}px 0px`,
    });
    observer.observe(element);
    const reveal = () => setRevealed(true);
    element.addEventListener("tinybot:viewport-reveal", reveal);
    const retainInteraction = () => {
      const selection = document.getSelection();
      setInteracting(element.contains(document.activeElement)
        || Boolean(selection && !selection.isCollapsed && (
          element.contains(selection.anchorNode) || element.contains(selection.focusNode)
        )));
    };
    document.addEventListener("selectionchange", retainInteraction);
    element.addEventListener("focusin", retainInteraction);
    const afterBlur = () => queueMicrotask(retainInteraction);
    element.addEventListener("focusout", afterBlur);
    return () => {
      observer.disconnect();
      element.removeEventListener("tinybot:viewport-reveal", reveal);
      document.removeEventListener("selectionchange", retainInteraction);
      element.removeEventListener("focusin", retainInteraction);
      element.removeEventListener("focusout", afterBlur);
    };
  }, []);

  useLayoutEffect(() => {
    const anchor = scrollAnchor.current;
    if (anchor?.bottom) {
      anchor.root.scrollTop = anchor.root.scrollHeight - anchor.root.clientHeight;
    } else if (anchor?.element?.isConnected) {
      anchor.root.scrollTop += anchor.element.getBoundingClientRect().top - anchor.top;
    }
    scrollAnchor.current = null;
    if (!mounted) return;
    const element = ref.current!;
    const measure = () => {
      const next = element.getBoundingClientRect().height;
      if (next > 0) {
        const root = element.closest(".react-conversation-view");
        const delta = next - height.current;
        if (root && delta !== 0 && root.scrollHeight - delta - root.scrollTop - root.clientHeight < 4) {
          root.scrollTop = root.scrollHeight - root.clientHeight;
        }
        height.current = next;
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [mounted]);

  return (
    <div className="react-viewport-content" data-mounted={mounted}
      tabIndex={mounted ? undefined : 0}
      ref={ref} style={mounted ? undefined : { height: height.current }}>
      {mounted ? children : <span className="react-viewport-content__placeholder">{placeholder}</span>}
    </div>
  );
}
