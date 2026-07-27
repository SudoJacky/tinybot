import { describe, expect, test } from "vitest";
import {
  buildDesktopWorkspaceContentExport,
  normalizeDesktopExportResult,
} from "./desktopFileExport";

describe("desktop file export adapter", () => {
  test("builds explicit destination payloads for workspace files", () => {
    expect(buildDesktopWorkspaceContentExport({
      path: "notes/Research plan.md",
      contents: "# Notes",
    })).toEqual({
      title: "Export workspace content",
      defaultPath: "Research-plan.md",
      contents: "# Notes",
      filters: [{ name: "Markdown", extensions: ["md", "markdown", "txt"] }],
    });
  });

  test("normalizes destination results", () => {
    expect(normalizeDesktopExportResult({ path: "D:/exports/Draft-notes.md" })).toBe("D:/exports/Draft-notes.md");
    expect(normalizeDesktopExportResult(null)).toBe(null);
  });
});
