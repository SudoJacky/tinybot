import { describe, expect, it } from "vitest";
import {
  assistantFileArtifact,
  isAssistantFileHref,
  resolveAssistantFileLink,
} from "./assistantFileLinks";

describe("assistant file links", () => {
  it.each([
    ["photo.jpg", "image/jpeg"], ["photo.JPEG", "image/jpeg"], ["图表.PNG", "image/png"],
    ["motion.gif", "image/gif"], ["photo.webp", "image/webp"], ["photo.bmp", "image/bmp"],
    ["photo.avif", "image/avif"], ["icon.ico", "image/x-icon"],
  ])("recognizes %s as an image artifact", (title, mimeType) => {
    expect(assistantFileArtifact({ path: `images/${title}`, title })).toMatchObject({ kind: "image", mimeType });
  });

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

  it("resolves document links from their parent directory while keeping the workspace boundary", () => {
    const root = "C:/Users/viewer/.tinybot/workspace";
    expect(resolveAssistantFileLink("./github_agent_projects.pptx", root, "github-agent-report/report.md").path)
      .toBe("github-agent-report/github_agent_projects.pptx");
    expect(resolveAssistantFileLink("../data.csv#L12", root, "github-agent-report/report.md"))
      .toEqual({ path: "data.csv", title: "data.csv", line: 12 });
    expect(resolveAssistantFileLink("./nested/../Hello%20World.md", "", `${root}/github-agent-report/report.md`).path)
      .toBe(`${root}/github-agent-report/Hello World.md`);
    expect(resolveAssistantFileLink("./chart.png", root, "reports/100%20done#final/report.md").path)
      .toBe("reports/100%20done#final/chart.png");
    expect(resolveAssistantFileLink("C:/Users/viewer/.tinybot/workspace/data.csv", root, "github-agent-report/report.md").path)
      .toBe("data.csv");
    expect(() => resolveAssistantFileLink("../../secret.txt", root, "github-agent-report/report.md"))
      .toThrowError(expect.objectContaining({ code: "outside_workspace" }));
    expect(() => resolveAssistantFileLink("../../secret.txt", root, `${root}/github-agent-report/report.md`))
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
