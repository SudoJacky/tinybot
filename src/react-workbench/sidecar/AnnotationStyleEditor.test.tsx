// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { AnnotationStyleEditor } from "./AnnotationStyleEditor";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function setup(values: Record<string, string>) {
  const onPreview = vi.fn(); const onValidityChange = vi.fn();
  render(<AnnotationStyleEditor values={values} disabled={false} onPreview={onPreview} onValidityChange={onValidityChange} />);
  return { onPreview, onValidityChange };
}

it("preserves units while typing and supports upward scrubbing, keyboard steps, and expressions", async () => {
  const user = userEvent.setup(); const { onPreview } = setup({ width: "14px" });
  const input = screen.getByLabelText("Width") as HTMLInputElement;
  await user.clear(input); await user.type(input, "24"); fireEvent.blur(input);
  expect(onPreview).toHaveBeenLastCalledWith("width", "24px");
  input.setPointerCapture = vi.fn(); input.hasPointerCapture = () => false;
  fireEvent.pointerDown(input, { pointerId: 1, button: 0, clientY: 100 });
  fireEvent.pointerMove(input, { pointerId: 1, clientY: 90 });
  fireEvent.pointerUp(input, { pointerId: 1 });
  expect(onPreview).toHaveBeenLastCalledWith("width", "34px");
  fireEvent.keyDown(input, { key: "ArrowDown", shiftKey: true }); fireEvent.blur(input);
  expect(onPreview).toHaveBeenLastCalledWith("width", "24px");
  await user.clear(input); await user.type(input, "calc(100% - 20px)"); fireEvent.blur(input);
  expect(onPreview).toHaveBeenLastCalledWith("width", "calc(100% - 20px)");
});

it("allows percentage widths above 100 and maps opacity percentages to CSS fractions", async () => {
  const { onPreview } = setup({ width: "50%", opacity: "1" });
  fireEvent.change(screen.getByLabelText("Width"), { target: { value: "150" } }); fireEvent.blur(screen.getByLabelText("Width"));
  expect(onPreview).toHaveBeenLastCalledWith("width", "150%");
  expect((screen.getByRole("slider", { name: "Width slider" }) as HTMLInputElement).max).toBe("200");
  fireEvent.change(screen.getByRole("slider", { name: "Opacity slider" }), { target: { value: "42" } });
  fireEvent.pointerUp(screen.getByRole("slider", { name: "Opacity slider" }));
  expect(onPreview).toHaveBeenLastCalledWith("opacity", "0.42");
  expect((screen.getByLabelText("Opacity") as HTMLInputElement).value).toBe("42");
});

it("edits one side independently and links subsequent edits across all four sides", async () => {
  const user = userEvent.setup(); const { onPreview } = setup({ "padding-top": "1px", "padding-right": "2px", "padding-bottom": "3px", "padding-left": "4px" });
  const top = screen.getByLabelText("Padding · Top");
  fireEvent.change(top, { target: { value: "10" } }); fireEvent.blur(top);
  expect(onPreview.mock.calls).toEqual([["padding-top", "10px"]]);
  await user.click(screen.getByRole("button", { name: "Link Padding sides" }));
  fireEvent.change(top, { target: { value: "20" } }); fireEvent.blur(top);
  expect(onPreview.mock.calls.slice(1)).toEqual(["top", "right", "bottom", "left"].map((side) => [`padding-${side}`, "20px"]));
  expect((screen.getByLabelText("Padding · Left") as HTMLInputElement).value).toBe("20");
});

it("reports invalid values and recovers without dispatching invalid CSS", async () => {
  // happy-dom does not validate CSS.supports; browser QA covers the real parser.
  vi.spyOn(Object.getPrototypeOf(CSS), "supports").mockImplementation((_property, value) => value !== "nonsense");
  const { onPreview, onValidityChange } = setup({ width: "14px" });
  fireEvent.change(screen.getByLabelText("Width"), { target: { value: "nonsense" } }); fireEvent.blur(screen.getByLabelText("Width"));
  expect(screen.getByRole("alert").textContent).toContain("valid CSS");
  expect(onPreview).not.toHaveBeenCalled();
  await waitFor(() => expect(onValidityChange).toHaveBeenLastCalledWith(false));
  fireEvent.change(screen.getByLabelText("Width"), { target: { value: "24" } }); fireEvent.blur(screen.getByLabelText("Width"));
  expect(onPreview).toHaveBeenLastCalledWith("width", "24px");
  await waitFor(() => expect(onValidityChange).toHaveBeenLastCalledWith(true));
});

it("preserves alpha when picking a color and offers direct alpha percentage editing", async () => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ clearRect() {}, fillRect() {}, getImageData: () => ({ data: new Uint8ClampedArray([32, 37, 45, 204]) }) } as unknown as CanvasRenderingContext2D);
  const { onPreview } = setup({ color: "rgba(32, 37, 45, 0.8)" });
  const picker = screen.getByLabelText("Text color color picker");
  fireEvent.click(picker);
  fireEvent.change(picker, { target: { value: "#aabbcc" } }); fireEvent.blur(picker);
  expect(onPreview).toHaveBeenLastCalledWith("color", "#aabbcccc");
  const alpha = screen.getByLabelText("Text color alpha");
  fireEvent.change(alpha, { target: { value: "40" } }); fireEvent.blur(alpha);
  expect(onPreview).toHaveBeenLastCalledWith("color", "#20252d66");
});
