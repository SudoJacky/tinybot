import { describe, expect, it } from "vitest";
import { officeContentReference } from "./officeContentReference";

describe("Office content references", () => {
  it("carries the original revision, precise quote and change instruction to the file workflow", () => {
    const reference = officeContentReference({ path: "brief.docx", title: "Brief", threadId: "t1", revision: "v1", label: "Paragraph 2", request: { kind: "document", start: 2, end: 2, text: " repeated text ", context: "Specific section", instruction: "Make this clearer" } });
    expect(reference).toMatchObject({ referenceKind: "file", sourcePath: "brief.docx", revision: "v1", scope: "t1" });
    expect(reference.sourceText).toContain(" repeated text ");
    expect(reference.sourceText).toContain("Specific section");
    expect(reference.sourceText).toContain("Make this clearer");
    expect(reference.sourceText).toContain("do not replace every matching occurrence");
  });
  it("bounds quotations explicitly while retaining whole-slide identity for visual slides", () => {
    const reference = officeContentReference({ path: "deck.pptx", title: "Deck", threadId: "t1", revision: "v2", label: "Slide 3", request: { kind: "presentation", start: 3, end: 3, text: "", context: "x".repeat(13_000), wholeSlide: true, instruction: "Enlarge the image" } });
    expect(reference.sourceText).toContain("PowerPoint slides: 3");
    expect(reference.sourceText).toContain("entire slide");
    expect(reference.sourceText).toContain("Excerpt truncated");
  });
});
