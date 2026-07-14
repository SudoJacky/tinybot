import type { TinyOsContextReference } from "./tinyOsUiState";

export const TINYOS_REFERENCE_MIME = "application/x-tinyos-reference+json";

export type TinyOsCrossAppReference =
  | { kind: "context"; reference: TinyOsContextReference }
  | { itemId: string; kind: "evidence"; title: string; turnId: string }
  | { kind: "resource"; resourceId: string; resourceKind: string; title: string };

export type TinyOsReferenceReadResult =
  | { reference: TinyOsCrossAppReference; status: "accepted" }
  | { reason: string; status: "rejected" };

type TinyOsTargetReadResult<TReference extends TinyOsCrossAppReference> =
  | { reference: TReference; status: "accepted" }
  | { reason: string; status: "rejected" };

type TinyOsReferenceEnvelope = {
  reference: TinyOsCrossAppReference;
  schemaVersion: "tinyos.reference.v1";
};

export function writeTinyOsReferenceTransfer(
  dataTransfer: Pick<DataTransfer, "effectAllowed" | "setData">,
  reference: TinyOsCrossAppReference,
): void {
  const envelope: TinyOsReferenceEnvelope = {
    reference,
    schemaVersion: "tinyos.reference.v1",
  };
  dataTransfer.effectAllowed = "copy";
  dataTransfer.setData(TINYOS_REFERENCE_MIME, JSON.stringify(envelope));
}

export function readTinyOsReferenceTransfer(
  dataTransfer: Pick<DataTransfer, "getData">,
): TinyOsReferenceReadResult {
  const raw = dataTransfer.getData(TINYOS_REFERENCE_MIME);
  if (!raw) return { reason: "The drag does not contain a TinyOS structured reference.", status: "rejected" };

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { reason: "The TinyOS reference payload is not valid JSON.", status: "rejected" };
  }
  if (!isRecord(value) || value.schemaVersion !== "tinyos.reference.v1" || !isCrossAppReference(value.reference)) {
    return { reason: "The TinyOS reference payload does not match tinyos.reference.v1.", status: "rejected" };
  }
  return { reference: value.reference, status: "accepted" };
}

export function tinyOsReferenceAcceptedBy(
  reference: TinyOsCrossAppReference,
  target: "chat",
): TinyOsTargetReadResult<Extract<TinyOsCrossAppReference, { kind: "context" }>>;
export function tinyOsReferenceAcceptedBy(
  reference: TinyOsCrossAppReference,
  target: "inspector",
): TinyOsTargetReadResult<Extract<TinyOsCrossAppReference, { kind: "evidence" }>>;
export function tinyOsReferenceAcceptedBy(
  reference: TinyOsCrossAppReference,
  target: "chat" | "inspector",
): TinyOsReferenceReadResult {
  if (target === "chat" && reference.kind === "context") return { reference, status: "accepted" };
  if (target === "inspector" && reference.kind === "evidence") return { reference, status: "accepted" };
  return {
    reason: target === "chat"
      ? `Chat accepts file and terminal context, not ${reference.kind} references.`
      : `Inspector accepts canonical evidence, not ${reference.kind} references.`,
    status: "rejected",
  };
}

function isCrossAppReference(value: unknown): value is TinyOsCrossAppReference {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "evidence") {
    return isNonEmptyString(value.itemId) && isNonEmptyString(value.title) && isNonEmptyString(value.turnId);
  }
  if (value.kind === "resource") {
    return isNonEmptyString(value.resourceId) && isNonEmptyString(value.resourceKind) && isNonEmptyString(value.title);
  }
  return value.kind === "context" && isContextReference(value.reference);
}

function isContextReference(value: unknown): value is TinyOsContextReference {
  if (!isRecord(value) || (value.kind !== "file" && value.kind !== "terminal")) return false;
  if (value.kind === "file") {
    return isNonEmptyString(value.path) && isRecord(value.provenance)
      && (value.provenance.kind === "canonical" || value.provenance.kind === "workspace_read");
  }
  return isNonEmptyString(value.command) && isNonEmptyString(value.sourceItemId) && isNonEmptyString(value.turnId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim());
}
