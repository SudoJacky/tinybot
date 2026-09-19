// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ResultFilePreview, useResultFilePreview, type PreviewWorkspaceStore } from "./ResultFilePreview";
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function Harness({ store }: { store: PreviewWorkspaceStore }) {
  const preview = useResultFilePreview("D:/project");
  return <><button onClick={() => preview.open({ href: "chart.png" })}>Open result</button><ResultFilePreview preview={preview} threadId="producer" workspaceStore={store} /></>;
}
it("previews binary results in place with revision-bound bytes and releases the image on close", async () => {
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:chart");
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const store = {
    readThreadFile: vi.fn().mockResolvedValue({ path: "chart.png", contentType: "binary", revision: "r1", sizeBytes: 4 }),
    readThreadFileBytes: vi.fn().mockResolvedValue(new Uint8Array([137, 80, 78, 71])),
  };
  render(<Harness store={store} />);
  expect(store.readThreadFile).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Open result" }));
  expect(await screen.findByRole("img", { name: "chart.png" })).toBeTruthy();
  expect(store.readThreadFileBytes).toHaveBeenCalledWith({ path: "chart.png", threadId: "producer", expectedRevision: "r1" });
  fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
  expect(revoke).toHaveBeenCalledWith("blob:chart");
});
it("exposes read failures in the result surface", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const store = { readThreadFile: vi.fn().mockRejectedValue(new Error("Result missing")) };
  render(<Harness store={store} />);
  fireEvent.click(screen.getByRole("button", { name: "Open result" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Result missing"));
});
