import { describe, expect, it } from "vitest";
import {
  assistantFileArtifact,
  isAssistantFileHref,
  resolveAssistantFileLink,
} from "./assistantFileLinks";

describe("assistant file links", () => {
  it("recognizes workspace-relative, absolute, and file URL targets without treating web URLs as files", () => {
    expect(isAssistantFileHref("./docs/guide.md")).toBe(true);
    expect(isAssistantFileHref("D:/Code/tinybot/src/main.ts")).toBe(true);
    expect(isAssistantFileHref("file:///D:/Code/tinybot/src/main.ts")).toBe(true);
    expect(isAssistantFileHref("https://example.com/guide.md")).toBe(false);
    expect(isAssistantFileHref("javascript:alert(1)")).toBe(false);
  });

  it("resolves file URLs and workspace absolute paths to guarded relative paths", () => {
    expect(resolveAssistantFileLink(
      "file:///D:/Code/tinybot/docs/Hello%20World.md#L12",
      "D:\\Code\\tinybot",
    )).toEqual({ line: 12, path: "docs/Hello World.md", title: "Hello World.md" });

    expect(resolveAssistantFileLink(
      "D:/Code/tinybot/src/main.ts:27:4",
      "D:\\Code\\tinybot",
    )).toEqual({ line: 27, path: "src/main.ts", title: "main.ts" });

    expect(resolveAssistantFileLink("D:/Code/tinybot/src/main.ts:27"))
      .toEqual({ line: 27, path: "D:/Code/tinybot/src/main.ts", title: "main.ts" });
  });

  it("rejects traversal and absolute files outside the active workspace", () => {
    expect(() => resolveAssistantFileLink("../secret.txt", "D:\\Code\\tinybot"))
      .toThrowError(expect.objectContaining({ code: "outside_workspace" }));
    expect(() => resolveAssistantFileLink("C:/Users/private.txt", "D:\\Code\\tinybot"))
      .toThrowError(expect.objectContaining({ code: "outside_workspace" }));
  });

  it("projects a deterministic text artifact from the resolved file", () => {
    expect(assistantFileArtifact({ path: "docs/guide.md", title: "guide.md" })).toEqual({
      fetchPath: "docs/guide.md",
      id: "workspace-file:docs/guide.md",
      kind: "markdown",
      mimeType: "text/markdown",
      status: "completed",
      title: "guide.md",
    });
    expect(assistantFileArtifact({ path: "src/main.ts", title: "main.ts" }).mimeType).toBe("text/typescript");
  });
});
