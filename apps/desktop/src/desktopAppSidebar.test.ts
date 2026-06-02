import { describe, expect, test } from "vitest";
import { renderDesktopAppSidebar } from "./desktopAppSidebar";
import {
  buildRootWebUiSidebarModel,
  buildRootWebUiWorkspaceContext,
  type DesktopSidebarItem,
} from "./desktopSharedModels";

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

  replaceChildren(...children: FakeElement[]): void {
    for (const child of children) {
      child.parent = this;
    }
    this.children = [...children];
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

  querySelectorAll(selector: string): FakeElement[] {
    const matches: FakeElement[] = matchesSelector(this, selector) ? [this] : [];
    for (const child of this.children) {
      matches.push(...child.querySelectorAll(selector));
    }
    return matches;
  }
}

class FakeDocument {
  public body = new FakeElement("body");

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName);
  }
}

function matchesSelector(element: FakeElement, selector: string): boolean {
  const attributeMatch = selector.match(/^\[([^=\]]+)="([^"]+)"\]$/);
  if (attributeMatch) {
    return element.getAttribute(attributeMatch[1]) === attributeMatch[2];
  }
  if (selector.startsWith(".")) {
    return element.className.split(/\s+/).includes(selector.slice(1));
  }
  return false;
}

function sidebarItems(): DesktopSidebarItem[] {
  return [
    {
      id: "session:active",
      kind: "session",
      label: "Desktop shell planning",
      meta: "2 min",
      active: true,
    },
    {
      id: "session:older",
      kind: "session",
      label: "Gateway follow-up",
      meta: "1 day",
    },
  ];
}

describe("desktop app sidebar", () => {
  test("renders action, workspace, and footer groups from the shared sidebar model", () => {
    const targetDocument = new FakeDocument();
    const host = targetDocument.createElement("aside");
    host.className = "sidebar";
    const model = buildRootWebUiSidebarModel({
      workspace: buildRootWebUiWorkspaceContext({
        workspaceLabel: "tinybot",
        activeSession: { id: "active", title: "Desktop shell planning", meta: "2 min" },
      }),
      sessions: sidebarItems(),
    });

    renderDesktopAppSidebar(host as unknown as HTMLElement, model, targetDocument as unknown as Document);

    expect(host.getAttribute("data-desktop-app-sidebar")).toBe("true");
    expect(host.classList.contains("desktop-app-sidebar")).toBe(true);
    expect(host.classList.contains("desktop-app-sidebar-card")).toBe(false);
    expect(host.querySelectorAll(".desktop-app-sidebar-group").map((node) => node.getAttribute("data-sidebar-group"))).toEqual([
      "actions",
      "workspace",
      "footer",
    ]);
    expect(host.querySelector('[data-sidebar-group="workspace"]')?.textContent).toContain("tinybot");
    expect(host.querySelectorAll(".desktop-app-sidebar-item").map((node) => node.getAttribute("data-sidebar-item-kind"))).toContain("command");
    expect(host.querySelectorAll(".desktop-app-sidebar-item").map((node) => node.getAttribute("data-sidebar-item-kind"))).toContain("link");
    expect(host.querySelectorAll(".desktop-app-sidebar-item").map((node) => node.getAttribute("data-sidebar-item-kind"))).toContain("session");
  });

  test("keeps command, link, and selected session metadata on sidebar items", () => {
    const targetDocument = new FakeDocument();
    const host = targetDocument.createElement("aside");
    const model = buildRootWebUiSidebarModel({ sessions: sidebarItems() });

    renderDesktopAppSidebar(host as unknown as HTMLElement, model, targetDocument as unknown as Document);

    const newChat = host.querySelector('[data-sidebar-command="new-chat"]');
    const tools = host.querySelector('[data-sidebar-href="/tools"]');
    const activeSession = host.querySelector('[data-sidebar-item-id="session:active"]');

    expect(newChat?.getAttribute("type")).toBe("button");
    expect(newChat?.getAttribute("data-sidebar-item-kind")).toBe("command");
    expect(newChat?.textContent).toContain("New");
    expect(tools?.getAttribute("href")).toBe("/tools");
    expect(tools?.getAttribute("data-sidebar-item-kind")).toBe("link");
    expect(activeSession?.getAttribute("aria-current")).toBe("page");
    expect(activeSession?.getAttribute("data-active")).toBe("true");
    expect(activeSession?.textContent).toContain("Desktop shell planning");
    expect(activeSession?.textContent).toContain("2 min");
  });
});
