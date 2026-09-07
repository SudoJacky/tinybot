import type { ArtifactReview, ArtifactReviewRequest, ArtifactReviewStore } from "../../app-core/workspace/artifactReview";

export function createDesktopArtifactReviewStore(invoke: (request: ArtifactReviewRequest) => Promise<unknown>): ArtifactReviewStore {
  return {
    async prepare(input) { return review(await invoke({ ...input, action: "prepare" })); },
    async load(input) { const result = await invoke({ ...input, action: "status" }); return result === null ? null : review(result); },
    async compare(input) {
      const result = record(await invoke({ ...input, action: "compare" }));
      if (typeof result.changed !== "boolean") throw new Error("Invalid artifact comparison state");
      return {
        review: review(result.review), before: bytes(result.beforeBase64), after: bytes(result.afterBase64),
        currentHash: string(result.currentHash), changed: result.changed,
      };
    },
    async resolve(input) { return review(await invoke(input)); },
  };
}

function review(value: unknown): ArtifactReview {
  const result = record(value);
  const state = result.state;
  if (state !== "pending" && state !== "accepted" && state !== "restored") throw new Error("Invalid artifact review state");
  if (typeof result.createdAtMs !== "number" || !Number.isFinite(result.createdAtMs)) throw new Error("Invalid artifact review time");
  return { id: string(result.id), path: string(result.path), threadId: string(result.threadId), requestId: string(result.requestId), baseHash: string(result.baseHash), createdAtMs: result.createdAtMs, state };
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid artifact review response");
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("Missing artifact review identity or payload");
  return value;
}
function bytes(value: unknown): Uint8Array {
  if (typeof value !== "string") throw new Error("Invalid artifact snapshot bytes");
  const decoded = atob(value);
  const output = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index++) output[index] = decoded.charCodeAt(index);
  return output;
}
