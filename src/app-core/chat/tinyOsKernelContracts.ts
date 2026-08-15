export type TinyOsProvenanceKind =
  | "canonical_event"
  | "native_query"
  | "real_capture"
  | "derived_measurement"
  | "local_presentation";

export type TinyOsProvenance = {
  kind: TinyOsProvenanceKind;
  observedAt?: string;
  revision?: number | string;
  sourceId: string;
};

export type TinyOsProcessState =
  | "queued"
  | "running"
  | "waiting_for_user"
  | "blocked"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export type TinyOsResourceAccess = "read_only" | "read_write" | "execute" | "unavailable";
