// @vitest-environment happy-dom
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { SessionSidebarResizeHandle } from "./SessionSidebarResizeHandle";

const key = "tinybot.session-sidebar-width";
let resize: () => void;
let availableWidth = 1100;
beforeEach(() => {
  availableWidth = 1100;
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => availableWidth);
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resize = callback; }
    observe() {}
    disconnect() {}
  });
});
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function setup() {
  const contentRender = vi.fn();
  function Content() { contentRender(); return <main>Chat content</main>; }
  function Fixture() {
    const [collapsed, setCollapsed] = useState(false);
    return <section>
      <aside data-collapsed={collapsed}>
        <SessionSidebarResizeHandle collapsed={collapsed} onCollapsedChange={setCollapsed} />
        <button onClick={() => setCollapsed(!collapsed)}>{collapsed ? "Expand" : "Collapse"}</button>
      </aside>
      <Content />
    </section>;
  }
  const view = render(<Fixture />);
  const handle = screen.getByRole("separator");
  const sidebar = handle.parentElement!;
  let capture = false;
  handle.setPointerCapture = vi.fn(() => { capture = true; });
  handle.hasPointerCapture = vi.fn(() => capture);
  handle.releasePointerCapture = vi.fn(() => { capture = false; });
  vi.spyOn(sidebar, "getBoundingClientRect").mockImplementation(() => ({
    width: Number.parseFloat(sidebar.style.getPropertyValue("--session-sidebar-width")),
  } as DOMRect));
  const down = (x: number) => fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: x });
  const move = (x: number) => fireEvent.pointerMove(handle, { pointerId: 1, clientX: x });
  const up = () => fireEvent.pointerUp(handle, { pointerId: 1 });
  const width = () => Number.parseFloat(sidebar.style.getPropertyValue("--session-sidebar-width"));
  return { ...view, handle, sidebar, down, move, up, width, contentRender };
}

test("tracks the grab offset without rerendering chat content and saves only on release", () => {
  const view = setup();
  const writes = vi.spyOn(Storage.prototype, "setItem");
  view.down(235);
  view.move(345);
  expect(view.width()).toBe(350);
  act(() => resize());
  expect(view.width()).toBe(350);
  expect(view.sidebar.dataset.resizing).toBe("true");
  expect(writes).not.toHaveBeenCalled();
  expect(view.contentRender).toHaveBeenCalledTimes(1);
  view.up();
  expect(localStorage.getItem(key)).toBe("350");
  expect(view.sidebar.dataset.resizing).toBeUndefined();
  expect(document.body.style.cursor).toBe("");
  view.unmount();
  expect(setup().width()).toBe(350);
});

test("clamps at both limits and only collapses after 48 pixels beyond the minimum", () => {
  localStorage.setItem(key, "340");
  const view = setup();
  view.down(340);
  view.move(600);
  expect(view.width()).toBe(420);
  view.move(200);
  expect(view.width()).toBe(220);
  view.move(173);
  expect(view.sidebar.dataset.collapsed).toBe("false");
  view.move(172);
  expect(view.sidebar.dataset.collapsed).toBe("true");
  expect(localStorage.getItem(key)).toBe("340");
  expect(document.activeElement).toBe(view.handle);
  expect(view.handle.hasPointerCapture(1)).toBe(true);
  view.up();
  expect(view.sidebar.dataset.collapsed).toBe("true");
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Expand" }));
  fireEvent.click(screen.getByRole("button", { name: "Expand" }));
  expect(view.width()).toBe(340);
});

test("reverses collapse repeatedly within one held drag and saves only the final expanded width", () => {
  localStorage.setItem(key, "340");
  const view = setup();
  view.down(340);
  view.move(172);
  expect(view.sidebar.dataset.collapsed).toBe("true");
  view.move(219);
  expect(view.sidebar.dataset.collapsed).toBe("true");
  view.move(220);
  expect(view.sidebar.dataset.collapsed).toBe("false");
  expect(view.width()).toBe(220);
  expect(view.handle.hasPointerCapture(1)).toBe(true);
  view.move(200);
  expect(view.sidebar.dataset.collapsed).toBe("false");
  view.move(172);
  expect(view.sidebar.dataset.collapsed).toBe("true");
  view.move(380);
  expect(view.sidebar.dataset.collapsed).toBe("false");
  expect(view.width()).toBe(380);
  expect(localStorage.getItem(key)).toBe("340");
  expect(document.activeElement).toBe(view.handle);
  expect(view.handle.releasePointerCapture).not.toHaveBeenCalled();
  view.up();
  expect(localStorage.getItem(key)).toBe("380");
  expect(view.handle.releasePointerCapture).toHaveBeenCalledOnce();
  view.move(172);
  expect(view.sidebar.dataset.collapsed).toBe("false");
});

test("cancelling while collapsed ends capture and preserves the saved expanded width", () => {
  localStorage.setItem(key, "340");
  const view = setup();
  view.down(340);
  view.move(172);
  fireEvent.pointerCancel(view.handle, { pointerId: 1 });
  expect(view.handle.hasPointerCapture(1)).toBe(false);
  expect(view.sidebar.dataset.resizing).toBeUndefined();
  expect(view.sidebar.dataset.collapsed).toBe("true");
  expect(localStorage.getItem(key)).toBe("340");
  fireEvent.click(screen.getByRole("button", { name: "Expand" }));
  expect(view.width()).toBe(340);
});

test.each(["escape", "pointercancel", "blur", "lostcapture"])("cancels %s without saving and restores page interaction", (reason) => {
  const view = setup();
  view.down(240);
  view.move(360);
  if (reason === "escape") fireEvent.keyDown(view.handle, { key: "Escape" });
  if (reason === "pointercancel") fireEvent.pointerCancel(view.handle, { pointerId: 1 });
  if (reason === "blur") fireEvent.blur(window);
  if (reason === "lostcapture") fireEvent.lostPointerCapture(view.handle, { pointerId: 1 });
  expect(view.width()).toBe(240);
  expect(localStorage.getItem(key)).toBeNull();
  expect(document.body.style.userSelect).toBe("");
  expect(document.body.style.cursor).toBe("");
});

test("temporarily limits width for the window and restores the saved preference when space returns", () => {
  localStorage.setItem(key, "400");
  const view = setup();
  act(() => { availableWidth = 800; resize(); });
  expect(view.width()).toBe(320);
  expect(view.handle.getAttribute("aria-valuemax")).toBe("320");
  expect(localStorage.getItem(key)).toBe("400");
  view.down(320);
  view.up();
  expect(localStorage.getItem(key)).toBe("400");
  act(() => { availableWidth = 1100; resize(); });
  expect(view.width()).toBe(400);
});

test("supports keyboard increments, bounds, and double-click reset", () => {
  const view = setup();
  fireEvent.keyDown(view.handle, { key: "ArrowRight" });
  expect(view.width()).toBe(248);
  fireEvent.keyDown(view.handle, { key: "ArrowLeft", shiftKey: true });
  expect(view.width()).toBe(220);
  fireEvent.keyDown(view.handle, { key: "Home" });
  fireEvent.keyDown(view.handle, { key: "ArrowLeft" });
  expect(view.width()).toBe(220);
  expect(view.sidebar.dataset.collapsed).toBe("false");
  fireEvent.keyDown(view.handle, { key: "End" });
  expect(view.width()).toBe(420);
  fireEvent.doubleClick(view.handle);
  expect(view.width()).toBe(240);
  expect(localStorage.getItem(key)).toBe("240");
});

test("releases global drag styles when the sidebar unmounts mid-gesture", () => {
  document.body.style.cursor = "crosshair";
  const view = setup();
  view.down(240);
  view.move(340);
  view.unmount();
  expect(document.body.style.cursor).toBe("crosshair");
  expect(document.body.style.userSelect).toBe("");
  expect(localStorage.getItem(key)).toBeNull();
  document.body.style.cursor = "";
});
