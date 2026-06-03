import { describe, expect, test } from "vitest";
import { DESKTOP_DESIGN_TOKENS_STYLE_ID, installDesktopDesignTokens } from "./desktopDesignTokens";

class FakeElement {
  public id = "";
  public textContent = "";
  public children: FakeElement[] = [];
  public attributes = new Map<string, string>();

  constructor(public readonly tagName: string) {}

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === "id") {
      this.id = value;
    }
  }

  append(...children: FakeElement[]): void {
    this.children.push(...children);
  }

  querySelector(selector: string): FakeElement | null {
    if (selector.startsWith("#") && this.id === selector.slice(1)) {
      return this;
    }
    for (const child of this.children) {
      const match = child.querySelector(selector);
      if (match) {
        return match;
      }
    }
    return null;
  }
}

class FakeDocument {
  public head = new FakeElement("head");

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName);
  }

  getElementById(id: string): FakeElement | null {
    return this.head.querySelector(`#${id}`);
  }
}

describe("desktop design tokens", () => {
  test("installs root WebUI design tokens with native compatibility aliases once", () => {
    const targetDocument = new FakeDocument();

    installDesktopDesignTokens(targetDocument as unknown as Document);
    installDesktopDesignTokens(targetDocument as unknown as Document);

    expect(targetDocument.head.children).toHaveLength(1);
    const style = targetDocument.getElementById(DESKTOP_DESIGN_TOKENS_STYLE_ID);
    expect(style?.textContent).toContain("--bg: #faf9f5;");
    expect(style?.textContent).toContain("--panel-strong: #faf9f5;");
    expect(style?.textContent).toContain("--accent-hover: #a9583e;");
    expect(style?.textContent).toContain("--primary: var(--accent);");
    expect(style?.textContent).toContain("--muted: var(--text-muted);");
    expect(style?.textContent).toContain("--focus-ring: var(--accent-glow);");
    expect(style?.textContent).toContain('[data-theme="dark"]');
  });
});
