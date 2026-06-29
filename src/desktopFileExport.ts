export interface DesktopFileExportFilter {
  name: string;
  extensions: string[];
}

export interface DesktopFileExportRequest {
  title: string;
  defaultPath: string;
  contents: string;
  filters: DesktopFileExportFilter[];
}

export function buildDesktopWorkspaceContentExport(input: { path: string; contents: string }): DesktopFileExportRequest {
  const name = fileNameFromPath(input.path) || "workspace-export.txt";
  return {
    title: "Export workspace content",
    defaultPath: sanitizeFileName(name),
    contents: input.contents,
    filters: filtersForName(name),
  };
}

export function buildDesktopCoworkFinalDraftExport(session: unknown): DesktopFileExportRequest {
  const record = asRecord(session);
  const title = stringValue(record.title) || stringValue(record.goal) || stringValue(record.id) || "cowork-session";
  const finalResult = asRecord(record.session_final_result);
  const decision = asRecord(record.completion_decision);
  return {
    title: "Export Cowork final draft",
    defaultPath: `${sanitizeBaseName(title)}-final-draft.md`,
    contents: stringValue(record.final_draft) || stringValue(finalResult.summary) || stringValue(decision.final_output) || stringValue(decision.final_answer),
    filters: markdownFilters(),
  };
}

export function buildDesktopCoworkTraceExport(session: unknown): DesktopFileExportRequest {
  const record = asRecord(session);
  const title = stringValue(record.title) || stringValue(record.goal) || stringValue(record.id) || "cowork-session";
  const trace = arrayValue(record.trace).length ? record.trace : record.trace_spans;
  return {
    title: "Export Cowork trace data",
    defaultPath: `${sanitizeBaseName(title)}-trace.json`,
    contents: JSON.stringify(trace ?? [], null, 2),
    filters: jsonFilters(),
  };
}

export function buildDesktopCoworkArtifactExport(artifact: unknown): DesktopFileExportRequest {
  const record = asRecord(artifact);
  const title = stringValue(record.title) || stringValue(record.summary) || stringValue(record.id) || "artifact";
  const kind = stringValue(record.kind).toLowerCase();
  const extension = kind.includes("markdown") || kind === "md" ? "md" : kind.includes("json") ? "json" : "txt";
  return {
    title: "Export artifact",
    defaultPath: `${sanitizeBaseName(title)}.${extension}`,
    contents: exportableArtifactContents(record),
    filters: extension === "json" ? jsonFilters() : extension === "md" ? markdownFilters() : textFilters(),
  };
}

export function normalizeDesktopExportResult(result: unknown): string | null {
  if (!result) {
    return null;
  }
  const record = asRecord(result);
  return stringValue(record.path) || null;
}

function exportableArtifactContents(record: Record<string, unknown>): string {
  const direct = stringValue(record.content) || stringValue(record.value) || stringValue(record.text) || stringValue(record.body);
  if (direct) {
    return direct;
  }
  return JSON.stringify(record, null, 2);
}

function filtersForName(name: string): DesktopFileExportFilter[] {
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  if (extension === "json") {
    return jsonFilters();
  }
  if (extension === "md" || extension === "markdown") {
    return markdownFilters();
  }
  return textFilters();
}

function markdownFilters(): DesktopFileExportFilter[] {
  return [{ name: "Markdown", extensions: ["md", "markdown", "txt"] }];
}

function jsonFilters(): DesktopFileExportFilter[] {
  return [{ name: "JSON", extensions: ["json"] }];
}

function textFilters(): DesktopFileExportFilter[] {
  return [{ name: "Text", extensions: ["txt", "md", "json"] }];
}

function fileNameFromPath(path = ""): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? "";
}

function sanitizeFileName(value: string): string {
  const fallback = "export.txt";
  const cleaned = value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return cleaned || fallback;
}

function sanitizeBaseName(value: string): string {
  return sanitizeFileName(value).replace(/\.[^.]+$/, "") || "export";
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}
