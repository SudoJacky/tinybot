import { describe, expect, test } from "vitest";
import { ensureDesktopComposerSurfaceStyle, installRootWebUiComposerRuntime } from "./desktopComposerSurface";

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
  private ownTextContent = "";
  public classList = new FakeClassList(this);
  public hidden = false;
  public value = "";
  public parent: FakeElement | null = null;
  private listeners = new Map<string, Array<(event: Record<string, unknown>) => void>>();

  constructor(public readonly tagName: string) {}

  get parentElement(): FakeElement | null {
    return this.parent;
  }

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

  removeChild(child: FakeElement): void {
    this.children = this.children.filter((item) => item !== child);
    child.parent = null;
  }

  after(node: FakeElement): void {
    if (!this.parent) {
      return;
    }
    node.parent = this.parent;
    const index = this.parent.children.indexOf(this);
    this.parent.children.splice(index + 1, 0, node);
  }

  addEventListener(type: string, listener: (event: Record<string, unknown>) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  dispatchEvent(event: Record<string, unknown> & { type: string }): boolean {
    for (const listener of this.listeners.get(event.type) ?? []) {
      listener(event);
    }
    return true;
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
  public head = new FakeElement("head");

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName);
  }

  getElementById(id: string): FakeElement | null {
    return this.body.querySelector(`#${id}`) ?? this.head.querySelector(`#${id}`);
  }
}

function matchesSelector(element: FakeElement, selector: string): boolean {
  if (selector.includes(",")) {
    return selector.split(",").some((part) => matchesSelector(element, part.trim()));
  }
  const attrExact = selector.match(/^\[([^=\]]+)=['"]([^'"]+)['"]\]$/);
  if (attrExact) {
    return element.getAttribute(attrExact[1]) === attrExact[2];
  }
  const attrExists = selector.match(/^\[([^=\]]+)\]$/);
  if (attrExists) {
    return element.getAttribute(attrExists[1]) !== null;
  }
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

function createStatusItem(targetDocument: FakeDocument, label: string, value = "ready"): FakeElement {
  const item = targetDocument.createElement("div");
  item.className = "status-item";
  const labelNode = targetDocument.createElement("span");
  labelNode.className = "status-label";
  labelNode.textContent = label;
  const valueNode = targetDocument.createElement("span");
  valueNode.className = "status-value";
  valueNode.textContent = value;
  item.append(labelNode, valueNode);
  return item;
}

function createComposerDocument(): FakeDocument {
  const targetDocument = new FakeDocument();
  const shell = targetDocument.createElement("div");
  shell.className = "shell";
  const sidebar = targetDocument.createElement("aside");
  sidebar.className = "sidebar";
  const chat = targetDocument.createElement("section");
  chat.className = "chat-panel";
  const composer = targetDocument.createElement("form");
  composer.setAttribute("id", "composer-form");
  const composerRow = targetDocument.createElement("div");
  composerRow.className = "composer-row";
  const fileButton = targetDocument.createElement("button");
  fileButton.setAttribute("id", "temporary-file-button");
  const input = targetDocument.createElement("textarea");
  input.setAttribute("id", "composer-input");
  const sendButton = targetDocument.createElement("button");
  sendButton.setAttribute("id", "send-button");
  const stopButton = targetDocument.createElement("button");
  stopButton.setAttribute("id", "stop-generation-button");
  composerRow.append(fileButton, input, sendButton, stopButton);

  const status = targetDocument.createElement("section");
  status.className = "composer-status-panel";
  const systemStatus = targetDocument.createElement("div");
  systemStatus.className = "system-status";
  for (const label of ["Provider", "Model", "WebSocket", "Token用量", "RAG"]) {
    systemStatus.append(createStatusItem(targetDocument, label));
  }
  for (const label of ["Background tasks", "Approvals", "Cowork", "Uploads"]) {
    systemStatus.append(createStatusItem(targetDocument, label, "1 active"));
  }
  status.append(systemStatus);
  composer.append(composerRow, status);
  chat.append(composer);
  shell.append(sidebar, chat);
  targetDocument.body.append(shell);
  return targetDocument;
}

describe("desktop composer surface", () => {
  test("keeps composer controls and contextual stop scoped to the workspace surface", () => {
    const targetDocument = createComposerDocument();

    installRootWebUiComposerRuntime(targetDocument as unknown as Document);

    const composer = targetDocument.getElementById("composer-form");
    const row = targetDocument.body.querySelector(".composer-row");
    expect(composer?.getAttribute("data-desktop-composer")).toBe("true");
    expect(composer?.classList.contains("desktop-composer-surface")).toBe(true);
    expect(row?.getAttribute("data-workbench-region")).toBe("message-entry");
    expect(row?.getAttribute("data-desktop-composer-region")).toBe("controls");
    expect(targetDocument.getElementById("temporary-file-button")?.getAttribute("data-desktop-drop-target")).toBe("session-temporary-file");
    expect(targetDocument.getElementById("send-button")?.getAttribute("data-desktop-composer-action")).toBe("send");
    expect(targetDocument.getElementById("stop-generation-button")?.getAttribute("data-desktop-composer-action")).toBe("stop");
    expect(targetDocument.getElementById("stop-generation-button")?.parent).toBe(row);
  });

  test("keeps runtime chips near the composer and routes task status out of the composer", () => {
    const targetDocument = createComposerDocument();

    installRootWebUiComposerRuntime(targetDocument as unknown as Document);

    const runtimeLabels = targetDocument.body
      .querySelectorAll('[data-desktop-runtime-scope="workspace"]')
      .map((node) => node.getAttribute("data-desktop-runtime-chip"));
    expect(runtimeLabels).toEqual(["Provider", "Model", "WebSocket", "Token用量", "RAG"]);
    expect(targetDocument.body.querySelector(".composer-status-panel")?.getAttribute("data-desktop-composer-region")).toBe("runtime-status");
    expect(targetDocument.body.querySelector(".composer-status-panel")?.querySelectorAll("[data-desktop-task-status]")).toHaveLength(0);

    const taskSurface = targetDocument.body.querySelector(".desktop-task-status-surface");
    expect(taskSurface?.getAttribute("data-desktop-task-status-surface")).toBe("sidebar");
    expect(taskSurface?.querySelectorAll("[data-desktop-task-status]").map((node) => node.getAttribute("data-desktop-task-status"))).toEqual([
      "background-tasks",
      "approvals",
      "cowork",
      "uploads",
    ]);
  });

  test("reports blocked sends and runtime chip selection through composer feedback", () => {
    const targetDocument = createComposerDocument();

    installRootWebUiComposerRuntime(targetDocument as unknown as Document);

    const composer = targetDocument.getElementById("composer-form");
    const feedback = targetDocument.getElementById("desktop-composer-feedback");
    composer?.dispatchEvent({ type: "submit" });
    expect(feedback?.hidden).toBe(false);
    expect(feedback?.textContent).toContain("Enter a message");

    targetDocument.body.querySelector('[data-desktop-runtime-chip="Provider"]')?.dispatchEvent({ type: "click" });
    expect(feedback?.textContent).toContain("Provider status selected");
  });

  test("installs desktop composer styles separately from shell layout styles", () => {
    const targetDocument = new FakeDocument();

    ensureDesktopComposerSurfaceStyle(targetDocument as unknown as Document);
    ensureDesktopComposerSurfaceStyle(targetDocument as unknown as Document);

    const styleText = targetDocument.head.querySelector("#desktop-composer-surface-style")?.textContent ?? "";
    expect(targetDocument.head.querySelectorAll("#desktop-composer-surface-style")).toHaveLength(1);
    expect(styleText).toContain("body.desktop-root-webui-workbench .composer.desktop-composer-surface");
    expect(styleText).toContain('[data-desktop-composer-region="controls"]');
    expect(styleText).toContain('[data-desktop-runtime-scope="workspace"]');
    expect(styleText).toContain(".desktop-task-status-surface");
    expect(styleText).toContain('[data-desktop-composer-action="stop"]');
  });
});
