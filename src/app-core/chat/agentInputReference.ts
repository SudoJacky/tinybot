export type AgentInputReferenceKind = "browser" | "file" | "image" | "thread";

export type AgentInputReference = {
  contentHash?: string;
  kind: "browser" | "recent" | "reference";
  referenceKind?: AgentInputReferenceKind;
  title: string;
  detail: string;
  sourcePath?: string;
  sourceLine?: number;
  sourceEndLine?: number;
  sourceText?: string;
  rawPath?: string;
  rawLine?: number;
  mimeType?: string;
  sizeBytes?: number;
  noteId?: string;
  evidenceId?: string;
  scope?: string;
  revision?: string;
};

type AgentInputReferenceInput = Omit<AgentInputReference, "referenceKind"> & {
  referenceKind?: string;
};

const REFERENCE_KINDS = new Set<AgentInputReferenceKind>(["browser", "file", "image", "thread"]);

export function normalizeAgentInputReference(reference: AgentInputReferenceInput): AgentInputReference {
  const { referenceKind: candidate, ...rest } = reference;
  const referenceKind = explicitReferenceKind(candidate) ?? inferredReferenceKind(reference);
  return {
    ...rest,
    ...(referenceKind ? { referenceKind } : {}),
  };
}

export function agentInputAttachmentKind(reference: AgentInputReference): "file" | "image" | undefined {
  const kind = reference.referenceKind ?? inferredReferenceKind(reference);
  return kind === "file" || kind === "image" ? kind : undefined;
}

function explicitReferenceKind(value: unknown): AgentInputReferenceKind | undefined {
  return typeof value === "string" && REFERENCE_KINDS.has(value as AgentInputReferenceKind)
    ? value as AgentInputReferenceKind
    : undefined;
}

function inferredReferenceKind(reference: AgentInputReferenceInput): AgentInputReferenceKind | undefined {
  const mimeType = reference.mimeType?.trim().toLowerCase() ?? "";
  if (mimeType.startsWith("image/") || (reference.contentHash && reference.rawPath)) return "image";
  if (reference.rawPath) return "file";
  if (reference.scope && reference.sourceText !== undefined) return "thread";
  if (reference.kind === "browser") return "browser";
  return undefined;
}
