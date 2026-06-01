const DEFAULT_VIEWPORT_PADDING = 12;

export function isRectVisibleInViewport(rect, viewport, padding = DEFAULT_VIEWPORT_PADDING) {
  return (
    rect.bottom > padding &&
    rect.right > padding &&
    rect.top < viewport.height - padding &&
    rect.left < viewport.width - padding
  );
}

export function focusTourTarget(
  element,
  viewport = { width: window.innerWidth, height: window.innerHeight },
) {
  const rect = element.getBoundingClientRect();
  if (isRectVisibleInViewport(rect, viewport)) {
    return false;
  }
  element.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
  return true;
}
