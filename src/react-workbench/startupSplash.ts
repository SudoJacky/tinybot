/** The HTML splash is independent of React so it covers bundle loading too. */
export function removeStartupSplash(): void {
  document.getElementById("tinybot-startup")?.remove();
}

export async function dismissStartupSplash(): Promise<void> {
  const splash = document.getElementById("tinybot-startup");
  if (!splash || splash.dataset.dismissing) return;
  splash.dataset.dismissing = "true";
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  if (reducedMotion.matches) {
    splash.remove();
    return;
  }

  // Finish the short logo entrance, without adding a minimum loading timeout.
  await Promise.all(splash.getAnimations({ subtree: true }).map(waitForAnimation));
  if (!splash.isConnected) return;
  if (reducedMotion.matches) {
    splash.remove();
    return;
  }

  const fade = splash.animate([{ opacity: 1 }, { opacity: 0 }], {
    duration: 180,
    easing: "ease-out",
    fill: "forwards",
  });
  const onMotionChange = () => { if (reducedMotion.matches) fade.finish(); };
  reducedMotion.addEventListener("change", onMotionChange);
  try {
    await waitForAnimation(fade);
  } finally {
    reducedMotion.removeEventListener("change", onMotionChange);
    splash.remove();
  }
}

async function waitForAnimation(animation: Animation): Promise<void> {
  try {
    await animation.finished;
  } catch (error) {
    // Removing the splash on failure or disabling motion cancels CSS animations.
    if (!(error instanceof DOMException && error.name === "AbortError")) throw error;
  }
}
