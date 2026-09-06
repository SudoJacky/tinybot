export type ConversationViewState = {
  scrollTop: number;
  stickToLatest: boolean;
  anchor?: { id: string; offset: number };
};

export function captureConversationView(element: HTMLElement): ConversationViewState {
  const bounds = element.getBoundingClientRect();
  const anchor = document.elementFromPoint(bounds.left + 24, bounds.top + 8)?.closest<HTMLElement>("[data-scroll-anchor]");
  return {
    scrollTop: element.scrollTop,
    stickToLatest: element.scrollHeight - element.scrollTop - element.clientHeight < 96,
    ...(anchor && element.contains(anchor) ? {
      anchor: { id: anchor.dataset.scrollAnchor!, offset: bounds.top - anchor.getBoundingClientRect().top },
    } : {}),
  };
}

/** Reveal the saved message before applying its offset: deferred predecessors have estimated heights. */
export function restoreConversationView(element: HTMLElement, view: ConversationViewState, restored: () => void) {
  const anchor = view.anchor && element.querySelector<HTMLElement>(`[data-scroll-anchor="${CSS.escape(view.anchor.id)}"]`);
  if (anchor && view.anchor) {
    for (const content of anchor.querySelectorAll(".react-viewport-content")) {
      content.dispatchEvent(new Event("tinybot:viewport-reveal"));
    }
    const offset = view.anchor.offset;
    const frame = requestAnimationFrame(() => {
      element.scrollTop += anchor.getBoundingClientRect().top - element.getBoundingClientRect().top + offset;
      restored();
    });
    return () => cancelAnimationFrame(frame);
  }
  element.scrollTo?.({ behavior: "instant", top: Math.min(view.scrollTop, Math.max(0, element.scrollHeight - element.clientHeight)) });
  restored();
}
