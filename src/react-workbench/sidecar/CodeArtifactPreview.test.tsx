// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodeArtifactPreview } from "./CodeArtifactPreview";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.head.querySelectorAll('[data-test-style="code-preview"]').forEach((style) => style.remove());
  document.documentElement.removeAttribute("data-theme");
});

function renderedSource(container: HTMLElement): string {
  const lines = Array.from(container.querySelectorAll("pre code > span"));
  return lines.map((line) => line.textContent === "\n" ? "" : line.textContent).join("\n");
}

describe("code artifact preview", () => {
  it.each(["light", "dark"])("highlights with the %s theme and preserves indentation", async (theme) => {
    document.documentElement.dataset.theme = theme;
    const style = document.createElement("style");
    style.dataset.testStyle = "code-preview";
    style.textContent = readFileSync("src/react-workbench/chat/ChatPage.css", "utf8");
    document.head.append(style);
    const text = "def hello(name):\n    return 'Hello ' + name";
    const { container } = render(<CodeArtifactPreview text={text} language="python" />);
    await waitFor(() => expect(container.querySelector('pre span[style*="--sdm-c"]')).not.toBeNull());
    expect(renderedSource(container)).toBe(text);
    const token = container.querySelector<HTMLElement>('pre span[style*="--sdm-c"]')!;
    expect(getComputedStyle(token).color).toBe(token.style.getPropertyValue(theme === "dark" ? "--shiki-dark" : "--sdm-c"));
    fireEvent.click(screen.getByRole("button", { name: "Wrap code lines" }));
    expect(container.querySelector(".react-markdown-code")?.getAttribute("data-wrap")).toBe("true");
    expect(renderedSource(container)).toBe(text);
  });

  it("keeps embedded fences, HTML and Markdown literal and copies the original source", async () => {
    const text = 'const example = `\n```\n````\n<img src=x onerror="alert(1)">\n[link](https://example.com)\n`;\n';
    const copy = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: copy } });
    const { container } = render(<CodeArtifactPreview text={text} language="javascript" />);
    await waitFor(() => expect(container.querySelector('pre span[style*="--sdm-c"]')).not.toBeNull());
    expect(container.querySelectorAll("pre")).toHaveLength(1);
    expect(container.querySelector("img, a")).toBeNull();
    // The shared code block omits trailing blank lines from its visual layout.
    expect(renderedSource(container)).toBe(text.trimEnd());
    fireEvent.click(container.querySelector<HTMLButtonElement>('[data-streamdown="code-block-copy-button"]')!);
    await waitFor(() => expect(copy).toHaveBeenCalledWith(text));
  });

  it("updates highlighted code when the file content changes", async () => {
    const { container, rerender } = render(<CodeArtifactPreview text="const first = 1;" language="typescript" />);
    await waitFor(() => expect(renderedSource(container)).toBe("const first = 1;"));
    rerender(<CodeArtifactPreview text="const second = 2;" language="typescript" />);
    await waitFor(() => expect(renderedSource(container)).toBe("const second = 2;"));
  });

  it.each(["const value = 1;", "const value = 1;\r\n\r\n"])("copies exact file line endings: %j", async (text) => {
    const copy = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: copy } });
    const { container } = render(<CodeArtifactPreview text={text} language="typescript" />);
    fireEvent.click(container.querySelector<HTMLButtonElement>('[data-streamdown="code-block-copy-button"]')!);
    await waitFor(() => expect(copy).toHaveBeenCalledWith(text));
  });
});
