// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from "vitest";
import { startSessionReorderMotion } from "./sessionReorderMotion";

const controllers: { dispose: () => void }[] = [];
afterEach(() => {
  controllers.forEach((controller) => controller.dispose());
  controllers.length = 0;
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function fixture(reduced = false) {
  vi.useFakeTimers();
  vi.spyOn(window, "matchMedia").mockReturnValue(Object.assign(new EventTarget(), { matches: reduced }) as MediaQueryList);
  document.body.innerHTML = '<aside class="react-session-list"><div class="react-session-list__rows">'
    + ["a", "b", "c"].map((id) => '<div class="react-session-row" data-session-id="' + id + '" data-reorder-container="general"><button>' + id + '</button></div>').join("")
    + '</div></aside>';
  const scroller = document.querySelector<HTMLElement>(".react-session-list__rows")!;
  const rows = [...scroller.querySelectorAll<HTMLElement>(".react-session-row")];
  const rectangle = (top: number, height: number) => ({ top, bottom: top + height, left: 0, right: 200, x: 0, y: top, width: 200, height, toJSON: () => ({}) });
  vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue(rectangle(0, 200));
  rows.forEach((row, index) => vi.spyOn(row, "getBoundingClientRect").mockReturnValue(rectangle(40 + index * 36, 36)));
  const animate = vi.spyOn(Element.prototype, "animate").mockImplementation(() => ({ cancel: vi.fn() }) as unknown as Animation);
  const transfer = { setDragImage: vi.fn(), dropEffect: "none" } as unknown as DataTransfer;
  const commit = vi.fn();
  const end = vi.fn();
  const controller = startSessionReorderMotion(rows[0], transfer, { clientX: 100, clientY: 58 }, commit, end)!;
  controllers.push(controller);
  function send(type: string, x = 100, y = 140) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, { clientX: x, clientY: y, dataTransfer: transfer });
    scroller.dispatchEvent(event);
    return event;
  }
  return { rows, send, commit, end, controller, animate };
}

describe("session drag motion", () => {
  test("previews without committing and accepts drop immediately after entering the opened slot", () => {
    const { rows, send, commit, end } = fixture();
    expect(send("dragenter").defaultPrevented).toBe(true);
    expect(commit).not.toHaveBeenCalled();
    expect(rows[1].style.transform).toBe("translateY(-36px)");
    expect(rows[2].style.transform).toBe("translateY(-36px)");
    send("drop");
    expect(commit).toHaveBeenCalledExactlyOnceWith("c", "after");
    expect(end).toHaveBeenCalledOnce();
    send("dragend");
    expect(commit).toHaveBeenCalledOnce();
  });

  test.each(["dragend", "blur", "keydown"])("cancels with %s and never persists the preview", (type) => {
    const { rows, send, commit, controller } = fixture();
    send("dragover");
    if (type === "keydown") window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    else window.dispatchEvent(new Event(type));
    expect(commit).not.toHaveBeenCalled();
    expect(rows.every((row) => !row.dataset.reorderPreview && !row.style.transform)).toBe(true);
    controller.dispose();
    expect(document.querySelector(".react-session-drag-ghost")).toBeNull();
    expect(rows[0].dataset.reorderLifted).toBeUndefined();
  });

  test("rejects drops outside the source group and can return from outside before dropping", () => {
    const { send, commit } = fixture();
    expect(send("dragover", 300).defaultPrevented).toBe(false);
    expect(send("dragover", 100, 180).defaultPrevented).toBe(false);
    expect(commit).not.toHaveBeenCalled();
    send("dragover");
    send("drop");
    expect(commit).toHaveBeenCalledExactlyOnceWith("c", "after");
  });

  test("does not commit an invalid final drop after a valid preview", () => {
    const { send, commit } = fixture();
    send("dragover");
    send("drop", 300);
    expect(commit).not.toHaveBeenCalled();
  });

  test("reduced motion preserves direct dragging and sorting without deformation or settling", () => {
    const { send, commit, animate, rows } = fixture(true);
    send("dragover");
    expect(document.querySelector<HTMLElement>(".react-session-drag-ghost__skin")!.style.transform).toBe("");
    send("drop");
    expect(commit).toHaveBeenCalledExactlyOnceWith("c", "after");
    expect(animate).not.toHaveBeenCalled();
    expect(document.querySelector(".react-session-drag-ghost")).toBeNull();
    expect(rows[0].dataset.reorderLifted).toBeUndefined();
  });

  test("disposal removes global listeners and the floating row", () => {
    const { controller, send, commit, end } = fixture();
    controller.dispose();
    send("dragover");send("drop");
    expect(commit).not.toHaveBeenCalled();
    expect(end).toHaveBeenCalledOnce();
    expect(document.querySelector(".react-session-drag-ghost")).toBeNull();
  });
});
