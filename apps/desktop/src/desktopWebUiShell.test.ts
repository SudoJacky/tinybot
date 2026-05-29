import { describe, expect, test, vi } from "vitest";
import { installWebUiShell } from "./desktopWebUiShell";

class FakeScriptElement {}

class FakeLinkElement {
  constructor(
    public id: string,
    public href: string,
    private readonly attributes: Record<string, string>,
  ) {}

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  cloneNode(): FakeLinkElement {
    return new FakeLinkElement(this.id, this.href, { ...this.attributes });
  }
}

class FakeHead {
  public appended: FakeLinkElement[] = [];

  constructor(private readonly links: FakeLinkElement[] = []) {}

  querySelector(selector: string): FakeLinkElement | null {
    const match = selector.match(/^link\[href='(.+)'\]$/);
    if (!match) {
      return null;
    }
    return this.appended.find((link) => link.getAttribute("href") === match[1]) ?? null;
  }

  querySelectorAll(): FakeLinkElement[] {
    return this.links;
  }

  append(node: FakeLinkElement): void {
    this.appended.push(node);
  }
}

class FakeBody {
  public replaced: unknown[] = [];

  constructor(public childNodes: unknown[] = []) {}

  replaceChildren(...nodes: unknown[]): void {
    this.replaced = nodes;
  }
}

class FakeDocument {
  public documentElement = { lang: "", dataset: {} as Record<string, string> };
  public head: FakeHead;
  public body: FakeBody;

  constructor(options: { head?: FakeHead; body?: FakeBody } = {}) {
    this.head = options.head ?? new FakeHead();
    this.body = options.body ?? new FakeBody();
  }
}

describe("desktop WebUI shell installer", () => {
  test("installs root WebUI metadata, local head assets, and script-free body", () => {
    vi.stubGlobal("HTMLScriptElement", FakeScriptElement);
    const contentNode = { id: "app" };
    const trailingNode = { id: "modal-root" };
    const source = new FakeDocument({
      head: new FakeHead([
        new FakeLinkElement("", "/assets/styles/main.css", { href: "/assets/styles/main.css" }),
        new FakeLinkElement("hljs-light-theme", "https://cdn.example/github.css", {
          href: "https://cdn.example/github.css",
        }),
        new FakeLinkElement("", "/assets/logo-mark.svg", { href: "/assets/logo-mark.svg" }),
      ]),
      body: new FakeBody([new FakeScriptElement(), contentNode, trailingNode]),
    });
    source.documentElement.lang = "zh-CN";
    source.documentElement.dataset.theme = "light";
    const target = new FakeDocument();
    const parser = {
      parseFromString: vi.fn(() => source),
    };

    installWebUiShell("<html></html>", target as unknown as Document, parser as unknown as DOMParser);

    expect(parser.parseFromString).toHaveBeenCalledWith("<html></html>", "text/html");
    expect(target.documentElement.lang).toBe("zh-CN");
    expect(target.documentElement.dataset.theme).toBe("light");
    expect(target.head.appended.map((link) => link.getAttribute("href"))).toEqual([
      "/assets/styles/main.css",
      "/assets/logo-mark.svg",
    ]);
    expect(target.body.replaced).toEqual([contentNode, trailingNode]);
  });
});
