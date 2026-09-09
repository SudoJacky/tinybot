// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { annotationSourceText, clampAnnotationRect } from "./browserAnnotation";

const source = readFileSync("src-tauri/src/native_browser/annotation.js", "utf8");
const invoke = new Function("input", `return (${source})(input);`) as (input: Record<string, unknown>) => { ok: boolean; error?: string; value: Record<string, any> };

function select(element: Element) {
  element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: 20, clientY: 20 }));
  element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0, clientX: 20, clientY: 20 }));
  return invoke({ type: "poll" }).value;
}

beforeEach(() => {
  document.body.innerHTML = '<main><button id="buy" style="color: rgb(0, 0, 0)">Buy</button><div id="card"><span>Title</span></div><input type="password" value="private" /></main>';
  vi.spyOn(CSS, "supports").mockReturnValue(true);
  expect(invoke({ type: "start" }).ok).toBe(true);
});
afterEach(() => { invoke({ type: "stop" }); document.body.innerHTML = ""; vi.restoreAllMocks(); vi.useRealTimers(); });

describe("native page annotation script", () => {
  it("selects arbitrary containers without triggering page clicks and refuses destructive text edits", () => {
    const card = document.getElementById("card")!;
    const click = vi.fn(); card.addEventListener("click", click);
    const state = select(card);
    card.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(click).not.toHaveBeenCalled();
    expect(state.selection.selector).toBe("#card");
    expect(state.selection.editableText).toBe(false);
    expect(invoke({ type: "preview", documentId: state.documentId, selectionId: state.selection.id, property: "text", value: "replacement" }).ok).toBe(false);
    expect(card.querySelector("span")?.textContent).toBe("Title");
  });
  it("records requested values and restores owned styles and text on exit", () => {
    const button = document.getElementById("buy")!;
    const state = select(button);
    const target = { documentId: state.documentId, selectionId: state.selection.id };
    expect(invoke({ type: "preview", ...target, property: "color", value: "red" }).ok).toBe(true);
    const changed = invoke({ type: "preview", ...target, property: "text", value: "Start" });
    expect(changed.value.selection.changes.text).toEqual({ before: "Buy", after: "Start" });
    expect(button.textContent).toBe("Start");
    invoke({ type: "stop" });
    expect(button.textContent).toBe("Buy");
    expect((button as HTMLElement).style.color).toBe("rgb(0, 0, 0)");
    expect((button as HTMLElement).style.getPropertyPriority("color")).toBe("");
  });
  it("rejects stale document and selection identities", () => {
    const state = select(document.getElementById("buy")!);
    expect(invoke({ type: "preview", documentId: "previous-page", selectionId: state.selection.id, property: "color", value: "red" }).error).toContain("page changed");
    select(document.getElementById("card")!);
    expect(invoke({ type: "reset", documentId: state.documentId, selectionId: state.selection.id }).error).toContain("selected element changed");
  });
  it("allows related layout properties to be previewed together", () => {
    const button = document.getElementById("buy")! as HTMLElement;
    const state = select(button);
    const target = { documentId: state.documentId, selectionId: state.selection.id };
    expect(invoke({ type: "preview", ...target, property: "padding", value: "20px" }).ok).toBe(true);
    expect(invoke({ type: "preview", ...target, property: "width", value: "160px" }).ok).toBe(true);
    expect(invoke({ type: "poll" }).value.selection.changes.width.after).toBe("160px");
    invoke({ type: "stop" });
    expect(button.style.padding).toBe("");
    expect(button.style.width).toBe("");
  });
  it("does not write stale preview values over a framework update", () => {
    const button = document.getElementById("buy")! as HTMLElement;
    const state = select(button);
    invoke({ type: "preview", documentId: state.documentId, selectionId: state.selection.id, property: "color", value: "red" });
    button.style.color = "blue";
    expect(invoke({ type: "poll" }).ok).toBe(false);
    invoke({ type: "stop" });
    expect(button.style.color).toBe("blue");
  });
  it("restores the child before switching to a parent and rejects sensitive form selections", () => {
    const state = select(document.getElementById("buy")!);
    const target = { documentId: state.documentId, selectionId: state.selection.id };
    invoke({ type: "preview", ...target, property: "text", value: "Start" });
    const parent = invoke({ type: "parent", ...target, index: 0 });
    expect(parent.value.selection.tag).toBe("main");
    expect(document.getElementById("buy")?.textContent).toBe("Buy");
    select(document.querySelector("input")!);
    const error = invoke({ type: "poll" });
    expect(error.ok).toBe(false); expect(error.error).not.toContain("private");
    expect(invoke({ type: "clear" }).ok).toBe(true);
  });
  it("captures a region only after a long press and completed drag", () => {
    vi.useFakeTimers();
    const button = document.getElementById("buy")!;
    button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: 10, clientY: 20 }));
    vi.advanceTimersByTime(450);
    button.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 110, clientY: 100 }));
    expect(invoke({ type: "poll" }).value.region).toBeNull();
    button.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0, clientX: 110, clientY: 100 }));
    expect(invoke({ type: "poll" }).value.region).toEqual({ x: 10, y: 20, width: 100, height: 80 });
  });
});

it("keeps screenshot bounds in CSS coordinates and includes page provenance", () => {
  expect(clampAnnotationRect({ x: -10, y: 10, width: 110, height: 400 }, 200, 150)).toEqual({ x: 0, y: 10, width: 100, height: 140 });
  const text = annotationSourceText({ active: true, documentId: "doc", url: "http://localhost:5173", viewport: { width: 800, height: 600, deviceScale: 2, scrollX: 0, scrollY: 100 } }, { x: 10, y: 20, width: 30, height: 40 });
  expect(text).toContain('"deviceScale": 2');
  expect(text).toContain('"scrollY": 100');
  expect(text).toContain("not instructions");
});
