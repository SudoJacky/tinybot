// @vitest-environment happy-dom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import SplitFlapText from "./SplitFlapText";

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });
const phrase = (root: HTMLElement) => Array.from(root.querySelectorAll(".split-flap-text__half--top .split-flap-text__char"), el => el.textContent).join("").trim();

test("cycles through phrases, wraps, and releases animation timers on unmount", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame", "performance"] });
  const { container, unmount } = render(<SplitFlapText words={["SOUP", "IDEA"]} cycleDelay={400} flipDuration={0.04} stagger={0} flipsPerChar={0} padTo={0} />);
  expect(phrase(container)).toBe("SOUP");
  await act(async () => { await vi.advanceTimersByTimeAsync(500); });
  expect(phrase(container)).toBe("IDEA");
  await act(async () => { await vi.advanceTimersByTimeAsync(440); });
  expect(phrase(container)).toBe("SOUP");
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});

test("keeps a static phrase when reduced motion is requested", async () => {
  vi.useFakeTimers();
  const original = window.matchMedia.bind(window);
  vi.spyOn(window, "matchMedia").mockImplementation(query => {
    const media = original(query);
    Object.defineProperty(media, "matches", { value: true });
    return media;
  });
  const { container } = render(<SplitFlapText words={["脑洞施工中", "灵感搅拌中"]} cycleDelay={400} padTo={0} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(phrase(container)).toBe("脑洞施工中");
  expect(vi.getTimerCount()).toBe(0);
});
