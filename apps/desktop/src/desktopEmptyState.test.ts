import { describe, expect, test } from "vitest";
import { upgradeDesktopRootWebUiEmptyState } from "./desktopEmptyState";

class FakeClassList {
  constructor(private readonly element: FakeElement) {}

  add(value: string): void {
    const values = new Set(this.element.className.split(/\s+/).filter(Boolean));
    values.add(value);
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

  insertBefore(node: FakeElement, child: FakeElement | null): void {
    node.parent = this;
    if (!child) {
      this.children.push(node);
      return;
    }
    const index = this.children.indexOf(child);
    if (index === -1) {
      this.children.push(node);
      return;
    }
    this.children.splice(index, 0, node);
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
  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName);
  }
}

function matchesSelector(element: FakeElement, selector: string): boolean {
  if (selector.startsWith(".")) {
    return element.className.split(/\s+/).includes(selector.slice(1));
  }
  return false;
}

function createEmptyChat(targetDocument: FakeDocument): FakeElement {
  const empty = targetDocument.createElement("div");
  empty.className = "empty-state empty-chat";
  const title = targetDocument.createElement("div");
  title.className = "empty-chat-title";
  title.textContent = "Current session has no messages.";
  const actions = targetDocument.createElement("div");
  actions.className = "empty-chat-actions";
  for (const label of [
    "Summarize my uploaded files",
    "Explain a concept",
    "Answer from the knowledge base",
    "Create a todo/reminder",
  ]) {
    const button = targetDocument.createElement("button");
    button.textContent = label;
    actions.append(button);
  }
  empty.append(title, actions);
  return empty;
}

describe("desktop empty state", () => {
  test("upgrades the root WebUI empty chat to compact workbench hints once", () => {
    const targetDocument = new FakeDocument();
    const empty = createEmptyChat(targetDocument);

    expect(upgradeDesktopRootWebUiEmptyState(empty as unknown as HTMLElement, targetDocument as unknown as Document)).toBe(true);
    expect(upgradeDesktopRootWebUiEmptyState(empty as unknown as HTMLElement, targetDocument as unknown as Document)).toBe(false);

    expect(empty.getAttribute("data-desktop-empty-state")).toBe("true");
    expect(empty.classList.contains("desktop-empty-state-compact")).toBe(true);
    expect(empty.querySelectorAll(".desktop-empty-hints")).toHaveLength(1);
    expect(empty.querySelectorAll(".desktop-empty-hint").map((node) => node.textContent)).toEqual([
      "Recent sessionsUse Search to resume a conversation.",
      "Files and resourcesAttach a session file or open Workspace.",
      "Background tasksCheck streaming, cowork, uploads, and approvals.",
      "Gateway healthUse the Gateway status for diagnostics.",
    ]);
    expect(empty.querySelectorAll(".desktop-empty-module")).toHaveLength(0);
  });

  test("keeps suggested prompts as lightweight command hints", () => {
    const targetDocument = new FakeDocument();
    const empty = createEmptyChat(targetDocument);

    upgradeDesktopRootWebUiEmptyState(empty as unknown as HTMLElement, targetDocument as unknown as Document);

    const actions = empty.querySelector(".empty-chat-actions");
    expect(actions?.classList.contains("desktop-empty-command-hints")).toBe(true);
    expect(actions?.getAttribute("data-desktop-empty-command-hints")).toBe("true");
    expect(actions?.textContent).toContain("Summarize my uploaded files");
    expect(actions?.textContent).toContain("Create a todo/reminder");
  });
});
