import { describe, expect, it, vi } from "vitest";
import { createDesktopArtifactReviewStore } from "./desktopArtifactReviewStore";

const saved = { id: "review", path: "report.xlsx", threadId: "thread", requestId: "request", baseHash: "hash", createdAtMs: 1, state: "pending" };
describe("desktop artifact review transport", () => {
  it("decodes snapshots losslessly and forwards the exact comparison hash for restoration", async () => {
    const invoke = vi.fn().mockResolvedValueOnce({ review: saved, beforeBase64: "AAH/", afterBase64: "", changed: true, currentHash: "current" }).mockResolvedValueOnce({ ...saved, state: "restored" });
    const store = createDesktopArtifactReviewStore(invoke);
    const comparison = await store.compare({ path: saved.path, threadId: saved.threadId, expectedRevision: "v2" });
    expect(comparison.before).toEqual(new Uint8Array([0, 1, 255]));
    expect(comparison.after).toEqual(new Uint8Array());
    await store.resolve({ path: saved.path, threadId: saved.threadId, reviewId: saved.id, action: "restore", expectedHash: comparison.currentHash });
    expect(invoke).toHaveBeenLastCalledWith({ path: saved.path, threadId: saved.threadId, reviewId: saved.id, action: "restore", expectedHash: "current" });
  });
  it("distinguishes an absent review from an invalid native response", async () => {
    const invoke = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ ...saved, state: "invalid" }).mockRejectedValueOnce(new Error("Snapshot missing"));
    const store = createDesktopArtifactReviewStore(invoke);
    await expect(store.load({ path: saved.path, threadId: saved.threadId })).resolves.toBeNull();
    await expect(store.load({ path: saved.path, threadId: saved.threadId })).rejects.toThrow("Invalid artifact review state");
    await expect(store.prepare({ path: saved.path, threadId: saved.threadId, expectedRevision: "v1", requestId: "request" })).rejects.toThrow("Snapshot missing");
  });
});
