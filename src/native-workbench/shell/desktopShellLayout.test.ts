import { describe, expect, test } from "vitest";
import { applyRootWebUiShellLayout, ensureDesktopRootWebUiShellLayoutStyle } from "./desktopShellLayout";

class FakeClassList {
  constructor(private readonly element: FakeElement) {}

  add(value: string): void {
    const values = new Set(this.element.className.split(/\s+/).filter(Boolean));
    values.add(value);
    this.element.className = [...values].join(" ");
  }

  remove(value: string): void {
    const values = new Set(this.element.className.split(/\s+/).filter(Boolean));
    values.delete(value);
    this.element.className = [...values].join(" ");
  }

  contains(value: string): boolean {
    return this.element.className.split(/\s+/).includes(value);
  }
}

class FakeElement {
  public id = "";
  public className = "";
  public children: FakeElement[] = [];
  public attributes = new Map<string, string>();
  public classList = new FakeClassList(this);
  public parent: FakeElement | null = null;
  private ownTextContent = "";
  public style = {
    values: new Map<string, string>(),
    setProperty: (name: string, value: string) => {
      this.style.values.set(name, value);
    },
  };

  constructor(public readonly tagName: string) {}

  set textContent(value: string) {
    this.ownTextContent = value;
  }

  get textContent(): string {
    return `${this.ownTextContent}${this.children.map((child) => child.textContent).join("")}`;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === "id") {
      this.id = value;
    }
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  append(...children: FakeElement[]): void {
    for (const child of children) {
      child.parent = this;
    }
    this.children.push(...children);
  }

  querySelector(selector: string): FakeElement | null {
    if (matchesSelector(this, selector)) {
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
  public body = new FakeElement("body");
  public head = new FakeElement("head");

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName);
  }

  getElementById(id: string): FakeElement | null {
    return this.body.querySelector(`#${id}`) ?? this.head.querySelector(`#${id}`);
  }
}

function matchesSelector(element: FakeElement, selector: string): boolean {
  if (selector.includes(" ")) {
    const parts = selector.split(/\s+/);
    const last = parts[parts.length - 1];
    if (!last || !matchesSelector(element, last)) {
      return false;
    }
    let parent = element.parent;
    for (let index = parts.length - 2; index >= 0; index -= 1) {
      while (parent && !matchesSelector(parent, parts[index])) {
        parent = parent.parent;
      }
      if (!parent) {
        return false;
      }
      parent = parent.parent;
    }
    return true;
  }
  if (selector.startsWith("#")) {
    return element.id === selector.slice(1) || element.getAttribute("id") === selector.slice(1);
  }
  if (selector.startsWith(".")) {
    return element.className.split(/\s+/).includes(selector.slice(1));
  }
  return false;
}

function createRootWebUiDocument(): FakeDocument {
  const document = new FakeDocument();
  const shell = document.createElement("div");
  shell.className = "shell inspection-mode";

  const sidebar = document.createElement("aside");
  sidebar.className = "sidebar";
  const brand = document.createElement("div");
  brand.className = "brand";
  brand.textContent = "TinybotMINIMAL WEB UI";
  sidebar.append(brand);

  const chat = document.createElement("section");
  chat.className = "chat-panel";
  const header = document.createElement("header");
  header.className = "chat-header";
  const messageList = document.createElement("section");
  messageList.setAttribute("id", "message-list");
  const composer = document.createElement("form");
  composer.setAttribute("id", "composer-form");
  const status = document.createElement("section");
  status.className = "composer-status-panel";
  composer.append(status);
  chat.append(header, messageList, composer);

  const inspector = document.createElement("aside");
  inspector.setAttribute("id", "inspector-panel");

  shell.append(sidebar, chat, inspector);
  document.body.append(shell);
  return document;
}

describe("desktop shell layout", () => {
  test("adds stable desktop region hooks to the hosted root WebUI shell", () => {
    const targetDocument = createRootWebUiDocument();

    applyRootWebUiShellLayout(targetDocument as unknown as Document, {
      sidebar: { visible: true, size: 260 },
      inspector: { visible: true, size: 360 },
      bottom: { visible: false, size: 220 },
    });

    expect(targetDocument.body.classList.contains("desktop-root-webui-workbench")).toBe(true);
    expect(targetDocument.body.querySelector(".sidebar")?.getAttribute("data-workbench-region")).toBe("sidebar");
    expect(targetDocument.body.querySelector(".sidebar")?.getAttribute("data-desktop-shell-region")).toBe("sidebar");
    expect(targetDocument.body.querySelector(".chat-panel")?.getAttribute("data-workbench-region")).toBe("main");
    expect(targetDocument.body.querySelector(".chat-panel")?.getAttribute("data-desktop-shell-region")).toBe("workspace");
    expect(targetDocument.body.querySelector(".chat-header")?.classList.contains("desktop-workspace-header")).toBe(true);
    expect(targetDocument.body.querySelector(".chat-header")?.getAttribute("data-desktop-shell-region")).toBe("workspace-header");
    expect(targetDocument.getElementById("message-list")?.getAttribute("data-desktop-shell-region")).toBe("message-list");
    expect(targetDocument.getElementById("inspector-panel")?.getAttribute("data-desktop-shell-region")).toBe("inspector");
    expect(targetDocument.getElementById("composer-form")?.getAttribute("data-desktop-shell-region")).toBe("composer");
    expect(targetDocument.body.querySelector(".composer-status-panel")?.getAttribute("data-desktop-shell-region")).toBe("runtime-status");
  });

  test("scopes shell layout CSS and removes the repeated content brand affordance", () => {
    const targetDocument = new FakeDocument();

    ensureDesktopRootWebUiShellLayoutStyle(targetDocument as unknown as Document);

    const styleText = targetDocument.head.querySelector("#desktop-root-webui-workbench-style")?.textContent ?? "";
    expect(styleText).toContain("body.desktop-root-webui-workbench > .shell");
    expect(styleText).toContain("body.desktop-root-webui-workbench > .shell {");
    expect(styleText).toContain("border: 0;");
    expect(styleText).toContain("border-radius: 0;");
    expect(styleText).toContain("body.desktop-root-webui-workbench > .shell .sidebar");
    expect(styleText).toContain("body.desktop-root-webui-workbench > .shell .chat-panel");
    expect(styleText).toContain("body.desktop-root-webui-workbench > .shell .chat-panel {");
    expect(styleText).toContain("border: 1px solid var(--border, #e6dfd8);");
    expect(styleText).toContain("border-radius: 12px;");
    expect(styleText).toContain("body.desktop-root-webui-workbench [data-desktop-shell-region=\"workspace\"]");
    expect(styleText).toContain("order: 0");
    expect(styleText).toContain("grid-column: 1");
    expect(styleText).toContain("grid-column: 2");
    expect(styleText).toContain("body.desktop-root-webui-workbench .sidebar .brand");
    expect(styleText).toContain("display: none");
    expect(styleText).toContain("body.desktop-root-webui-workbench .desktop-app-sidebar");
    expect(styleText).toContain("body.desktop-root-webui-workbench .desktop-app-sidebar-group");
    expect(styleText).toContain("body.desktop-root-webui-workbench .desktop-empty-state-compact");
    expect(styleText).toContain("body.desktop-root-webui-workbench .desktop-empty-hints");
    expect(styleText).toContain("body.desktop-root-webui-workbench .desktop-empty-command-hints");
    expect(styleText).toContain("body.desktop-root-webui-workbench .desktop-workspace-header");
    expect(styleText).not.toContain(".desktop-empty-module");
  });

  test("declares desktop-owned responsive placement across shell breakpoints", () => {
    const targetDocument = new FakeDocument();

    ensureDesktopRootWebUiShellLayoutStyle(targetDocument as unknown as Document);

    const styleText = targetDocument.head.querySelector("#desktop-root-webui-workbench-style")?.textContent ?? "";
    expect(styleText).toContain("@media (min-width: 1181px)");
    expect(styleText).toContain("@media (max-width: 1180px) and (min-width: 981px)");
    expect(styleText).toContain("@media (max-width: 980px) and (min-width: 721px)");
    expect(styleText).toContain("@media (max-width: 720px)");
    expect(styleText).toContain("--desktop-sidebar-rail-size");
    expect(styleText).toContain("body.desktop-root-webui-workbench > .shell .sidebar");
    expect(styleText).toContain("order: 0 !important");
    expect(styleText).toContain("grid-column: 1 !important");
    expect(styleText).toContain("body.desktop-root-webui-workbench > .shell .chat-panel");
    expect(styleText).toContain("grid-column: 2 !important");
    expect(styleText).toContain("grid-template-columns: minmax(220px, var(--desktop-sidebar-size, 248px)) minmax(0, 1fr) 0");
    expect(styleText).toContain("grid-template-columns: var(--desktop-sidebar-rail-size, 68px) minmax(0, 1fr) 0");
    expect(styleText).toContain("grid-template-columns: 56px minmax(0, 1fr) 0");
    expect(styleText).toContain(".desktop-app-sidebar-item-label");
    expect(styleText).toContain(".desktop-app-sidebar-item-meta");
  });
});
