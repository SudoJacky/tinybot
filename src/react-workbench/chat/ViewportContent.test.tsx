// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useEffect, useState } from "react";
import { ViewportContent } from "./ViewportContent";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test("unmounts offscreen content, preserves height and parent state, and restores it on approach", () => {
  let intersect: IntersectionObserverCallback;
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: IntersectionObserverCallback) { intersect = callback; }
    observe() {} disconnect() {}
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ top: 0, bottom: 320, height: 320 } as DOMRect);
  const dispose = vi.fn();
  function Heavy() { useEffect(() => dispose, []); return <b>Expensive chart</b>; }
  function Card() {
    const [tab, setTab] = useState("chart");
    return <><button onClick={() => setTab("data")}>{tab}</button><ViewportContent placeholder="Chart summary"><Heavy /></ViewportContent></>;
  }
  const view = render(<Card />);
  fireEvent.click(screen.getByRole("button"));
  act(() => intersect!([{ isIntersecting: false }] as IntersectionObserverEntry[], {} as IntersectionObserver));
  expect(screen.queryByText("Expensive chart")).toBeNull();
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(view.container.querySelector<HTMLElement>(".react-viewport-content")!.style.height).toBe("320px");
  expect(screen.getByRole("button").textContent).toBe("data");
  act(() => intersect!([{ isIntersecting: true }] as IntersectionObserverEntry[], {} as IntersectionObserver));
  expect(screen.getByText("Expensive chart")).toBeTruthy();
});

test("does not mount distant content initially; streaming and focused content stay mounted", () => {
  let intersect: IntersectionObserverCallback;
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: IntersectionObserverCallback) { intersect = callback; }
    observe() {} disconnect() {}
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ top: 5000, bottom: 5320, height: 320 } as DOMRect);
  const view = render(<ViewportContent placeholder="Deferred"><button>Action</button></ViewportContent>);
  expect(screen.queryByRole("button")).toBeNull();
  view.rerender(<ViewportContent pinned><button>Action</button></ViewportContent>);
  act(() => screen.getByRole("button").focus());
  view.rerender(<ViewportContent><button>Action</button></ViewportContent>);
  act(() => intersect!([{ isIntersecting: false }] as IntersectionObserverEntry[], {} as IntersectionObserver));
  expect(screen.getByRole("button")).toBe(document.activeElement);
});

test("reveals a saved offscreen message before scroll restoration and releases it after visiting", () => {
  let intersect: IntersectionObserverCallback;
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: IntersectionObserverCallback) { intersect = callback; }
    observe() {} disconnect() {}
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ top: 5000, bottom: 5320, height: 320 } as DOMRect);
  const view = render(<ViewportContent placeholder="Saved message"><b>Rich answer</b></ViewportContent>);
  expect(screen.queryByText("Rich answer")).toBeNull();
  act(() => view.container.firstElementChild!.dispatchEvent(new Event("tinybot:viewport-reveal")));
  expect(screen.getByText("Rich answer")).toBeTruthy();
  act(() => intersect!([{ isIntersecting: true }] as IntersectionObserverEntry[], {} as IntersectionObserver));
  act(() => intersect!([{ isIntersecting: false }] as IntersectionObserverEntry[], {} as IntersectionObserver));
  expect(screen.queryByText("Rich answer")).toBeNull();
});
