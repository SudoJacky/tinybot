// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArtifactReview, ArtifactReviewStore } from "../../app-core/workspace/artifactReview";
import { ArtifactReviewPanel } from "./ArtifactReviewPanel";

afterEach(cleanup);
const review: ArtifactReview = { id: "review", path: "report.md", threadId: "thread", requestId: "request", baseHash: "before", createdAtMs: 1, state: "pending" };
function setup(responding = false) {
  const store: ArtifactReviewStore = {
    prepare: vi.fn(), load: vi.fn().mockResolvedValue(review),
    compare: vi.fn().mockResolvedValue({ review, before: new TextEncoder().encode("Old value"), after: new TextEncoder().encode("New value"), changed: true, currentHash: "current-hash" }),
    resolve: vi.fn().mockImplementation(async ({ action }) => ({ ...review, state: action === "restore" ? "restored" : "accepted" })),
  };
  const props = { store, responding, path: review.path, threadId: review.threadId, revision: "v2", epoch: 1, title: "Report", onRestored: vi.fn() };
  return { store, props, ...render(<ArtifactReviewPanel {...props} />) };
}
async function compare() {
  fireEvent.click(await screen.findByRole("button", { name: "Compare changes" }));
  await screen.findByText("Old value");
}
describe("artifact review workflow", () => {
  it("compares saved bytes and restores only the exact compared version", async () => {
    const { store, props } = setup();
    await compare();
    expect(screen.getByText("New value")).toBeTruthy();
    expect(store.compare).toHaveBeenCalledWith({ path: review.path, threadId: review.threadId, expectedRevision: "v2" });
    fireEvent.click(screen.getByRole("button", { name: "Restore before changes" }));
    await screen.findByText("Original file restored.");
    expect(store.resolve).toHaveBeenCalledWith({ path: review.path, threadId: review.threadId, action: "restore", reviewId: "review", expectedHash: "current-hash" });
    expect(props.onRestored).toHaveBeenCalledOnce();
  });
  it("keeps the current version without restoring the file", async () => {
    const { store, props } = setup();
    await compare();
    fireEvent.click(screen.getByRole("button", { name: "Keep current version" }));
    await screen.findByText("Current version kept.");
    expect(store.resolve).toHaveBeenCalledWith(expect.objectContaining({ action: "accept", expectedHash: "current-hash" }));
    expect(props.onRestored).not.toHaveBeenCalled();
  });
  it("disables writes during generation and invalidates comparison after a refresh", async () => {
    const { props, rerender } = setup(true);
    await compare();
    expect((screen.getByRole("button", { name: "Restore before changes" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Keep current version" }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<ArtifactReviewPanel {...props} responding={false} revision="v3" />);
    expect(screen.queryByRole("button", { name: "Restore before changes" })).toBeNull();
  });
  it("shows conflicts and requires a new comparison without claiming restoration", async () => {
    const { store, props } = setup();
    vi.mocked(store.resolve).mockRejectedValue(new Error("File changed after comparison"));
    await compare();
    fireEvent.click(screen.getByRole("button", { name: "Restore before changes" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("File changed after comparison"));
    expect(screen.queryByRole("button", { name: "Restore before changes" })).toBeNull();
    expect(props.onRestored).not.toHaveBeenCalled();
  });
});
