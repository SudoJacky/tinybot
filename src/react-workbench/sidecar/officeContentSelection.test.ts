// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { officeSelectionFromRange } from "./officeContentSelection";

afterEach(() => document.body.replaceChildren());
describe("Office preview selections", () => {
  it("captures cross-paragraph Word selections with positions and nearby context", () => {
    const root = document.createElement("div");
    root.innerHTML = "<p>Heading</p><p>First sentence</p><p>Second sentence</p><p>Following</p>";
    document.body.append(root);
    const paragraphs = root.querySelectorAll("p");
    const range = document.createRange();
    range.setStart(paragraphs[1].firstChild!, 6);
    range.setEnd(paragraphs[2].firstChild!, 6);
    expect(officeSelectionFromRange(root, "document", range)).toEqual({ kind: "document", start: 2, end: 3, text: range.toString(), context: "Heading\n\nFirst sentence\n\nSecond sentence\n\nFollowing" });
  });
  it("rejects selections crossing out of the owning preview", () => {
    const root = document.createElement("div");
    root.innerHTML = "<p>Inside</p>";
    const outside = document.createTextNode("Outside");
    document.body.append(root, outside);
    const range = document.createRange();
    range.setStart(root.firstChild!.firstChild!, 0);
    range.setEnd(outside, 3);
    expect(officeSelectionFromRange(root, "document", range)).toBeUndefined();
  });
  it("uses slide positions instead of text box order", () => {
    const root = document.createElement("div");
    root.innerHTML = '<div class="pptx-preview-wrapper"><div class="pptx-preview-slide-wrapper"><p>Opening</p></div><div class="pptx-preview-slide-wrapper"><p>Budget</p><p>Revenue</p></div></div>';
    document.body.append(root);
    const range = document.createRange();
    range.selectNodeContents(root.querySelectorAll("p")[2]);
    expect(officeSelectionFromRange(root, "presentation", range)).toMatchObject({ kind: "presentation", start: 2, end: 2, text: "Revenue" });
  });
});
