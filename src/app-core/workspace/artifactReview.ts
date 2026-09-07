export type ArtifactReview = {
  id: string;
  path: string;
  threadId: string;
  requestId: string;
  baseHash: string;
  createdAtMs: number;
  state: "pending" | "accepted" | "restored";
};

export type ArtifactReviewFile = { path: string; threadId: string };
export type ArtifactComparison = {
  review: ArtifactReview;
  before: Uint8Array;
  after: Uint8Array;
  currentHash: string;
  changed: boolean;
};

export type ArtifactReviewStore = {
  prepare(input: ArtifactReviewFile & { expectedRevision: string; requestId: string }): Promise<ArtifactReview>;
  load(input: ArtifactReviewFile): Promise<ArtifactReview | null>;
  compare(input: ArtifactReviewFile & { expectedRevision: string }): Promise<ArtifactComparison>;
  resolve(input: ArtifactReviewFile & { action: "accept" | "restore"; reviewId: string; expectedHash: string }): Promise<ArtifactReview>;
};

export type ArtifactReviewRequest = ArtifactReviewFile & (
  | { action: "prepare"; expectedRevision: string; requestId: string }
  | { action: "status" }
  | { action: "compare"; expectedRevision: string }
  | { action: "accept" | "restore"; reviewId: string; expectedHash: string }
);
