// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useConversationViewport } from "./useConversationViewport";

let frames: Map<number, FrameRequestCallback>;
let surface: HTMLDivElement;
let anchor: HTMLDivElement;
let end: HTMLDivElement;
let anchorTop: number;
let scrollTo: ReturnType<typeof vi.fn<(options?: number | ScrollToOptions, y?: number) => void>>;
let scrollEnd: ReturnType<typeof vi.fn<HTMLElement["scrollIntoView"]>>;
let scrollAnchor: ReturnType<typeof vi.fn<HTMLElement["scrollIntoView"]>>;

beforeEach(() => {
  frames = new Map();
  let nextFrame = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  surface = document.createElement("div");
  anchor = document.createElement("div");
  anchor.dataset.scrollAnchor = "turn:found";
  end = document.createElement("div");
  surface.append(anchor, end);
  document.body.append(surface);
  Object.defineProperties(surface, {
    clientHeight: { value: 400 }, scrollHeight: { value: 2000 },
    scrollTop: { value: 200, writable: true },
  });
  anchorTop = 20;
  vi.spyOn(surface, "getBoundingClientRect").mockImplementation(() => new DOMRect(0, 0, 800, 400));
  vi.spyOn(anchor, "getBoundingClientRect").mockImplementation(() => new DOMRect(0, anchorTop, 800, 100));
  vi.spyOn(document, "elementFromPoint").mockReturnValue(anchor);
  scrollTo = vi.fn((options?: number | ScrollToOptions, y?: number) => {
    surface.scrollTop = typeof options === "number" ? y ?? 0 : options?.top ?? 0;
  });
  scrollEnd = vi.fn();
  scrollAnchor = vi.fn();
  surface.scrollTo = scrollTo;
  end.scrollIntoView = scrollEnd;
  anchor.scrollIntoView = scrollAnchor;
});

afterEach(() => {
  cleanup();
  surface.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mount(initialProps: Parameters<typeof useConversationViewport>[0] = { sessionId: "a", timelineSessionId: "a" }) {
  const hook = renderHook(useConversationViewport, { initialProps });
  hook.result.current.conversationRef.current = surface;
  hook.result.current.endRef.current = end;
  return hook;
}

function flushFrames() {
  const pending = [...frames.values()];
  frames.clear();
  act(() => pending.forEach((frame) => frame(0)));
}

test("restores each session's anchor only after its own content arrives", () => {
  const { result, rerender } = mount();
  act(() => result.current.onScroll());
  const oldContentChanged = result.current.onContentChanged;
  expect(result.current.showBackToLatest).toBe(true);
  rerender({ sessionId: "b", timelineSessionId: "a" });
  act(() => { oldContentChanged(); result.current.onContentChanged(); });
  expect(scrollEnd).not.toHaveBeenCalled();
  rerender({ sessionId: "b", timelineSessionId: "b" });
  act(() => result.current.onContentChanged());
  expect(scrollEnd).toHaveBeenCalledTimes(1);
  surface.scrollTop = 50;
  anchorTop = 30;
  act(() => result.current.onScroll());

  rerender({ sessionId: "a", timelineSessionId: "a" });
  surface.scrollTop = 0;
  anchorTop = 400;
  act(() => result.current.onContentChanged());
  flushFrames();
  expect(surface.scrollTop).toBe(380);
  expect(result.current.showBackToLatest).toBe(true);
  rerender({ sessionId: "b", timelineSessionId: "b" });
  surface.scrollTop = 0;
  anchorTop = 100;
  act(() => result.current.onContentChanged());
  flushFrames();
  expect(surface.scrollTop).toBe(70);
  expect(scrollEnd).toHaveBeenCalledTimes(1);
});

test.each(["switch", "scroll", "send", "remove", "unmount"])("cancels a pending anchor restoration on %s", (intent) => {
  const { result, rerender, unmount } = mount();
  act(() => result.current.onScroll());
  rerender({ sessionId: "b", timelineSessionId: "b" });
  rerender({ sessionId: "a", timelineSessionId: "a" });
  surface.scrollTop = 333;
  anchorTop = 500;
  act(() => result.current.onContentChanged());
  expect(frames.size).toBe(1);

  act(() => {
    if (intent === "switch") rerender({ sessionId: "b", timelineSessionId: "b" });
    if (intent === "scroll") result.current.onScroll();
    if (intent === "send") result.current.followLatest();
    if (intent === "remove") result.current.removeSession("a");
    if (intent === "unmount") unmount();
  });
  flushFrames();
  expect(surface.scrollTop).toBe(333);
  expect(scrollEnd).not.toHaveBeenCalled();
  if (intent === "send") {
    act(() => result.current.onContentChanged());
    expect(scrollEnd).toHaveBeenCalledWith({ block: "end" });
    expect(result.current.showBackToLatest).toBe(false);
  }
});

test("moves scroll memory when a draft receives its Thread ID and forgets deleted sessions", () => {
  vi.mocked(document.elementFromPoint).mockReturnValue(null);
  const { result, rerender } = mount();
  act(() => { result.current.onScroll(); result.current.replaceSession("a", "thread-1"); });
  surface.scrollTop = 0;
  rerender({ sessionId: "thread-1", timelineSessionId: "thread-1" });
  act(() => result.current.onContentChanged());
  expect(surface.scrollTop).toBe(200);

  act(() => result.current.removeSession("thread-1"));
  rerender({ sessionId: "b", timelineSessionId: "b" });
  rerender({ sessionId: "thread-1", timelineSessionId: "thread-1" });
  scrollTo.mockClear();
  act(() => result.current.onContentChanged());
  expect(scrollTo).not.toHaveBeenCalled();
  expect(scrollEnd).toHaveBeenCalledWith({ block: "end" });
});

test("focuses a search match once its timeline arrives and lets the user return to latest", () => {
  const searchTarget = { sessionId: "a", turnId: "found", signal: 1 };
  const { result, rerender } = mount({ sessionId: "a", timelineSessionId: "b", searchTarget });
  act(() => result.current.onContentChanged());
  expect(scrollAnchor).not.toHaveBeenCalled();
  rerender({ sessionId: "a", timelineSessionId: "a", searchTarget });
  act(() => result.current.onContentChanged());
  expect(document.activeElement).toBe(anchor);
  expect(scrollAnchor).toHaveBeenCalledWith({ block: "center" });
  expect(result.current.showBackToLatest).toBe(true);
  act(() => result.current.onContentChanged());
  expect(scrollAnchor).toHaveBeenCalledTimes(1);
  expect(scrollEnd).not.toHaveBeenCalled();
  act(() => result.current.followLatest("smooth"));
  expect(scrollEnd).toHaveBeenCalledWith({ behavior: "smooth", block: "end" });
  expect(result.current.showBackToLatest).toBe(false);
});
