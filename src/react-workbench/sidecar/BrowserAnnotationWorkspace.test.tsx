// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
  vi.mocked(importDesktopChatFiles).mockReset().mockResolvedValue([{ contentHash: "hash", path: "C:/attachments/annotation.png", name: "annotation.png", mimeType: "image/png", sizeBytes: 3 }]);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

function setup() {
  const order: string[] = [];
  let state = structuredClone(evidence);
  const annotate = vi.fn<NativeBrowserRuntimeApi["annotate"]>(async ({ action }) => {
    order.push(action.type);
    if (action.type === "stop") return { active: false };
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
  expect(annotationImageFile).toHaveBeenLastCalledWith(expect.any(String), evidence.viewport, { x: 8, y: 8, width: 104, height: 64 }, []);
  expect(reference[0].sourceText).not.toContain('"styles"');
  expect(reference[0].sourceText).not.toContain('"ancestors"');
  expect(view.order.indexOf("preview")).toBeLessThan(view.order.indexOf("capture"));
  expect(view.order.indexOf("stop")).toBeLessThan(view.order.indexOf("attached"));
  expect(view.onClose).toHaveBeenCalledOnce();
});

it("preserves the draft and reports import failure without attaching or ending the annotation", async () => {
  vi.mocked(importDesktopChatFiles).mockRejectedValueOnce(new Error("Attachment storage unavailable"));
  const user = userEvent.setup();
  const view = setup();
  await screen.findByLabelText("Text color");
  await user.type(screen.getByLabelText("Requested change"), "Keep this draft");
  await user.click(screen.getByRole("button", { name: "Add to composer" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Attachment storage unavailable");
  expect((screen.getByLabelText("Requested change") as HTMLTextAreaElement).value).toBe("Keep this draft");
  expect(view.onReference).not.toHaveBeenCalled();
  expect(view.onClose).not.toHaveBeenCalled();
});

it("restores the native page when its workspace unmounts", async () => {
  const view = setup();
  await screen.findByLabelText("Text color");
  view.unmount();
  await waitFor(() => expect(view.annotate).toHaveBeenCalledWith(expect.objectContaining({ action: { type: "stop" } })));
});

it("does not attach a late import or stop a newly opened annotation session", async () => {
  let finishImport!: (value: Awaited<ReturnType<typeof importDesktopChatFiles>>) => void;
  vi.mocked(importDesktopChatFiles).mockImplementationOnce(() => new Promise((resolve) => { finishImport = resolve; }));
  const user = userEvent.setup();
  const view = setup();
  await screen.findByLabelText("Text color");
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
