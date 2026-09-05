// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dismissStartupSplash, removeStartupSplash } from "./startupSplash";

beforeEach(() => {
  document.body.innerHTML = '<div id="tinybot-startup"><img alt="" /></div><div id="root">Workbench</div>';
});

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("startup splash", () => {
  it("waits for the logo entrance, fades once, and preserves the mounted workbench", async () => {
    const splash = document.getElementById("tinybot-startup")!;
    const entrance = pendingAnimation();
    const fade = pendingAnimation();
    const animate = vi.fn(() => ({ finished: fade.finished }));
    Object.assign(splash, { getAnimations: () => [{ finished: entrance.finished }], animate });

    const dismissed = dismissStartupSplash();
    await dismissStartupSplash();
    expect(animate).not.toHaveBeenCalled();
    entrance.finish();
    await vi.waitFor(() => expect(animate).toHaveBeenCalledTimes(1));
    expect(splash.isConnected).toBe(true);
    fade.finish();
    await dismissed;
    expect(splash.isConnected).toBe(false);
    expect(document.getElementById("root")?.textContent).toBe("Workbench");
  });

  it("removes the surface immediately with reduced motion", async () => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    Object.defineProperty(media, "matches", { value: true });
    vi.spyOn(window, "matchMedia").mockReturnValue(media);
    await dismissStartupSplash();
    expect(document.getElementById("tinybot-startup")).toBeNull();
  });

  it("does not start a fade after an error removes the loading surface", async () => {
    const splash = document.getElementById("tinybot-startup")!;
    const entrance = pendingAnimation();
    const animate = vi.fn();
    Object.assign(splash, { getAnimations: () => [{ finished: entrance.finished }], animate });
    const dismissed = dismissStartupSplash();
    removeStartupSplash();
    entrance.cancel(new DOMException("Removed", "AbortError"));
    await dismissed;
    expect(animate).not.toHaveBeenCalled();
    expect(document.getElementById("tinybot-startup")).toBeNull();
  });

  it("finishes an active fade when reduced motion is enabled", async () => {
    const splash = document.getElementById("tinybot-startup")!;
    const fade = pendingAnimation();
    const finish = vi.fn(fade.finish);
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    vi.spyOn(window, "matchMedia").mockReturnValue(media);
    const animate = vi.fn(() => ({ finished: fade.finished, finish }));
    Object.assign(splash, { getAnimations: () => [], animate });
    const dismissed = dismissStartupSplash();
    await vi.waitFor(() => expect(animate).toHaveBeenCalledOnce());
    Object.defineProperty(media, "matches", { value: true });
    media.dispatchEvent(new Event("change"));
    await dismissed;
    expect(finish).toHaveBeenCalledOnce();
    expect(splash.isConnected).toBe(false);
  });
});

function pendingAnimation() {
  let finish!: () => void;
  let cancel!: (error: DOMException) => void;
  const finished = new Promise<void>((resolve, reject) => { finish = resolve; cancel = reject; });
  return { finished, finish, cancel };
}
