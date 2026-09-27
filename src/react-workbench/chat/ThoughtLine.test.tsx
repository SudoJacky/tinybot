// @vitest-environment happy-dom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ThoughtLine, type ThoughtPhase } from "./ThoughtLine";

afterEach(() => { cleanup(); vi.useRealTimers(); });

it("ticks only the elapsed leaf, freezes to recorded time, and never clocks historical or unknown starts", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-27T10:00:05Z'));
  const contentRender = vi.fn();
  function Content() { contentRender(); return <p>Tool details</p>; }
  const view = (phase: ThoughtPhase, startedAt = '2026-09-27T10:00:00Z', endedAt?: string) =>
    <ThoughtLine phase={phase} startedAt={startedAt} endedAt={endedAt} open onOpenChange={() => undefined}><Content /></ThoughtLine>;
  const {container, rerender, unmount} = render(view('thinking'));
  const time = () => container.querySelector('.react-thought-line__timer')?.textContent;
  expect(time()).toBe('5s');
  contentRender.mockClear();
  act(() => vi.advanceTimersByTime(2000));
  expect(time()).toBe('7s');
  expect(contentRender).not.toHaveBeenCalled();
  rerender(view('completed', '2026-09-27T10:00:00Z', '2026-09-27T10:00:06Z'));
  expect(time()).toBe('6s');
  expect(vi.getTimerCount()).toBe(0);
  act(() => vi.advanceTimersByTime(2000));
  expect(time()).toBe('6s');
  rerender(view('thinking', 'invalid'));
  expect(time()).toBeUndefined();
  expect(vi.getTimerCount()).toBe(0);
  unmount();
  const history = render(view('completed', '2026-09-27T10:00:00Z', '2026-09-27T10:00:06Z'));
  expect(history.container.querySelector('[data-working]')).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});
