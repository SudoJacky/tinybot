import { describe, expect, test } from "vitest";
import {
  buildDesktopCoworkArtifactExport,
  buildDesktopCoworkFinalDraftExport,
  buildDesktopCoworkTraceExport,
  normalizeDesktopExportResult,
} from "./desktopFileExport";

describe("desktop file export adapter", () => {
  test("builds explicit destination payloads for Cowork final drafts and trace data", () => {
    const session = {
      id: "session/1",
      title: "Research plan",
      final_draft: "Final answer",
      trace: [
        { id: "span-1", action: "plan", status: "completed" },
        { id: "span-2", action: "write", status: "running" },
      ],
    };

    expect(buildDesktopCoworkFinalDraftExport(session)).toEqual({
      title: "Export Cowork final draft",
      defaultPath: "Research-plan-final-draft.md",
      contents: "Final answer",
      filters: [{ name: "Markdown", extensions: ["md", "markdown", "txt"] }],
    });
    expect(buildDesktopCoworkTraceExport(session)).toEqual({
      title: "Export Cowork trace data",
      defaultPath: "Research-plan-trace.json",
      contents: JSON.stringify(session.trace, null, 2),
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
  });

  test("builds artifact export payloads and normalizes destination results", () => {
    expect(buildDesktopCoworkArtifactExport({
      id: "artifact-1",
      title: "Draft notes",
      kind: "markdown",
      content: "# Notes",
    })).toEqual({
      title: "Export artifact",
      defaultPath: "Draft-notes.md",
      contents: "# Notes",
      filters: [{ name: "Markdown", extensions: ["md", "markdown", "txt"] }],
    });
    expect(normalizeDesktopExportResult({ path: "D:/exports/Draft-notes.md" })).toBe("D:/exports/Draft-notes.md");
    expect(normalizeDesktopExportResult(null)).toBe(null);
  });
});
