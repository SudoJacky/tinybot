import { describe, expect, it, vi } from "vitest";
import type { AgentInputReference } from "../../app-core/chat/agentInputReference";
import type { ArtifactReviewStore } from "../../app-core/workspace/artifactReview";
import { prepareArtifactReviews } from "./prepareArtifactReviews";

const ref: AgentInputReference = { kind: "reference", referenceKind: "file", title: "Report", detail: "", sourcePath: "report.xlsx", scope: "thread", revision: "v1" };
describe("artifact baseline preparation", () => {
  it("deduplicates selected ranges and captures the viewed revision at dispatch", async () => {
    const prepare = vi.fn();
    expect(await prepareArtifactReviews([ref, ref], { prepare } as unknown as ArtifactReviewStore, "thread", "request")).toBe(true);
    expect(prepare).toHaveBeenCalledExactlyOnceWith({ path: "report.xlsx", threadId: "thread", expectedRevision: "v1", requestId: "request" });
  });
  it("does not capture ordinary uploads and rejects mixed versions or conversations", async () => {
    expect(await prepareArtifactReviews([{ ...ref, revision: undefined, rawPath: "upload.xlsx" }], undefined, "thread", "request")).toBe(false);
    await expect(prepareArtifactReviews([ref], undefined, "other", "request")).rejects.toThrow("another conversation");
    await expect(prepareArtifactReviews([ref, { ...ref, revision: "v2" }], undefined, "thread", "request")).rejects.toThrow("different versions");
  });
  it("propagates snapshot failures instead of allowing an unprotected edit", async () => {
    const prepare = vi.fn().mockRejectedValue(new Error("File changed since viewing"));
    await expect(prepareArtifactReviews([ref], { prepare } as unknown as ArtifactReviewStore, "thread", "request")).rejects.toThrow("File changed since viewing");
    await expect(prepareArtifactReviews([ref], undefined, "thread", "request")).rejects.toThrow("unavailable");
  });
});
