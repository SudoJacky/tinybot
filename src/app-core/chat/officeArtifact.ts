export type OfficeArtifactKind = "document" | "presentation" | "spreadsheet";

export type OfficeArtifactSource = {
  bytes: Uint8Array;
  kind: OfficeArtifactKind;
  title: string;
};

export type SpreadsheetCellSelection = {
  address: string;
  sheet: string;
  value: string;
};

export type SpreadsheetCellChangeRequest = SpreadsheetCellSelection & {
  instruction: string;
};

const OFFICE_KIND_BY_EXTENSION: Record<string, OfficeArtifactKind> = {
  docx: "document",
  pptx: "presentation",
  xlsx: "spreadsheet",
};

const OFFICE_KIND_BY_MIME_TYPE: Record<string, OfficeArtifactKind> = {
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "presentation",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "spreadsheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "document",
};

export function resolveOfficeArtifactKind(input: {
  mimeType?: string;
  path?: string;
  title?: string;
}): OfficeArtifactKind | undefined {
  const mimeType = input.mimeType?.split(";", 1)[0].trim().toLowerCase() ?? "";
  const mimeKind = OFFICE_KIND_BY_MIME_TYPE[mimeType];
  const extensionKind = officeKindFromFileName(input.path) ?? officeKindFromFileName(input.title);
  if (mimeKind && extensionKind && mimeKind !== extensionKind) {
    throw new Error("Office artifact extension does not match its MIME type");
  }
  return mimeKind ?? extensionKind;
}

function officeKindFromFileName(value?: string): OfficeArtifactKind | undefined {
  const clean = value?.split(/[?#]/, 1)[0].trim().toLowerCase();
  if (!clean) return undefined;
  const extension = clean.match(/\.([a-z0-9]+)$/)?.[1];
  return extension ? OFFICE_KIND_BY_EXTENSION[extension] : undefined;
}
