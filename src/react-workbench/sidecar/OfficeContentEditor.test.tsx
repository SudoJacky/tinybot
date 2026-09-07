// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OfficeContentEditor } from "./OfficeContentEditor";

afterEach(() => { cleanup(); window.getSelection()?.removeAllRanges(); document.body.replaceChildren(); });
function setup(kind: "document" | "presentation" = "document") {
  const root = document.createElement("div");
  root.innerHTML = kind === "document" ? "<p>Selected original content</p>" : '<div class="pptx-preview-wrapper"><div class="pptx-preview-slide-wrapper">First</div><div class="pptx-preview-slide-wrapper"></div></div>';
  document.body.append(root);
  const props = { kind, containerRef: { current: root }, sourceBytes: new Uint8Array([1]), ready: true, activeSlide: 1, onChange: vi.fn() };
  return { props, root, ...render(<OfficeContentEditor {...props} />) };
}
function select(root: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(root.querySelector("p")!);
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);
  fireEvent(document, new Event("selectionchange"));
}
describe("Office change editor", () => {
  it("keeps the quote while typing and submits it with the request", async () => {
    const { root, props } = setup();
    select(root);
    fireEvent.click(await screen.findByRole("button", { name: "Ask for change" }));
    const input = screen.getByRole("textbox", { name: "Change request for selected content" });
    input.focus();
    fireEvent(document, new Event("selectionchange"));
    fireEvent.change(input, { target: { value: "Rewrite the opening" } });
    fireEvent.click(screen.getByRole("button", { name: "Add change request" }));
    expect(props.onChange).toHaveBeenCalledWith(expect.objectContaining({ kind: "document", start: 1, text: "Selected original content", instruction: "Rewrite the opening" }));
    expect(screen.queryByRole("textbox")).toBeNull();
  });
  it("allows a whole-slide request even if the slide contains no text", async () => {
    const { props } = setup("presentation");
    fireEvent.click(screen.getByRole("button", { name: "Change slide 2" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Move the image to the center" } });
    fireEvent.click(screen.getByRole("button", { name: "Add change request" }));
    expect(props.onChange).toHaveBeenCalledWith(expect.objectContaining({ kind: "presentation", start: 2, end: 2, wholeSlide: true, text: "" }));
  });
  it("invalidates the selection and request when file bytes change", async () => {
    const { root, props, rerender } = setup();
    select(root);
    fireEvent.click(await screen.findByRole("button", { name: "Ask for change" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Old request" } });
    rerender(<OfficeContentEditor {...props} sourceBytes={new Uint8Array([2])} />);
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
    expect(props.onChange).not.toHaveBeenCalled();
  });
  it("opens with Ctrl+I and cancels locally with Escape", async () => {
    const { root, props } = setup();
    select(root);
    fireEvent.keyDown(document, { key: "i", ctrlKey: true });
    const input = await screen.findByRole("textbox");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(props.onChange).not.toHaveBeenCalled();
  });
});
