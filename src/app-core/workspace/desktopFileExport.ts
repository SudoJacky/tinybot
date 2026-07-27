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

export function normalizeDesktopExportResult(result: unknown): string | null {
  if (!result) {
    return null;
  }
  const record = asRecord(result);
  return stringValue(record.path) || null;
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

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}
