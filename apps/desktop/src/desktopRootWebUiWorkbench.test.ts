import { describe, expect, test } from "vitest";
import {
  applyRootWebUiWorkbenchLayout,
  ensureDesktopRootWebUiWorkbenchStyle,
  installRootWebUiComposerRuntime,
  installRootWebUiCommandPaletteSurface,
  upgradeDesktopRootWebUiEmptyState,
} from "./desktopRootWebUiWorkbench";

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
  const chat = document.createElement("section");
  chat.className = "chat-panel";
  const messageList = document.createElement("section");
  messageList.setAttribute("id", "message-list");
  const composer = document.createElement("form");
  composer.setAttribute("id", "composer-form");
  const composerRow = document.createElement("div");
  composerRow.className = "composer-row";
  const fileButton = document.createElement("button");
  fileButton.setAttribute("id", "temporary-file-button");
  const input = document.createElement("textarea");
  input.setAttribute("id", "composer-input");
  const sendButton = document.createElement("button");
  sendButton.setAttribute("id", "send-button");
  const status = document.createElement("section");
  status.className = "composer-status-panel";
  const statusItem = document.createElement("div");
  statusItem.className = "status-item";
  const statusLabel = document.createElement("span");
  statusLabel.className = "status-label";
  statusLabel.textContent = "Provider";
  statusItem.append(statusLabel);
  status.append(statusItem);
  composerRow.append(fileButton, input, sendButton);
  composer.append(composerRow, status);
  chat.append(messageList, composer);
  const inspector = document.createElement("aside");
  inspector.setAttribute("id", "inspector-panel");

  shell.append(sidebar, chat, inspector);
  document.body.append(shell);
  return document;
}

describe("desktop root WebUI workbench adapter", () => {
  test("marks the hosted root WebUI as a persistent desktop workbench", () => {
    const targetDocument = createRootWebUiDocument();

    applyRootWebUiWorkbenchLayout(targetDocument as unknown as Document, {
      sidebar: { visible: false, size: 280 },
      inspector: { visible: false, size: 420 },
      bottom: { visible: true, size: 260 },
    });

    const shell = targetDocument.body.querySelector(".shell");
    expect(targetDocument.body.classList.contains("desktop-root-webui-workbench")).toBe(true);
    expect(shell?.getAttribute("data-desktop-workbench")).toBe("root-webui");
    expect(shell?.getAttribute("data-sidebar-visible")).toBe("false");
    expect(shell?.getAttribute("data-inspector-visible")).toBe("false");
    expect(shell?.style.values.get("--desktop-sidebar-size")).toBe("280px");
    expect(shell?.style.values.get("--desktop-inspector-size")).toBe("420px");
    expect(targetDocument.body.querySelector(".sidebar")?.getAttribute("data-workbench-region")).toBe("sidebar");
    expect(targetDocument.getElementById("message-list")?.getAttribute("data-workbench-region")).toBe("conversation");
    expect(targetDocument.getElementById("composer-form")?.getAttribute("data-workbench-region")).toBe("composer");
    expect(targetDocument.body.querySelector(".composer-status-panel")?.getAttribute("data-workbench-region")).toBe("runtime-status");
    expect(targetDocument.getElementById("inspector-panel")?.getAttribute("aria-hidden")).toBe("true");
  });

  test("collapses a persisted inspector column when the hosted WebUI has no active inspector", () => {
    const targetDocument = createRootWebUiDocument();
    targetDocument.getElementById("inspector-panel")?.setAttribute("aria-hidden", "true");

    applyRootWebUiWorkbenchLayout(targetDocument as unknown as Document, {
      sidebar: { visible: true, size: 260 },
      inspector: { visible: true, size: 420 },
      bottom: { visible: false, size: 220 },
    });

    const shell = targetDocument.body.querySelector(".shell");
    expect(shell?.getAttribute("data-inspector-visible")).toBe("false");
    expect(shell?.classList.contains("inspection-mode")).toBe(false);
    expect(targetDocument.getElementById("inspector-panel")?.getAttribute("aria-hidden")).toBe("true");
  });

  test("adds task-oriented desktop modules to the root WebUI empty chat state once", () => {
    const targetDocument = new FakeDocument();
    const empty = targetDocument.createElement("div");
    empty.className = "empty-state empty-chat";
    const title = targetDocument.createElement("div");
    title.className = "empty-chat-title";
    const actions = targetDocument.createElement("div");
    actions.className = "empty-chat-actions";
    empty.append(title, actions);

    expect(upgradeDesktopRootWebUiEmptyState(empty as unknown as HTMLElement, targetDocument as unknown as Document)).toBe(true);
    expect(upgradeDesktopRootWebUiEmptyState(empty as unknown as HTMLElement, targetDocument as unknown as Document)).toBe(false);

    expect(empty.getAttribute("data-desktop-empty-state")).toBe("true");
    expect(empty.querySelectorAll(".desktop-empty-modules")).toHaveLength(1);
    expect(empty.querySelectorAll(".desktop-empty-module").map((node) => node.textContent)).toEqual([
      "Recent sessionsUse Search to resume a conversation.",
      "Files and resourcesAttach a session file or open Workspace.",
      "Background tasksCheck streaming, cowork, uploads, and approvals.",
      "Gateway healthUse the gateway chip for diagnostics.",
    ]);
  });

  test("mounts a command palette surface for the hosted root WebUI shell", () => {
    const targetDocument = new FakeDocument();

    installRootWebUiCommandPaletteSurface(targetDocument as unknown as Document);
    installRootWebUiCommandPaletteSurface(targetDocument as unknown as Document);

    expect(targetDocument.body.querySelectorAll("#desktop-command-palette")).toHaveLength(1);
    expect(targetDocument.getElementById("desktop-command-palette")?.getAttribute("role")).toBe("dialog");
    expect(targetDocument.getElementById("desktop-command-palette-input")?.getAttribute("aria-label")).toBe("Search commands and workbench data");
    expect(targetDocument.getElementById("desktop-command-palette-results")?.getAttribute("aria-live")).toBe("polite");
  });

  test("upgrades the hosted WebUI composer with runtime chips and blocked-send feedback", () => {
    const targetDocument = createRootWebUiDocument();

    installRootWebUiComposerRuntime(targetDocument as unknown as Document);

    const composer = targetDocument.getElementById("composer-form");
    const feedback = targetDocument.getElementById("desktop-composer-feedback");
    expect(composer?.getAttribute("data-desktop-composer")).toBe("true");
    expect(targetDocument.body.querySelector(".composer-row")?.getAttribute("data-workbench-region")).toBe("message-entry");
    expect(targetDocument.getElementById("temporary-file-button")?.getAttribute("data-desktop-drop-target")).toBe("session-temporary-file");
    expect(targetDocument.getElementById("send-button")?.getAttribute("data-desktop-composer-action")).toBe("send");
    expect(targetDocument.body.querySelector(".status-item")?.getAttribute("data-desktop-runtime-chip")).toBe("Provider");
    expect(targetDocument.body.querySelector(".status-item")?.getAttribute("role")).toBe("button");

    composer?.dispatchEvent({ type: "submit" });
    expect(feedback?.hidden).toBe(false);
    expect(feedback?.textContent).toContain("Enter a message");

    composer?.dispatchEvent({ type: "dragover", preventDefault: () => undefined });
    expect(composer?.classList.contains("is-desktop-drop-hover")).toBe(true);
  });

  test("declares root WebUI desktop fallback and narrow-window layout rules", () => {
    const targetDocument = new FakeDocument();

    ensureDesktopRootWebUiWorkbenchStyle(targetDocument as unknown as Document);

    const styleText = targetDocument.head.querySelector("#desktop-root-webui-workbench-style")?.textContent;
    expect(styleText).toContain("grid-template-columns: var(--desktop-sidebar-size, 248px) minmax(0, 1fr)");
    expect(styleText).toContain('body.desktop-root-webui-workbench > .shell[data-inspector-visible="false"]');
    expect(styleText).toContain("@media (max-width: 980px)");
    expect(styleText).toContain(".desktop-empty-modules");
    expect(styleText).toContain(".desktop-command-palette");
    expect(styleText).toContain(".desktop-composer-feedback");
  });
});
