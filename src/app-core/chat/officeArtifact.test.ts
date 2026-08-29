import { describe, expect, it } from "vitest";
import { resolveOfficeArtifactKind } from "./officeArtifact";

describe("office artifact detection", () => {
  it.each([
    ["report.xlsx", "spreadsheet"],
    ["proposal.DOCX", "document"],
    ["deck.pptx", "presentation"],
  ] as const)("detects %s by modern Office extension", (path, expected) => {
    expect(resolveOfficeArtifactKind({ path })).toBe(expected);
  });

  it("detects an Office artifact by MIME type when the path has no extension", () => {
    expect(resolveOfficeArtifactKind({
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      path: "artifact",
    })).toBe("presentation");
  });

  it.each(["report.xls", "proposal.doc", "deck.ppt", "macro.xlsm"])(
    "does not accept unsupported legacy or macro format %s",
    (path) => {
      expect(resolveOfficeArtifactKind({ path })).toBeUndefined();
    },
  );

  it("fails when the extension and MIME type disagree", () => {
    expect(() => resolveOfficeArtifactKind({
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      path: "deck.pptx",
    })).toThrow("does not match");
  });
});
