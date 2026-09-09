// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { NativeBrowserRuntimeApi } from "../../app-core/native/desktopNativeBrowser";
import type { BrowserAnnotationState } from "../../app-core/native/browserAnnotation";
import { importDesktopChatFiles } from "../../app-core/native/desktopNativeFilePicker";
import { BrowserAnnotationWorkspace } from "./BrowserAnnotationWorkspace";
import { annotationImageFile } from "./BrowserAnnotationImage";

vi.mock("../../app-core/native/desktopNativeFilePicker", () => ({ importDesktopChatFiles: vi.fn() }));
vi.mock("./BrowserAnnotationImage", () => ({ BrowserAnnotationImage: () => null, annotationImageFile: vi.fn(async () => new File(["png"], "annotation.png", { type: "image/png" })) }));
const evidence: BrowserAnnotationState = {
  active: true, documentId: "document-1", selectionId: 1, url: "http://localhost:5173", title: "Demo",
  viewport: { width: 900, height: 600, deviceScale: 2, scrollX: 0, scrollY: 0 },
  selection: { id: 1, tag: "button", selector: "#buy", text: "Buy", editableText: true, ancestors: [], styles: { color: "black" }, rect: { x: 20, y: 20, width: 80, height: 40 }, changes: {} },
};

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ clearRect() {}, fillRect() {}, getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, 255]) }) } as unknown as CanvasRenderingContext2D);
  vi.mocked(importDesktopChatFiles).mockReset().mockResolvedValue([{ contentHash: "hash", path: "C:/attachments/annotation.png", name: "annotation.png", mimeType: "image/png", sizeBytes: 3 }]);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.restoreAllMocks(); });

function setup() {
  const order: string[] = [];
  let state = structuredClone(evidence);
  const annotate = vi.fn<NativeBrowserRuntimeApi["annotate"]>(async ({ action }) => {
    order.push(action.type);
    if (action.type === "stop") return { active: false };
    if (action.type === "clear") state = { ...state, selection: null, region: null };
    if (action.type === "preview") state = { ...state, selection: { ...state.selection!, changes: { [action.property]: { before: "black", after: action.value } } } };
    if (action.type === "capture") return { ...state, dataUrl: "data:image/png;base64,AAAA", observedAt: "2026-09-09T00:00:00Z" };
    return state;
  });
  const onReference = vi.fn(() => { order.push("attached"); });
  const onClose = vi.fn();
  const onError = vi.fn();
  const props = { active: true, browserSessionId: "browser", tabId: "tab", runtime: { annotate } as unknown as NativeBrowserRuntimeApi, onReference, onClose, onError, renderSurface: () => <div>Page surface</div> };
  const view = render(<BrowserAnnotationWorkspace {...props} />);
  return { ...view, props, annotate, onReference, onClose, onError, order };
}

it("queues property edits before capture and restores the page before attaching the user's instruction", async () => {
  const user = userEvent.setup();
  const view = setup();
  await user.click(await screen.findByRole("button", { name: "Edit element properties" }));
  const color = await screen.findByLabelText("Text color");
  await user.clear(color); await user.type(color, "blue");
  await user.click(screen.getByLabelText("Requested change"));
  await user.type(screen.getByLabelText("Requested change"), "Use the brand color");
  await user.click(screen.getByRole("button", { name: "Add to composer" }));
  await waitFor(() => expect(view.onReference).toHaveBeenCalledTimes(1));
  const reference = view.onReference.mock.calls[0] as unknown as [{ userAnnotation: string; sourceText: string; contentHash: string }];
  expect(reference[0].userAnnotation).toBe("Use the brand color");
  expect(reference[0].sourceText).toContain('"after": "blue"');
  expect(reference[0].contentHash).toBe("hash");
  expect(annotationImageFile).toHaveBeenLastCalledWith(expect.any(String), evidence.viewport, { x: 8, y: 8, width: 104, height: 64 });
  expect(reference[0].sourceText).not.toContain('"styles"');
  expect(reference[0].sourceText).not.toContain('"ancestors"');
  expect(view.order.indexOf("preview")).toBeLessThan(view.order.indexOf("capture"));
  expect(view.order.indexOf("clear")).toBeLessThan(view.order.indexOf("attached"));
  expect(view.onClose).not.toHaveBeenCalled();
});

it("preserves the draft and reports import failure without attaching or ending the annotation", async () => {
  vi.mocked(importDesktopChatFiles).mockRejectedValueOnce(new Error("Attachment storage unavailable"));
  const user = userEvent.setup();
  const view = setup();
  await screen.findByLabelText("Requested change");
  await user.type(screen.getByLabelText("Requested change"), "Keep this draft");
  await user.click(screen.getByRole("button", { name: "Add to composer" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Attachment storage unavailable");
  expect((screen.getByLabelText("Requested change") as HTMLTextAreaElement).value).toBe("Keep this draft");
  expect(view.onReference).not.toHaveBeenCalled();
  expect(view.onClose).not.toHaveBeenCalled();
});

it("restores the native page when its workspace unmounts", async () => {
  const view = setup();
  await screen.findByLabelText("Requested change");
  view.unmount();
  await waitFor(() => expect(view.annotate).toHaveBeenCalledWith(expect.objectContaining({ action: { type: "stop" } })));
});

it("does not attach a late import or stop a newly opened annotation session", async () => {
  let finishImport!: (value: Awaited<ReturnType<typeof importDesktopChatFiles>>) => void;
  vi.mocked(importDesktopChatFiles).mockImplementationOnce(() => new Promise((resolve) => { finishImport = resolve; }));
  const user = userEvent.setup();
  const view = setup();
  await screen.findByLabelText("Requested change");
  await user.type(screen.getByLabelText("Requested change"), "Old annotation");
  await user.click(screen.getByRole("button", { name: "Add to composer" }));
  await waitFor(() => expect(importDesktopChatFiles).toHaveBeenCalledOnce());
  view.rerender(<BrowserAnnotationWorkspace {...view.props} active={false} />);
  view.rerender(<BrowserAnnotationWorkspace {...view.props} active />);
  await waitFor(() => expect(view.order.filter((item) => item === "start")).toHaveLength(2));
  finishImport([{ contentHash: "hash", path: "old.png", name: "old.png", mimeType: "image/png", sizeBytes: 3 }]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(view.onReference).not.toHaveBeenCalled();
  expect(view.order.filter((item) => item === "stop")).toHaveLength(1);
});


it("starts with a comment-only editor and can attach without opening properties", async () => {
  const user = userEvent.setup();
  const view = setup();
  const comment = await screen.findByLabelText("Requested change");
  expect(screen.queryByRole("textbox", { name: "Text color" })).toBeNull();
  await user.type(comment, "Make this clearer{Enter}");
  await waitFor(() => expect(view.onReference).toHaveBeenCalledOnce());
  expect(view.onClose).not.toHaveBeenCalled();
  expect(view.order).not.toContain("preview");
  expect(view.order.indexOf("clear")).toBeLessThan(view.order.indexOf("attached"));
  await waitFor(() => expect(screen.queryByLabelText("Requested change")).toBeNull());
  expect(view.annotate).toHaveBeenCalledWith(expect.objectContaining({ action: { type: "overlay", rect: null } }));
});

it("preserves the comment when toggling property controls and cancels previews explicitly", async () => {
  const user = userEvent.setup();
  const view = setup();
  await user.type(await screen.findByLabelText("Requested change"), "Keep my comment");
  const toggle = screen.getByRole("button", { name: "Edit element properties" });
  await user.click(toggle);
  expect(screen.getByLabelText("Text color")).toBeTruthy();
  await user.click(toggle);
  expect(screen.queryByRole("textbox", { name: "Text color" })).toBeNull();
  expect((screen.getByLabelText("Requested change") as HTMLTextAreaElement).value).toBe("Keep my comment");
  await user.click(screen.getByRole("button", { name: "Cancel annotation" }));
  await waitFor(() => expect(view.order).toContain("clear"));
  expect(view.onReference).not.toHaveBeenCalled();
});

it("keeps the comment anchored across expansion and preserves a dragged position through collapse", async () => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, toJSON: () => ({}) });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(350);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function(this: HTMLElement) { return this.dataset.expanded === "true" ? 380 : 64; });
  const user = userEvent.setup();
  const view = setup();
  const editor = await screen.findByRole("group", { name: "Annotate page" });
  const top = editor.style.top;
  await user.click(screen.getByRole("button", { name: "Edit element properties" }));
  expect(editor.style.top).toBe(top);
  const handle = screen.getByRole("button", { name: /Move annotation editor/ });
  handle.setPointerCapture = vi.fn(); handle.hasPointerCapture = () => false;
  fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 30, clientY: 80 });
  fireEvent.pointerMove(handle, { pointerId: 1, clientX: 170, clientY: 140 });
  fireEvent.pointerUp(handle, { pointerId: 1 });
  expect(editor.style.left).toBe("160px");
  expect(editor.style.top).toBe(`${Number.parseFloat(top) + 60}px`);
  await user.click(screen.getByRole("button", { name: "Edit element properties" }));
  await user.click(screen.getByRole("button", { name: "Edit element properties" }));
  expect(editor.style.left).toBe("160px");
  expect(editor.style.top).toBe(`${Number.parseFloat(top) + 60}px`);
  await waitFor(() => expect(view.annotate).toHaveBeenCalledWith(expect.objectContaining({ action: { type: "overlay", rect: expect.objectContaining({ x: 160, y: Number.parseFloat(top) + 60 }) } })));
});
