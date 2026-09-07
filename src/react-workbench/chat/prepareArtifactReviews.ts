import type { AgentInputReference } from "../../app-core/chat/agentInputReference";
import type { ArtifactReviewStore } from "../../app-core/workspace/artifactReview";

// Capture at dispatch time, including queued requests. Uploaded attachments do
// not carry a viewed revision and are not editable local artifact references.
export async function prepareArtifactReviews(
  references: readonly AgentInputReference[] | undefined,
  store: ArtifactReviewStore | undefined,
  threadId: string,
  requestId: string,
): Promise<boolean> {
  const files = new Map<string, string>();
  for (const ref of references ?? []) {
    if (ref.referenceKind !== "file" || !ref.sourcePath || !ref.revision) continue;
    if (ref.scope && ref.scope !== threadId) throw new Error("Artifact belongs to another conversation; reference it again.");
    const revision = files.get(ref.sourcePath);
    if (revision && revision !== ref.revision) throw new Error("File references contain different versions; reference the current file again.");
    files.set(ref.sourcePath, ref.revision);
  }
  if (!files.size) return false;
  if (!store) throw new Error("Saving the original artifact is unavailable in this runtime.");
  for (const [path, expectedRevision] of files) {
    await store.prepare({ path, expectedRevision, threadId, requestId });
  }
  return true;
}
