import { describe, expect, test } from "vitest";
import { buildDesktopCoworkCockpitView, buildDesktopCoworkSessionRows } from "./desktopCowork";
import { buildDesktopKnowledgePaneModel } from "./desktopKnowledgeTraceability";
import { buildDesktopRunChainItems } from "./desktopRunChainInspector";
import { buildDesktopSettingsFormState, buildDesktopSettingsPaneModel } from "./desktopSettingsProviders";
import { buildDesktopTaskCenterItems } from "./desktopTaskCenter";
import { buildDesktopToolsSkillsPaneModel } from "./desktopToolsSkills";
import { buildDesktopWorkLensProjection } from "./desktopWorkLens";
import { createDefaultWorkbenchLayout } from "./desktopWorkbenchLayout";
import { installDesktopWorkbenchShell, updateDesktopSettingsPane, updateDesktopTaskCenterItems, updateDesktopToolsSkillsPane } from "./desktopWorkbenchShell";

class FakeElement {
  public id = "";
  public className = "";
  public children: FakeElement[] = [];
  public attributes = new Map<string, string>();
  public value = "";
  public checked = false;
  private listeners = new Map<string, ((event: unknown) => void)[]>();
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
    this.children.push(...children);
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  dispatchEvent(event: { type: string } & Record<string, unknown>): boolean {
    for (const listener of this.listeners.get(event.type) ?? []) {
      listener(event);
    }
    return true;
  }

  click(): void {
    this.dispatchEvent({ type: "click" });
  }

  getBoundingClientRect(): DOMRect {
    return {
      width: 160,
      height: 40,
      left: 0,
      top: 0,
      right: 160,
      bottom: 40,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    };
  }

  replaceChildren(...children: FakeElement[]): void {
    this.children = children;
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

class FakeClassList {
  public values = new Set<string>();

  add(value: string): void {
    this.values.add(value);
  }
}

class FakeBody extends FakeElement {
  public classList = new FakeClassList();

  constructor() {
    super("body");
  }
}

class FakeHead extends FakeElement {
  constructor() {
    super("head");
  }
}

class FakeDocument {
  public body = new FakeBody();
  public head = new FakeHead();
  public listeners = new Map<string, ((event: unknown) => void)[]>();

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName);
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  dispatchEvent(event: { type: string } & Record<string, unknown>): boolean {
    for (const listener of this.listeners.get(event.type) ?? []) {
      listener(event);
    }
    return true;
  }

  getElementById(id: string): FakeElement | null {
    return this.body.querySelector(`#${id}`) ?? this.head.querySelector(`#${id}`);
  }

  querySelector(selector: string): FakeElement | null {
    return this.body.querySelector(selector) ?? this.head.querySelector(selector);
  }

  querySelectorAll(selector: string): FakeElement[] {
    return [...this.body.querySelectorAll(selector), ...this.head.querySelectorAll(selector)];
  }
}

function matchesSelector(element: FakeElement, selector: string): boolean {
  if (selector.startsWith("#")) {
    return element.id === selector.slice(1) || element.getAttribute("id") === selector.slice(1);
  }
  if (selector.startsWith(".")) {
    return element.className.split(/\s+/).includes(selector.slice(1));
  }
  const region = selector.match(/^\[data-workbench-region="(.+)"\]$/);
  if (region) {
    return element.getAttribute("data-workbench-region") === region[1];
  }
  const attribute = selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
  if (attribute) {
    const [, name, value] = attribute;
    if (value === undefined) {
      return element.getAttribute(name) !== null;
    }
    return element.getAttribute(name) === value;
  }
  return false;
}

describe("desktop workbench shell", () => {
  test("renders persistent desktop regions from layout state", () => {
    const targetDocument = new FakeDocument();

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
    });

    expect(targetDocument.body.classList.values.has("desktop-native-workbench")).toBe(true);
    const shell = targetDocument.getElementById("desktop-workbench-shell");
    expect(shell).toBeTruthy();
    expect(shell?.style.values.get("--desktop-sidebar-size")).toBe("260px");
    expect(shell?.style.values.get("--desktop-inspector-size")).toBe("360px");
    expect(shell?.style.values.get("--desktop-bottom-size")).toBe("220px");
    expect(shell?.getAttribute("data-inspector-visible")).toBe("true");
    expect(shell?.getAttribute("data-bottom-visible")).toBe("false");
    expect(targetDocument.body.querySelector('[data-workbench-region="activity"]')).toBeTruthy();
    expect(targetDocument.body.querySelector('[data-workbench-region="sidebar"]')?.style.values.get("--region-size")).toBe("260px");
    expect(targetDocument.body.querySelector('[data-workbench-region="main"]')).toBeTruthy();
    expect(targetDocument.body.querySelector('[data-workbench-region="inspector"]')?.style.values.get("--region-size")).toBe("360px");
    expect(targetDocument.body.querySelector('[data-workbench-region="bottom"]')?.getAttribute("data-visible")).toBe("false");
    expect(targetDocument.head.querySelector("#desktop-workbench-shell-style")).toBeTruthy();
  });

  test("renders dense empty-chat context instead of a browser-style blank page", () => {
    const targetDocument = new FakeDocument();

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
    });

    expect(targetDocument.body.querySelector(".desktop-empty-session")?.textContent).toContain("Ready for a new session");
    expect(targetDocument.body.querySelectorAll(".desktop-quick-action").map((node) => node.textContent)).toEqual([
      "New chat",
      "Open workspace",
      "Gateway status",
    ]);
    expect(targetDocument.body.querySelector(".desktop-status-strip")?.textContent).toContain("http://127.0.0.1:18790");
  });

  test("renders explicit desktop navigation links for workbench, docs, gateway, and external routes", () => {
    const targetDocument = new FakeDocument();

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
    });

    expect(targetDocument.body.querySelectorAll(".desktop-activity-button").map((node) => node.getAttribute("href"))).toEqual([
      "/chat",
      "/workspace",
      "/knowledge",
      "/cowork",
    ]);
    expect(targetDocument.body.querySelectorAll(".desktop-quick-action").map((node) => node.getAttribute("href"))).toEqual([
      "/chat/new",
      "/workspace",
      "/api/status",
    ]);
    expect(targetDocument.body.querySelectorAll(".desktop-workbench-link").map((node) => node.getAttribute("href"))).toEqual([
      "/workspace",
      "/knowledge",
      "/tools",
      "/cowork",
      "/docs",
      "https://github.com/SudoJacky/tinybot",
      null,
      null,
      null,
    ]);
    expect(targetDocument.body.querySelector(".desktop-status-strip")?.getAttribute("data-desktop-route-status")).toBe("");
  });

  test("renders native sidebar navigation from shared desktop item metadata", () => {
    const targetDocument = new FakeDocument();

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
    });

    expect(targetDocument.body.querySelectorAll(".desktop-workbench-link")
      .filter((node) => node.getAttribute("href") !== null)
      .map((node) => node.getAttribute("data-sidebar-item-id"))).toEqual([
      "link:workspace",
      "link:knowledge",
      "link:tools",
      "link:automations",
      "link:docs",
      "link:repo",
    ]);
    expect(targetDocument.body.querySelector('[data-sidebar-command="open-settings"]')?.textContent).toBe("Settings");
    expect(targetDocument.body.querySelector('[data-sidebar-command="refresh-gateway-status"]')?.textContent).toBe("Gateway Status");
  });

  test("renders a keyboard-accessible command palette surface", () => {
    const targetDocument = new FakeDocument();

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
    });

    expect(targetDocument.getElementById("desktop-command-palette")?.getAttribute("role")).toBe("dialog");
    expect(targetDocument.getElementById("desktop-command-palette-input")?.getAttribute("aria-label")).toBe("Search commands and workbench data");
    expect(targetDocument.getElementById("desktop-command-palette-results")?.getAttribute("aria-live")).toBe("polite");
    expect(targetDocument.getElementById("desktop-command-palette-status")?.textContent).toContain("Type to search");
  });

  test("renders desktop docs, shortcut help, page help, and tour targets in persistent panes", () => {
    const targetDocument = new FakeDocument();

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: {
        ...createDefaultWorkbenchLayout(),
        bottom: { visible: true, size: 260 },
      },
      gatewayHttp: "http://127.0.0.1:18790",
    });

    const help = targetDocument.body.querySelector(".desktop-help-pane");
    expect(help?.getAttribute("aria-label")).toBe("Desktop help");
    expect(help?.querySelector('[data-desktop-help-action="docs"]')?.getAttribute("href")).toBe("/docs");
    expect(help?.querySelectorAll(".desktop-help-action").map((node) => node.textContent)).toEqual([
      "Open docs",
      "Shortcut help",
      "Page help",
      "Help tour",
    ]);

    help?.querySelector('[data-desktop-help-action="shortcut-help"]')?.click();
    expect(targetDocument.body.querySelector('[data-workbench-region="inspector"]')?.textContent).toContain("Shortcut Help");
    expect(targetDocument.body.querySelector('[data-workbench-region="inspector"]')?.textContent).toContain("Ctrl+Shift+P: Command palette");

    targetDocument.dispatchEvent({ type: "tinybot:open-page-help" });
    expect(targetDocument.body.querySelector('[data-workbench-region="inspector"]')?.textContent).toContain("Page help");

    help?.querySelector('[data-desktop-help-action="help-tour"]')?.click();
    const inspector = targetDocument.body.querySelector('[data-workbench-region="inspector"]');
    expect(inspector?.textContent).toContain("Desktop help tour");
    expect(inspector?.textContent).toContain("Step 1: Activity rail");
    expect(inspector?.textContent).toContain("Inspector - Review run-chain, task, gateway, file, and help details");
  });

  test("marks compact activity controls with predictable focus order and accessible labels", () => {
    const targetDocument = new FakeDocument();

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
    });

    const activityButtons = targetDocument.body.querySelectorAll(".desktop-activity-button");
    expect(activityButtons.map((node) => node.getAttribute("href"))).toEqual(["/chat", "/workspace", "/knowledge", "/cowork"]);
    expect(activityButtons.map((node) => node.getAttribute("aria-label"))).toEqual(["Chat", "Files", "Knowledge", "Cowork"]);
    expect(activityButtons.map((node) => node.getAttribute("data-focus-order"))).toEqual([
      "activity-1",
      "activity-2",
      "activity-3",
      "activity-4",
    ]);
  });

  test("renders keyboard-operable panel controls with accessible labels", () => {
    const targetDocument = new FakeDocument();

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
    });

    const controls = targetDocument.body.querySelectorAll(".desktop-panel-control");
    expect(controls.map((node) => node.getAttribute("data-desktop-panel-control"))).toEqual(["sidebar", "inspector", "bottom"]);
    expect(controls.map((node) => node.getAttribute("aria-label"))).toEqual([
      "Toggle sidebar panel",
      "Toggle inspector panel",
      "Toggle task and runtime panel",
    ]);
    expect(controls.map((node) => node.getAttribute("aria-pressed"))).toEqual(["true", "true", "false"]);
    expect(controls[0].getAttribute("aria-keyshortcuts")).toBe("Ctrl+B");

    let prevented = false;
    controls[1].dispatchEvent({
      type: "keydown",
      key: "Enter",
      preventDefault: () => {
        prevented = true;
      },
    });

    expect(prevented).toBe(true);
    expect(targetDocument.getElementById("desktop-workbench-shell")?.getAttribute("data-inspector-visible")).toBe("false");
    expect(targetDocument.body.querySelector('[data-workbench-region="inspector"]')?.getAttribute("data-visible")).toBe("false");
    expect(controls[1].getAttribute("aria-pressed")).toBe("false");
  });

  test("renders a persistent run-chain inspector pane with selectable details", () => {
    const targetDocument = new FakeDocument();
    const runChainItems = buildDesktopRunChainItems([
      {
        role: "assistant",
        message_id: "m-plan",
        reasoning_content: "Inspect the active context without moving the chat scroll.",
      },
      {
        role: "assistant",
        message_id: "m-context",
        citations: [
          {
            id: "cite-1",
            title: "Spec citation",
            url: "https://example.test/spec",
            snippet: "Selected spec evidence",
          },
        ],
      },
    ]);

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
      runChainItems,
      selectedRunChainItemKey: "m-context:citation:cite-1",
    });

    const pane = targetDocument.body.querySelector(".desktop-run-chain-inspector");
    expect(pane?.getAttribute("aria-label")).toBe("Run-chain inspector");
    expect(pane?.textContent).toContain("Completed | 2 items | planning");
    expect(pane?.querySelectorAll(".desktop-run-chain-item").map((row) => row.getAttribute("data-desktop-run-chain-item"))).toEqual([
      "m-plan:planning",
      "m-context:citation:cite-1",
    ]);
    expect(pane?.querySelector('[data-desktop-run-chain-item="m-context:citation:cite-1"]')?.getAttribute("aria-selected")).toBe("true");
    expect(pane?.querySelector(".desktop-run-chain-detail")?.textContent).toContain("Spec citation");
    expect(pane?.querySelector(".desktop-run-chain-detail")?.textContent).toContain("URL: https://example.test/spec");

    pane?.querySelector('[data-desktop-run-chain-item="m-plan:planning"]')?.click();
    expect(pane?.querySelector('[data-desktop-run-chain-item="m-plan:planning"]')?.getAttribute("aria-selected")).toBe("true");
    expect(pane?.querySelector(".desktop-run-chain-detail")?.textContent).toContain("Thinking: Inspect the active context");
    expect(targetDocument.body.querySelector(".desktop-empty-session")?.textContent).toContain("Ready for a new session");
  });

  test("renders a right-side Work Lens before generic inspector detail for running work", () => {
    const targetDocument = new FakeDocument();
    const [task] = buildDesktopTaskCenterItems({
      knowledgeJobs: [
        {
          id: "knowledge:doc-1:index",
          title: "Index Desktop UX Notes",
          status: "failed",
          detail: "Embedding provider returned 429",
          canonical: { module: "knowledge", entityId: "doc-1", href: "/knowledge" },
          retryable: true,
          diagnostics: "HTTP 429",
        },
      ],
    });
    const workLens = buildDesktopWorkLensProjection({
      task,
      resources: [
        {
          kind: "evidence",
          id: "evidence:doc-1",
          title: "Desktop UX evidence",
          detail: "Claim evidence",
          route: { module: "knowledge", entityId: "doc-1", href: "/knowledge" },
        },
      ],
      outputs: [
        {
          kind: "diagnostic",
          id: "diagnostic:doc-1",
          title: "Failure diagnostics",
          detail: "HTTP 429",
          route: { module: "knowledge", entityId: "doc-1", href: "/knowledge" },
        },
      ],
    });

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
      workLens,
    });

    const inspector = targetDocument.body.querySelector('[data-workbench-region="inspector"]');
    const lens = inspector?.querySelector(".desktop-work-lens");
    expect(lens?.getAttribute("aria-label")).toBe("Work Lens");
    expect(lens?.getAttribute("data-desktop-work-lens-mode")).toBe("ready");
    expect(lens?.textContent).toContain("Index Desktop UX Notes");
    expect(lens?.textContent).toContain("What is happening?");
    expect(lens?.textContent).toContain("Embedding provider returned 429");
    expect(lens?.textContent).toContain("What did it use?");
    expect(lens?.textContent).toContain("Desktop UX evidence");
    expect(lens?.textContent).toContain("What changed?");
    expect(lens?.textContent).toContain("Failure diagnostics");
    expect(lens?.querySelectorAll("[data-desktop-work-lens-action]").map((node) => node.getAttribute("data-desktop-work-lens-action"))).toEqual([
      "retry",
      "open",
      "inspect",
      "copyDiagnostics",
    ]);
    expect(lens?.querySelector('[data-desktop-work-lens-resource="evidence:doc-1"]')?.getAttribute("href")).toBe("/knowledge");
  });

  test("adds stable accessible names for Work Lens sections, resources, actions, and fallbacks", () => {
    const targetDocument = new FakeDocument();
    const [task] = buildDesktopTaskCenterItems({
      knowledgeJobs: [
        {
          id: "knowledge:doc-1:index",
          title: "Index Desktop UX Notes",
          status: "failed",
          detail: "Embedding provider returned 429",
          canonical: { module: "knowledge", entityId: "doc-1", href: "/knowledge" },
          retryable: true,
          diagnostics: "HTTP 429",
        },
      ],
    });
    const workLens = buildDesktopWorkLensProjection({
      task,
      resources: [
        {
          kind: "evidence",
          id: "evidence:doc-1",
          title: "Desktop UX evidence",
          detail: "Claim evidence",
          route: { module: "knowledge", entityId: "doc-1", href: "/knowledge" },
        },
      ],
    });

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
      workLens,
    });

    const lens = targetDocument.body.querySelector(".desktop-work-lens");
    expect(lens?.querySelector('[data-desktop-work-lens-section="happening"]')?.getAttribute("aria-label")).toBe("Work Lens section: happening");
    expect(lens?.querySelector('[data-desktop-work-lens-section="next"]')?.getAttribute("aria-label")).toBe("Work Lens section: next");
    expect(lens?.querySelector('[data-desktop-work-lens-resource="evidence:doc-1"]')?.getAttribute("aria-label")).toBe("Work Lens resource: evidence Desktop UX evidence");
    expect(lens?.querySelector('[data-desktop-work-lens-action="retry"]')?.getAttribute("aria-label")).toBe("Work Lens action: retry Index Desktop UX Notes");
    expect(lens?.querySelector('[data-desktop-work-lens-action="open"]')?.getAttribute("aria-label")).toBe("Work Lens action: open Index Desktop UX Notes");

    const [unsupported] = buildDesktopTaskCenterItems({
      providerRefreshes: [
        {
          id: "provider:openai:models",
          title: "Refresh OpenAI models",
          status: "completed",
          detail: "24 models loaded",
          canonical: { module: "settings", entityId: "openai", href: "/settings" },
        },
      ],
    });
    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
      workLens: buildDesktopWorkLensProjection({ task: unsupported }),
    });

    const fallback = targetDocument.body.querySelector(".desktop-work-lens");
    expect(fallback?.getAttribute("data-desktop-work-lens-fallback-reason")).toBe("unsupported-source");
    expect(fallback?.querySelector('[data-desktop-work-lens-fallback="unsupported-source"]')?.getAttribute("aria-label")).toBe("Work Lens fallback: unsupported-source");
  });

  test("renders Work Lens fallback without replacing source module access", () => {
    const targetDocument = new FakeDocument();
    const [task] = buildDesktopTaskCenterItems({
      providerRefreshes: [
        {
          id: "provider:openai:models",
          title: "Refresh OpenAI models",
          status: "completed",
          detail: "24 models loaded",
          canonical: { module: "settings", entityId: "openai", href: "/settings" },
        },
      ],
    });

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
      workLens: buildDesktopWorkLensProjection({ task }),
    });

    const lens = targetDocument.body.querySelector(".desktop-work-lens");
    expect(lens?.getAttribute("data-desktop-work-lens-mode")).toBe("fallback");
    expect(lens?.textContent).toContain("Refresh OpenAI models");
    expect(lens?.textContent).toContain("unsupported-source");
    expect(lens?.querySelector('[data-desktop-work-lens-action="open"]')?.getAttribute("href")).toBe("/settings");
  });

  test("dispatches bounded Work Lens actions without falling back to generic task actions", () => {
    const targetDocument = new FakeDocument();
    const events: string[] = [];
    const copied: string[] = [];
    const [task] = buildDesktopTaskCenterItems({
      knowledgeJobs: [
        {
          id: "knowledge:doc-1:index",
          title: "Index Desktop UX Notes",
          status: "failed",
          detail: "Embedding provider returned 429",
          canonical: { module: "knowledge", entityId: "doc-1", href: "/knowledge" },
          retryable: true,
          diagnostics: "HTTP 429",
        },
      ],
    });

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
      workLens: buildDesktopWorkLensProjection({ task }),
      workLensActions: {
        onWorkLensAction: ({ action, workLens }) => events.push(`${action}:${workLens.id}`),
        copyText: (text) => {
          copied.push(text);
        },
      },
      taskActions: {
        onTaskAction: ({ action }) => events.push(`task:${action}`),
      },
    });

    targetDocument.body.querySelector('[data-desktop-work-lens-action="retry"]')?.click();
    targetDocument.body.querySelector('[data-desktop-work-lens-action="copyDiagnostics"]')?.click();
    targetDocument.body.querySelector('[data-desktop-work-lens-action="open"]')?.click();

    expect(events).toEqual([
      "retry:knowledge:doc-1:index",
      "copyDiagnostics:knowledge:doc-1:index",
    ]);
    expect(copied).toEqual(["HTTP 429"]);
  });

  test("routes Task Center inspect selection into the right-side Work Lens", () => {
    const targetDocument = new FakeDocument();
    const items = buildDesktopTaskCenterItems({
      knowledgeJobs: [
        {
          id: "knowledge:doc-1:index",
          title: "Index Desktop UX Notes",
          status: "failed",
          detail: "Embedding provider returned 429",
          canonical: { module: "knowledge", entityId: "doc-1", href: "/knowledge" },
          retryable: true,
          diagnostics: "HTTP 429",
        },
      ],
    });

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
      taskCenterItems: items,
    });

    targetDocument.body.querySelector('[data-desktop-task-action="inspect"]')?.click();

    const inspector = targetDocument.body.querySelector('[data-workbench-region="inspector"]');
    const lens = inspector?.querySelector(".desktop-work-lens");
    expect(lens?.getAttribute("data-desktop-work-lens-kind")).toBe("knowledgeJob");
    expect(lens?.textContent).toContain("Index Desktop UX Notes");
    expect(lens?.textContent).toContain("Embedding provider returned 429");
    expect(lens?.textContent).toContain("What can I do next?");
    expect(targetDocument.body.querySelector("[data-desktop-route-status]")?.textContent).toContain("Inspecting Index Desktop UX Notes in Work Lens");
  });

  test("routes Cowork session selection into the right-side Work Lens", () => {
    const targetDocument = new FakeDocument();
    const session = {
      id: "cowork-1",
      title: "Review desktop release",
      goal: "Ship the desktop Work Lens",
      status: "intervention-needed",
      architecture: "adaptive_starter",
      updated_at: "2026-06-01T09:00:00Z",
      tasks: [
        { id: "task-1", title: "Review migration notes", status: "blocked" },
        { id: "task-2", title: "Publish release draft", status: "completed" },
      ],
      artifacts: [{ id: "artifact-1", title: "Release draft", path: "docs/release.md" }],
      completion_decision: { blocked: [{ id: "blocker-1", content: "Operator approval required." }] },
    };

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
      coworkPane: {
        sessionRows: buildDesktopCoworkSessionRows({ sessions: [session] }),
        cockpitView: buildDesktopCoworkCockpitView(session),
      },
    });

    targetDocument.body.querySelector('[data-desktop-cowork-session="cowork-1"]')?.click();

    const inspector = targetDocument.body.querySelector('[data-workbench-region="inspector"]');
    const lens = inspector?.querySelector(".desktop-work-lens");
    expect(lens?.getAttribute("data-desktop-work-lens-kind")).toBe("coworkRun");
    expect(lens?.textContent).toContain("Review desktop release");
    expect(lens?.textContent).toContain("Reason: 1 blocker");
    expect(lens?.textContent).toContain("Progress: 1/2");
    expect(lens?.textContent).toContain("What did it use?");
    expect(lens?.textContent).toContain("What changed?");
    expect(targetDocument.body.querySelector("[data-desktop-route-status]")?.textContent).toContain("Inspecting Review desktop release in Work Lens");
  });

  test("routes Chat module run selection into the right-side Work Lens", () => {
    const targetDocument = new FakeDocument();
    const items = buildDesktopTaskCenterItems({
      chatStreams: [
        {
          id: "chat:stream:chat-1",
          title: "Streaming response",
          status: "streaming",
          detail: "Generating answer",
          progress: { percent: 42 },
          canonical: { module: "chat", entityId: "chat-1", href: "/chat/chat-1" },
          cancelable: true,
        },
      ],
    });

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
      taskCenterItems: items,
    });

    targetDocument.body.querySelector('[data-desktop-module-work="chat:stream:chat-1"]')?.click();

    const inspector = targetDocument.body.querySelector('[data-workbench-region="inspector"]');
    const lens = inspector?.querySelector(".desktop-work-lens");
    expect(lens?.getAttribute("data-desktop-work-lens-kind")).toBe("chatRun");
    expect(lens?.textContent).toContain("Streaming response");
    expect(lens?.textContent).toContain("Progress: 42%");
    expect(targetDocument.body.querySelector("[data-desktop-route-status]")?.textContent).toContain("Inspecting Streaming response in Work Lens");
  });

  test("routes Knowledge module job selection into the right-side Work Lens", () => {
    const targetDocument = new FakeDocument();
    const items = buildDesktopTaskCenterItems({
      knowledgeJobs: [
        {
          id: "knowledge:doc-1:index",
          title: "Index Desktop UX Notes",
          status: "failed",
          detail: "Embedding provider returned 429",
          canonical: { module: "knowledge", entityId: "doc-1", href: "/knowledge" },
          retryable: true,
          diagnostics: "HTTP 429",
        },
      ],
    });
    const knowledgePane = buildDesktopKnowledgePaneModel({
      documentsPayload: { documents: [{ id: "doc-1", title: "Desktop UX Notes", path: "docs/desktop.md", chunk_count: 4, status: "stale" }] },
    });

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
      taskCenterItems: items,
      knowledgePane,
    });

    targetDocument.body.querySelector('[data-desktop-module-work="knowledge:doc-1:index"]')?.click();

    const inspector = targetDocument.body.querySelector('[data-workbench-region="inspector"]');
    const lens = inspector?.querySelector(".desktop-work-lens");
    expect(lens?.getAttribute("data-desktop-work-lens-kind")).toBe("knowledgeJob");
    expect(lens?.textContent).toContain("Index Desktop UX Notes");
    expect(lens?.textContent).toContain("Embedding provider returned 429");
    expect(targetDocument.body.querySelector("[data-desktop-route-status]")?.textContent).toContain("Inspecting Index Desktop UX Notes in Work Lens");
  });

  test("keeps Work Lens available in the main region when the inspector is hidden", () => {
    const targetDocument = new FakeDocument();
    const items = buildDesktopTaskCenterItems({
      knowledgeJobs: [
        {
          id: "knowledge:doc-1:index",
          title: "Index Desktop UX Notes",
          status: "failed",
          detail: "Embedding provider returned 429",
          canonical: { module: "knowledge", entityId: "doc-1", href: "/knowledge" },
          retryable: true,
          diagnostics: "HTTP 429",
        },
      ],
    });

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: {
        ...createDefaultWorkbenchLayout(),
        inspector: { visible: false, size: 360 },
      },
      gatewayHttp: "http://127.0.0.1:18790",
      taskCenterItems: items,
    });

    targetDocument.body.querySelector('[data-desktop-task-action="inspect"]')?.click();

    const main = targetDocument.body.querySelector('[data-workbench-region="main"]');
    const mainLens = main?.querySelector(".desktop-work-lens");
    expect(mainLens?.getAttribute("data-desktop-work-lens-kind")).toBe("knowledgeJob");
    expect(mainLens?.getAttribute("data-desktop-work-lens-placement")).toBe("inline");
    expect(mainLens?.textContent).toContain("Index Desktop UX Notes");
    expect(targetDocument.body.querySelector('[data-workbench-region="inspector"]')?.querySelector(".desktop-work-lens")).toBeNull();
  });

  test("refreshes or invalidates a visible Work Lens when task center state changes", () => {
    const targetDocument = new FakeDocument();
    const items = buildDesktopTaskCenterItems({
      knowledgeJobs: [
        {
          id: "knowledge:doc-1:index",
          title: "Index Desktop UX Notes",
          status: "failed",
          detail: "Embedding provider returned 429",
          canonical: { module: "knowledge", entityId: "doc-1", href: "/knowledge" },
          retryable: true,
          diagnostics: "HTTP 429",
        },
      ],
    });

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
      taskCenterItems: items,
    });

    targetDocument.body.querySelector('[data-desktop-task-action="inspect"]')?.click();
    expect(targetDocument.body.querySelector(".desktop-work-lens")?.textContent).toContain("Embedding provider returned 429");

    updateDesktopTaskCenterItems(targetDocument as unknown as Document, buildDesktopTaskCenterItems({
      knowledgeJobs: [
        {
          id: "knowledge:doc-1:index",
          title: "Index Desktop UX Notes",
          status: "completed",
          detail: "Indexed 4 chunks",
          canonical: { module: "knowledge", entityId: "doc-1", href: "/knowledge" },
        },
      ],
    }));

    const refreshed = targetDocument.body.querySelector(".desktop-work-lens");
    expect(refreshed?.getAttribute("data-desktop-work-lens-id")).toBe("knowledge:doc-1:index");
    expect(refreshed?.textContent).toContain("Status: completed");
    expect(refreshed?.textContent).toContain("Indexed 4 chunks");
    expect(refreshed?.textContent).not.toContain("Embedding provider returned 429");

    updateDesktopTaskCenterItems(targetDocument as unknown as Document, []);

    const invalidated = targetDocument.body.querySelector(".desktop-work-lens");
    expect(invalidated?.getAttribute("data-desktop-work-lens-mode")).toBe("fallback");
    expect(invalidated?.getAttribute("data-desktop-work-lens-fallback-reason")).toBe("missing-context");
  });

  test("renders native file upload actions for knowledge and session files", () => {
    const targetDocument = new FakeDocument();

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
    });

    expect(targetDocument.getElementById("desktop-knowledge-upload")?.getAttribute("data-desktop-file-upload")).toBe("knowledge-document");
    expect(targetDocument.getElementById("desktop-knowledge-upload")?.getAttribute("data-desktop-drop-target")).toBe("knowledge-document");
    expect(targetDocument.getElementById("desktop-session-file-upload")?.getAttribute("data-desktop-file-upload")).toBe("session-temporary-file");
    expect(targetDocument.getElementById("desktop-session-file-upload")?.getAttribute("data-desktop-drop-target")).toBe("session-temporary-file");
    expect(targetDocument.getElementById("desktop-workspace-file-drop")?.getAttribute("data-desktop-drop-target")).toBe("workspace-file");
    expect(targetDocument.getElementById("desktop-session-upload-key")?.getAttribute("aria-label")).toBe("Session key for temporary file upload");
    expect(targetDocument.getElementById("desktop-file-upload-status")?.textContent).toContain("No file operation running");
  });

  test("renders a bottom task center surface with task states, progress, diagnostics, and valid actions", () => {
    const targetDocument = new FakeDocument();
    const taskCenterItems = buildDesktopTaskCenterItems({
      coworkRuns: [
        {
          id: "cowork:session-1",
          title: "Review swarm plan",
          status: "blocked",
          detail: "Approval needed",
          canonical: { module: "cowork", entityId: "session-1", href: "/cowork" },
        },
      ],
      fileOperations: [
        {
          id: "file:workspace:AGENTS.md:save",
          title: "Save AGENTS.md",
          status: "failed",
          detail: "Save conflict",
          canonical: { module: "workspace", entityId: "AGENTS.md", href: "/workspace" },
          retryable: true,
          diagnostics: "HTTP 409",
        },
      ],
      chatStreams: [
        {
          id: "chat:stream:chat-1",
          title: "Streaming response",
          status: "streaming",
          detail: "Generating answer",
          progress: { percent: 42 },
          canonical: { module: "chat", entityId: "chat-1", href: "/chat/chat-1" },
          cancelable: true,
        },
      ],
      gatewayOperations: [
        {
          id: "gateway:restart",
          title: "Restart gateway",
          status: "canceled",
          detail: "User stopped restart",
          canonical: { module: "gateway", href: "/api/status" },
          retryable: true,
        },
      ],
      providerRefreshes: [
        {
          id: "provider:openai",
          title: "Refresh OpenAI models",
          status: "completed",
          detail: "24 models loaded",
          canonical: { module: "settings", entityId: "openai", href: "/settings" },
        },
      ],
    });

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: {
        ...createDefaultWorkbenchLayout(),
        bottom: { visible: true, size: 260 },
      },
      gatewayHttp: "http://127.0.0.1:18790",
      taskCenterItems,
    });

    expect(targetDocument.getElementById("desktop-task-center")?.getAttribute("aria-label")).toBe("Background task center");
    expect(targetDocument.getElementById("desktop-workbench-shell")?.getAttribute("data-bottom-visible")).toBe("true");
    expect(targetDocument.body.querySelector('[data-workbench-region="bottom"]')?.getAttribute("data-visible")).toBe("true");

    const rows = targetDocument.body.querySelectorAll(".desktop-task-center-item");
    expect(rows.map((row) => row.getAttribute("data-desktop-task-state"))).toEqual([
      "blocked",
      "failed",
      "active",
      "canceled",
      "completed",
    ]);
    expect(rows.map((row) => row.getAttribute("data-desktop-task-id"))).toEqual([
      "cowork:session-1",
      "file:workspace:AGENTS.md:save",
      "chat:stream:chat-1",
      "gateway:restart",
      "provider:openai",
    ]);
    expect(targetDocument.getElementById("desktop-task-center")?.textContent).toContain("42%");
    expect(targetDocument.getElementById("desktop-task-center")?.textContent).toContain("HTTP 409");

    const failedRow = rows.find((row) => row.getAttribute("data-desktop-task-id") === "file:workspace:AGENTS.md:save");
    expect(failedRow?.querySelectorAll(".desktop-task-action").map((action) => action.getAttribute("data-desktop-task-action"))).toEqual([
      "retry",
      "open",
      "inspect",
      "copyDiagnostics",
      "dismiss",
    ]);
    expect(failedRow?.querySelector('[data-desktop-task-action="open"]')?.getAttribute("href")).toBe("/workspace");

    const activeRow = rows.find((row) => row.getAttribute("data-desktop-task-id") === "chat:stream:chat-1");
    expect(activeRow?.querySelectorAll(".desktop-task-action").map((action) => action.getAttribute("data-desktop-task-action"))).toEqual([
      "cancel",
      "open",
      "inspect",
    ]);
  });

  test("renders detailed gateway runtime rows in the bottom surface", () => {
    const targetDocument = new FakeDocument();

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: {
        ...createDefaultWorkbenchLayout(),
        bottom: { visible: true, size: 260 },
      },
      gatewayHttp: "http://127.0.0.1:18790",
      runtimeStatus: {
        state: "running",
        owner: "shell",
        http_ok: true,
        gateway_http: "http://127.0.0.1:18790",
        gateway_ws: "ws://127.0.0.1:18790/ws",
        command: "uv run tinybot gateway",
        port: 18790,
        repo_root: "D:/Code/py/tinybot",
        logs: ["stdout: ready"],
        last_error: null,
        exit_policy: "keep_running",
      },
    });

    const runtime = targetDocument.body.querySelector(".desktop-gateway-runtime");
    expect(runtime?.getAttribute("aria-label")).toBe("Gateway runtime controls");
    expect(runtime?.querySelectorAll(".desktop-gateway-runtime-row").map((row) => row.textContent)).toEqual([
      "State: Running",
      "Owner: Shell-owned",
      "Command: uv run tinybot gateway",
      "Port: 18790",
      "Repo root: D:/Code/py/tinybot",
      "Recent logs: stdout: ready",
      "Last error: No recent error",
      "Exit policy: Keep shell-owned gateway running after exit",
    ]);
  });

  test("renders grouped settings and providers pane state in the desktop workbench", () => {
    const targetDocument = new FakeDocument();
    const settingsActions: string[] = [];
    const settingsPane = buildDesktopSettingsPaneModel(
      {
        agent: {
          workspace: "~/.tinybot/workspace",
          model: "",
          activeProfile: "work",
          provider: "openai",
          temperature: 0.1,
          maxTokens: 8192,
          contextWindowTokens: 65536,
          maxToolIterations: 200,
          reasoningEffort: null,
          timezone: "Shanghai",
        },
        embedding: {
          provider: "openai",
          modelName: "text-embedding-3-small",
          apiKey: "",
          apiBase: null,
        },
        knowledge: {
          enabled: true,
          autoRetrieve: true,
          maxChunks: 5,
          chunkSize: 500,
          chunkOverlap: 100,
          retrievalMode: "hybrid",
          rerankEnabled: false,
          rerankModel: "qwen3-rerank",
          rerankApiKey: null,
          rerankApiKeyEnvVar: "DASHSCOPE_API_KEY",
          rerankApiBase: "https://dashscope.aliyuncs.com/compatible-api/v1",
          rerankTopN: 0,
          generateSummary: false,
          semanticExtractionMode: "rule",
          semanticLlmMaxTokens: 1200,
          semanticLlmTimeout: 30,
          graphRagCommunityAlgorithm: "greedy",
          graphRagCommunityLevel: 0,
          graphRagReportLlmEnabled: false,
          graphRagReportMaxTokens: 1200,
          graphRagEntitySummaryEnabled: true,
        },
        tools: {
          webEnable: true,
          webProxy: null,
          searchProvider: "duckduckgo",
          execEnable: false,
          execTimeout: 60,
          mcpServersText: "",
          restrictToWorkspace: true,
        },
        gateway: {
          host: "0.0.0.0",
          port: 18790,
          heartbeatEnabled: true,
          heartbeatIntervalS: 1800,
        },
        channels: {
          sendProgress: true,
          sendToolHints: true,
          sendMaxRetries: 3,
        },
        providerEditor: {
          selectedProvider: "openai",
          profileId: "work",
          apiKey: "sk-live",
          apiBase: "https://api.openai.com/v1",
          modelsText: "gpt-4.1\ngpt-4.1-mini",
          supportsModelDiscovery: true,
        },
      },
      {
        lastSavedState: null,
        saveStatus: "failed",
        saveError: "HTTP 400",
        providerCatalog: [{ id: "openai", displayName: "OpenAI", status: "ready" }],
      },
    );

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
      settingsPane,
      settingsActions: {
        onSettingsAction: ({ action }) => settingsActions.push(action),
      },
    });

    const pane = targetDocument.body.querySelector(".desktop-settings-pane");
    expect(pane?.getAttribute("aria-label")).toBe("Settings and providers");
    expect(pane?.textContent).toContain("Settings");
    expect(pane?.textContent).toContain("Save: HTTP 400");
    expect(pane?.textContent).toContain("Validation: model, timezone");
    expect(pane?.textContent).toContain("Agent");
    expect(pane?.textContent).toContain("Model: ");
    expect(pane?.textContent).toContain("Provider profile: work");
    expect(pane?.textContent).toContain("API key: ********");
    expect(pane?.textContent).toContain("Catalog: OpenAI (ready)");
    expect(pane?.textContent).toContain("Models: gpt-4.1, gpt-4.1-mini");
    expect(pane?.querySelector('[data-desktop-settings-action="save"]')?.getAttribute("disabled")).toBe("true");
    expect(pane?.querySelector('[data-desktop-settings-action="discoverModels"]')?.textContent).toBe("Refresh models");
    pane?.querySelector('[data-desktop-settings-action="save"]')?.click();
    pane?.querySelector('[data-desktop-settings-action="discoverModels"]')?.click();
    expect(settingsActions).toEqual(["save", "discoverModels"]);
  });

  test("updates the installed settings pane without rebuilding the workbench", () => {
    const targetDocument = new FakeDocument();
    const firstPane = buildDesktopSettingsPaneModel(buildDesktopSettingsFormState({}), {
      saveStatus: "idle",
    });
    const nextState = buildDesktopSettingsFormState({
      agents: { defaults: { model: "gpt-4.1", provider: "openai", active_profile: "work" } },
      providers: { profiles: { work: { provider: "openai", api_key: "sk-live", models: ["gpt-4.1"] } } },
    }, [{ id: "openai", displayName: "OpenAI", status: "ready" }]);
    const nextPane = buildDesktopSettingsPaneModel(nextState, {
      lastSavedState: nextState,
      saveStatus: "saved",
      providerCatalog: [{ id: "openai", displayName: "OpenAI", status: "ready" }],
    });

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
      settingsPane: firstPane,
    });
    updateDesktopSettingsPane(targetDocument as unknown as Document, nextPane);

    const pane = targetDocument.body.querySelector(".desktop-settings-pane");
    expect(pane?.textContent).toContain("Save: Settings saved");
    expect(pane?.textContent).toContain("Provider profile: work");
    expect(pane?.textContent).toContain("Catalog: OpenAI (ready)");
  });

  test("renders tools and skills list-detail pane in the desktop workbench", () => {
    const targetDocument = new FakeDocument();
    const toolSkillActions: string[] = [];
    const edits: string[] = [];
    const toolsSkillsPane = buildDesktopToolsSkillsPaneModel({
      toolsPayload: {
        tools: [
          {
            name: "exec",
            description: "Run a command",
            parameters: {
              type: "object",
              required: ["command"],
              properties: {
                command: { type: "string", description: "Command to run" },
              },
            },
          },
        ],
      },
      skillsPayload: {
        skills: [
          { name: "planner", source: "workspace", available: true, always: true },
        ],
      },
      config: { tools: { exec: { enable: false } }, skills: { enabled: ["*"] } },
      selectedToolName: "exec",
      selectedSkillName: "planner",
      selectedSkillDetail: {
        name: "planner",
        content: "# Planner",
        tinybot_meta: { description: "Plan work", always: true },
      },
    });

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
      toolsSkillsPane,
      toolsSkillsActions: {
        onToolsSkillsAction: ({ action, field, value }) => {
          toolSkillActions.push(action);
          if (field) {
            edits.push(`${field}:${String(value)}`);
          }
        },
      },
    });

    const pane = targetDocument.body.querySelector(".desktop-tools-skills-pane");
    expect(pane?.getAttribute("aria-label")).toBe("Tools and skills");
    expect(pane?.textContent).toContain("Tools and skills");
    expect(pane?.textContent).toContain("1 tool / 1 skill");
    expect(pane?.textContent).toContain("Command: disabled / 1 parameters");
    expect(pane?.textContent).toContain("Tool detail: Command");
    expect(pane?.textContent).toContain("Config: execDisabled");
    expect(pane?.textContent).toContain("command: string required - Command to run");
    expect(pane?.textContent).toContain("planner: workspace / always");
    expect(pane?.textContent).toContain("Skill detail: planner");
    expect(pane?.textContent).toContain("Source: workspace");
    expect(pane?.textContent).toContain("Always load: Enabled");
    expect(pane?.textContent).toContain("Save state: No changes");
    expect(pane?.textContent).toContain("Validation: idle");

    const description = pane?.querySelector('[data-desktop-skill-editor-field="description"]');
    description!.value = "Plan better";
    description?.dispatchEvent({ type: "input", target: description });
    const always = pane?.querySelector('[data-desktop-skill-editor-field="always"]');
    always!.checked = false;
    always?.dispatchEvent({ type: "change", target: always });

    pane?.querySelector('[data-desktop-tools-skills-action="validateSkill"]')?.click();
    pane?.querySelector('[data-desktop-tools-skills-action="saveSkill"]')?.click();
    pane?.querySelector('[data-desktop-tools-skills-action="deleteSkill"]')?.click();
    pane?.querySelector('[data-desktop-tools-skills-action="toggleAlways"]')?.click();
    expect(toolSkillActions).toEqual(["editSkill", "editSkill", "validateSkill", "saveSkill", "deleteSkill", "toggleAlways"]);
    expect(edits).toEqual(["description:Plan better", "always:false"]);
  });

  test("updates the installed tools and skills pane without rebuilding the workbench", () => {
    const targetDocument = new FakeDocument();
    const firstPane = buildDesktopToolsSkillsPaneModel({});
    const nextPane = buildDesktopToolsSkillsPaneModel({
      toolsPayload: { tools: [{ name: "read_file", description: "Read files" }] },
      skillsPayload: { skills: [{ name: "reviewer", source: "builtin", available: true }] },
      selectedToolName: "read_file",
      selectedSkillName: "reviewer",
      selectedSkillDetail: { name: "reviewer", content: "# Reviewer", metadata: { description: "Review work" } },
    });

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
      toolsSkillsPane: firstPane,
    });
    updateDesktopToolsSkillsPane(targetDocument as unknown as Document, nextPane);

    const pane = targetDocument.body.querySelector(".desktop-tools-skills-pane");
    expect(pane?.textContent).toContain("1 tool / 1 skill");
    expect(pane?.textContent).toContain("Read file: no parameters");
    expect(pane?.textContent).toContain("reviewer: builtin / enabled");
  });

  test("renders knowledge pane with document detail, query, graph, and traceability actions", () => {
    const targetDocument = new FakeDocument();
    const actionEvents: string[] = [];
    const knowledgePane = buildDesktopKnowledgePaneModel({
      statsPayload: {
        total_documents: 1,
        total_chunks: 4,
        indexed_dense: 4,
        indexed_sparse: 4,
        claims_ready: true,
        relations_ready: true,
        graph_ready: true,
        stage_readiness: {
          evidence_expansion: { stage: "evidence_expansion", status: "complete", ready: true },
        },
      },
      config: { knowledge: { enabled: true, retrieval_mode: "hybrid", max_chunks: 5 } },
      documentsPayload: { documents: [{ id: "doc-1", title: "Desktop UX", path: "docs/desktop.md", chunk_count: 4, status: "indexed" }] },
      selectedDocumentId: "doc-1",
      queryDraft: { query: "desktop", mode: "hybrid", topK: 5 },
      queryResultPayload: { data: [{ doc_id: "doc-1", doc_name: "Desktop UX", content: "Desktop knowledge pane", score: 0.7 }] },
      graphPayload: {
        nodes: [{ id: "desktop", label: "Desktop" }],
        edges: [],
        communities: [{ id: "c1", title: "Desktop cluster", summary: "Cluster summary" }],
        reports: [{ id: "r1", title: "Desktop report", summary: "Report summary" }],
        claims: [{ id: "claim-1", text: "Desktop knowledge pane", source: { doc_name: "Desktop UX" } }],
      },
    });

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
      knowledgePane,
      knowledgeActions: {
        onKnowledgeAction: ({ action }) => actionEvents.push(action),
      },
    });

    const pane = targetDocument.body.querySelector(".desktop-knowledge-pane");
    expect(pane?.getAttribute("aria-label")).toBe("Knowledge workbench");
    expect(pane?.textContent).toContain("Knowledge");
    expect(pane?.textContent).toContain("1 doc / readiness 100% / graph 1 nodes / 0 edges");
    expect(pane?.textContent).toContain("Knowledge enabled");
    expect(pane?.textContent).toContain("Desktop UX: indexed / 4 chunks");
    expect(pane?.textContent).toContain("Document detail: Desktop UX");
    expect(pane?.textContent).toContain("docs/desktop.md / indexed / 4 chunks");
    expect(pane?.textContent).toContain("Query: desktop");
    expect(pane?.textContent).toContain("Results: 1");
    expect(pane?.textContent).toContain("Graph: 1 nodes / 0 edges / 0 evidence");
    expect(pane?.textContent).toContain("Community: Desktop cluster");
    expect(pane?.textContent).toContain("Report: Desktop report");
    expect(pane?.textContent).toContain("Claim: Desktop knowledge pane");

    pane?.querySelector('[data-desktop-knowledge-action="runQuery"]')?.click();
    pane?.querySelector('[data-desktop-knowledge-action="refreshGraph"]')?.click();
    pane?.querySelector('[data-desktop-knowledge-action="rebuildIndex"]')?.click();
    pane?.querySelector('[data-desktop-knowledge-action="deleteDocument"]')?.click();
    expect(actionEvents).toEqual(["runQuery", "refreshGraph", "rebuildIndex", "deleteDocument"]);
  });

  test("renders a desktop Cowork cockpit with session list, graph, inspector, actions, and task feed", () => {
    const targetDocument = new FakeDocument();
    const actionEvents: Array<{ action: string; sessionId: string; goal: string; message: string }> = [];
    const session = {
      id: "cowork-1",
      title: "Desktop migration",
      goal: "Move Cowork into a desktop cockpit",
      status: "blocked",
      architecture: "adaptive_starter",
      updated_at: "2026-05-31T09:00:00Z",
      agents: [
        { id: "agent-1", name: "Planner", role: "architect", status: "running", current_task_id: "task-1" },
      ],
      tasks: [
        { id: "task-1", title: "Map cockpit layout", status: "in_progress", assigned_agent_id: "agent-1" },
      ],
      mailbox: [
        { id: "mail-1", sender_id: "agent-1", recipient_ids: ["reviewer"], status: "delivered", content: "Need layout review.", requires_reply: true },
      ],
      graph: {
        nodes: [{ id: "agent-1", label: "Planner", kind: "agent" }, { id: "task-1", label: "Map cockpit layout", kind: "task" }],
        edges: [{ id: "edge-1", source: "agent-1", target: "task-1", kind: "owns" }],
      },
      completion_decision: { blocked: [{ id: "mail-1", content: "Need layout review." }] },
    };

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
      coworkPane: {
        sessionRows: buildDesktopCoworkSessionRows({ sessions: [session] }),
        cockpitView: buildDesktopCoworkCockpitView(session, { selected: { type: "task", id: "task-1" } }),
      },
      coworkActions: {
        onCoworkAction: (event) => {
          actionEvents.push({
            action: event.action,
            sessionId: event.sessionId ?? "",
            goal: event.goal ?? "",
            message: event.message ?? "",
          });
        },
      },
    });

    const pane = targetDocument.body.querySelector(".desktop-cowork-cockpit");
    const goal = pane?.querySelector('[data-desktop-cowork-input="goal"]');
    const message = pane?.querySelector('[data-desktop-cowork-input="message"]');
    if (goal) {
      goal.value = "Create a desktop run";
    }
    if (message) {
      message.value = "Continue with the next unit";
    }
    expect(pane?.getAttribute("aria-label")).toBe("Cowork cockpit");
    expect(pane?.textContent).toContain("Desktop migration");
    expect(pane?.textContent).toContain("Move Cowork into a desktop cockpit");
    expect(pane?.textContent).toContain("blocked / Adaptive Starter / 1 agent / 0/1 tasks");
    expect(pane?.querySelectorAll(".desktop-cowork-session-row").map((row) => row.getAttribute("data-desktop-cowork-session"))).toEqual(["cowork-1"]);
    expect(pane?.querySelector(".desktop-cowork-graph")?.textContent).toContain("2 nodes / 1 edge");
    expect(pane?.querySelector(".desktop-cowork-graph")?.textContent).toContain("Planner");
    expect(pane?.querySelector(".desktop-cowork-inspector")?.textContent).toContain("Map cockpit layout");
    expect(pane?.querySelector(".desktop-cowork-inspector")?.textContent).toContain("Owner: agent-1");
    pane?.querySelector('[data-desktop-cowork-entity="agent-1"]')?.click();
    expect(pane?.querySelector(".desktop-cowork-inspector")?.textContent).toContain("Selected: Planner");
    expect(pane?.querySelector(".desktop-cowork-inspector")?.textContent).toContain("Status: running");
    expect(pane?.querySelectorAll(".desktop-cowork-action").map((row) => row.getAttribute("data-desktop-cowork-action"))).toEqual([
      "blueprintValidate",
      "blueprintPreview",
      "create",
      "run",
      "pause",
      "resume",
      "emergencyStop",
      "delete",
      "message",
      "summary",
      "addTask",
    ]);
    for (const action of ["create", "run", "pause", "resume", "emergencyStop", "delete", "message", "summary"]) {
      pane?.querySelector(`[data-desktop-cowork-action="${action}"]`)?.click();
    }
    expect(actionEvents).toEqual([
      { action: "createSession", sessionId: "", goal: "Create a desktop run", message: "" },
      { action: "runSession", sessionId: "cowork-1", goal: "", message: "" },
      { action: "pauseSession", sessionId: "cowork-1", goal: "", message: "" },
      { action: "resumeSession", sessionId: "cowork-1", goal: "", message: "" },
      { action: "emergencyStopSession", sessionId: "cowork-1", goal: "", message: "" },
      { action: "deleteSession", sessionId: "cowork-1", goal: "", message: "" },
      { action: "sendMessage", sessionId: "cowork-1", goal: "", message: "Continue with the next unit" },
      { action: "loadSummary", sessionId: "cowork-1", goal: "", message: "" },
    ]);
    expect(pane?.querySelector(".desktop-cowork-task-feed")?.textContent).toContain("1 blocker");
  });

  test("routes Cowork blueprint validate and preview actions from the cockpit", () => {
    const targetDocument = new FakeDocument();
    const actionEvents: Array<{ action: string; blueprintText: string; preview: boolean }> = [];
    const session = {
      id: "cowork-1",
      title: "Desktop migration",
      goal: "Move Cowork into a desktop cockpit",
      status: "running",
      architecture: "adaptive_starter",
    };

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
      coworkPane: {
        sessionRows: buildDesktopCoworkSessionRows({ sessions: [session] }),
        cockpitView: buildDesktopCoworkCockpitView(session),
        blueprintDiagnostics: "Valid / 1 warning(s)",
      },
      coworkActions: {
        onCoworkAction: (event) => {
          actionEvents.push({
            action: event.action,
            blueprintText: event.blueprintText ?? "",
            preview: event.preview === true,
          });
        },
      },
    });

    const pane = targetDocument.body.querySelector(".desktop-cowork-cockpit");
    const blueprint = pane?.querySelector('[data-desktop-cowork-input="blueprint"]');
    if (blueprint) {
      blueprint.value = "{\"agents\":[]}";
    }

    expect(pane?.textContent).toContain("Blueprint: Valid / 1 warning(s)");
    pane?.querySelector('[data-desktop-cowork-action="blueprintValidate"]')?.click();
    pane?.querySelector('[data-desktop-cowork-action="blueprintPreview"]')?.click();

    expect(actionEvents).toEqual([
      { action: "validateBlueprint", blueprintText: "{\"agents\":[]}", preview: false },
      { action: "validateBlueprint", blueprintText: "{\"agents\":[]}", preview: true },
    ]);
  });

  test("renders Cowork observability tabs and preserves selected inspector while switching panels", () => {
    const targetDocument = new FakeDocument();
    const session = {
      id: "cowork-1",
      title: "Desktop migration",
      goal: "Move Cowork into a desktop cockpit",
      status: "blocked",
      architecture: "adaptive_starter",
      agents: [{ id: "agent-1", name: "Planner", status: "running", current_task_title: "Map helpers" }],
      tasks: [{ id: "task-1", title: "Map helpers", status: "in_progress", assigned_agent_id: "agent-1" }],
      mailbox: [{ id: "mail-1", sender_id: "agent-1", recipient_ids: ["reviewer"], status: "delivered", content: "Need review", requires_reply: true }],
      trace: [{ id: "trace-1", stage: "task", action: "assign", status: "completed", detail: "Assigned task" }],
      artifact_index: [{ id: "artifact-1", kind: "file", path_or_url: "docs/plan.md", summary: "Plan" }],
      run_metrics: [{ label: "Round efficiency", value: "82%" }],
      architecture_projection: { summary: "Adaptive starter projection" },
      swarm_plan: { summary: "Planner swarm", work_units: [{ id: "wu-1", title: "Extract projections", status: "ready" }] },
      task_dag: { nodes: [{ id: "task-1", label: "Map helpers" }], edges: [] },
      outputs: [{ id: "output-1", title: "Draft output", content: "Desktop adaptation notes" }],
      final_draft: "Ship the desktop Cowork cockpit.",
      evaluation_results: [{ id: "eval-1", status: "passed", summary: "Coverage OK" }],
      completion_decision: { blocked: [{ id: "blocker-1", content: "Need endpoint parity." }] },
      graph: {
        nodes: [{ id: "agent-1", label: "Planner", kind: "agent" }],
        edges: [],
      },
    };

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
      coworkPane: {
        sessionRows: buildDesktopCoworkSessionRows({ sessions: [session] }),
        cockpitView: buildDesktopCoworkCockpitView(session, { selected: { type: "agent", id: "agent-1" } }),
      },
    });

    const pane = targetDocument.body.querySelector(".desktop-cowork-cockpit");
    expect(pane?.querySelectorAll(".desktop-cowork-observability-tab").map((row) => row.getAttribute("data-desktop-cowork-panel"))).toEqual([
      "graph",
      "focus",
      "metrics",
      "architecture",
      "swarm",
      "workUnits",
      "taskDag",
      "agents",
      "tasks",
      "mailbox",
      "threads",
      "trace",
      "artifacts",
      "outputs",
      "finalDraft",
      "blockers",
      "evaluations",
      "status",
    ]);
    expect(pane?.querySelector(".desktop-cowork-observability-panel")?.textContent).toContain("Graph");

    pane?.querySelector('[data-desktop-cowork-panel="metrics"]')?.click();
    expect(pane?.querySelector(".desktop-cowork-observability-panel")?.textContent).toContain("Round efficiency: 82%");
    expect(pane?.querySelector(".desktop-cowork-inspector")?.textContent).toContain("Selected: Planner");

    pane?.querySelector('[data-desktop-cowork-panel="finalDraft"]')?.click();
    expect(pane?.querySelector(".desktop-cowork-observability-panel")?.textContent).toContain("Ship the desktop Cowork cockpit.");
  });

  test("constrains large Cowork sessions with bounded rendering and observability filtering", () => {
    const targetDocument = new FakeDocument();
    const session = {
      id: "cowork-large",
      title: "Large desktop migration",
      status: "running",
      agents: Array.from({ length: 40 }, (_, index) => ({
        id: `agent-${index + 1}`,
        name: `Agent ${index + 1}`,
        status: index % 2 === 0 ? "running" : "idle",
      })),
      tasks: Array.from({ length: 70 }, (_, index) => ({
        id: `task-${index + 1}`,
        title: `Task ${index + 1}`,
        status: index % 3 === 0 ? "completed" : "in_progress",
      })),
      trace: Array.from({ length: 80 }, (_, index) => ({
        id: `trace-${index + 1}`,
        stage: `Trace span ${index + 1}`,
        action: "step",
        status: "completed",
      })),
      artifact_index: Array.from({ length: 45 }, (_, index) => ({
        id: `artifact-${index + 1}`,
        kind: "file",
        path_or_url: `docs/artifact-${index + 1}.md`,
      })),
      graph: {
        nodes: Array.from({ length: 60 }, (_, index) => ({
          id: `task-${index + 1}`,
          label: `Task ${index + 1}`,
          kind: "task",
        })),
        edges: Array.from({ length: 40 }, (_, index) => ({
          source: `task-${index + 1}`,
          target: `task-${index + 2}`,
          label: "depends",
        })),
      },
    };

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
      coworkPane: {
        sessionRows: buildDesktopCoworkSessionRows({ sessions: [session] }),
        cockpitView: buildDesktopCoworkCockpitView(session),
      },
    });

    const pane = targetDocument.body.querySelector(".desktop-cowork-cockpit");
    expect(pane?.querySelectorAll(".desktop-cowork-graph-node")).toHaveLength(24);
    expect(pane?.querySelector(".desktop-cowork-graph")?.textContent).toContain("Showing 24 of 60 nodes");
    expect(pane?.querySelector(".desktop-cowork-graph")?.textContent).toContain("Showing 12 of 40 edges");

    pane?.querySelector('[data-desktop-cowork-panel="tasks"]')?.click();
    expect(pane?.querySelectorAll(".desktop-cowork-observability-row")).toHaveLength(24);
    expect(pane?.querySelector(".desktop-cowork-observability-panel")?.textContent).toContain("Showing 24 of 70 rows");
    expect(pane?.querySelector(".desktop-cowork-observability-panel")?.textContent).not.toContain("Task 25");

    pane?.querySelector('[data-desktop-cowork-panel="trace"]')?.click();
    expect(pane?.querySelectorAll(".desktop-cowork-observability-row")).toHaveLength(24);
    expect(pane?.querySelector(".desktop-cowork-observability-panel")?.textContent).toContain("Showing 24 of 80 rows");
    expect(pane?.querySelector(".desktop-cowork-observability-panel")?.textContent).not.toContain("Trace span 25");

    const filter = pane?.querySelector('[data-desktop-cowork-filter="observability"]');
    if (filter) {
      filter.value = "Trace span 70";
      filter.dispatchEvent({ type: "input", target: filter });
    }

    expect(pane?.querySelector(".desktop-cowork-observability-panel")?.textContent).toContain("Showing 1 of 1 matching rows (80 total)");
    expect(pane?.querySelector(".desktop-cowork-observability-panel")?.textContent).toContain("Trace span 70");
  });

  test("routes Cowork task, work-unit, and branch operations from desktop controls", () => {
    const targetDocument = new FakeDocument();
    const actionEvents: Array<Record<string, unknown>> = [];
    const session = {
      id: "cowork-1",
      title: "Desktop migration",
      status: "blocked",
      agents: [{ id: "agent-1", name: "Planner" }, { id: "agent-2", name: "Reviewer" }],
      tasks: [{ id: "task-1", title: "Map helpers", status: "failed", assigned_agent_id: "agent-1" }],
      branch_results: [{ branch_id: "branch-a", result_id: "result-a", summary: "Use helpers" }, { branch_id: "branch-b", result_id: "result-b", summary: "Use controllers" }],
      swarm_plan: {
        work_units: [{ id: "wu-1", title: "Extract projections", status: "failed", assigned_agent_id: "agent-1" }],
      },
      graph: {
        nodes: [
          { id: "task-1", label: "Map helpers", kind: "task" },
          { id: "wu-1", label: "Extract projections", kind: "workUnit" },
          { id: "branch-a", label: "Use helpers", kind: "branch" },
        ],
        edges: [],
      },
    };

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
      coworkPane: {
        sessionRows: buildDesktopCoworkSessionRows({ sessions: [session] }),
        cockpitView: buildDesktopCoworkCockpitView(session, { selected: { type: "task", id: "task-1" } }),
      },
      coworkActions: {
        onCoworkAction: (event) => {
          const record: Record<string, unknown> = {
            action: event.action,
            sessionId: event.sessionId,
            taskId: event.taskId,
            taskAction: event.taskAction,
            workUnitId: event.workUnitId,
            workUnitAction: event.workUnitAction,
            branchId: event.branchId,
            resultId: event.resultId,
            branchIds: event.branchIds,
            title: event.taskTitle,
            assignedAgentId: event.assignedAgentId,
          };
          for (const key of Object.keys(record)) {
            if (record[key] === undefined) {
              delete record[key];
            }
          }
          actionEvents.push(record);
        },
      },
    });

    const pane = targetDocument.body.querySelector(".desktop-cowork-cockpit");
    const taskTitle = pane?.querySelector('[data-desktop-cowork-input="taskTitle"]');
    const taskAgents = pane?.querySelectorAll('[data-desktop-cowork-input="assignedAgentId"]') ?? [];
    if (taskTitle) {
      taskTitle.value = "Write migration notes";
    }
    for (const taskAgent of taskAgents) {
      taskAgent.value = "agent-2";
    }
    pane?.querySelector('[data-desktop-cowork-action="addTask"]')?.click();
    pane?.querySelector('[data-desktop-cowork-entity-action="assignTask"]')?.click();
    pane?.querySelector('[data-desktop-cowork-entity-action="retryTask"]')?.click();
    pane?.querySelector('[data-desktop-cowork-entity-action="reviewTask"]')?.click();

    pane?.querySelector('[data-desktop-cowork-entity="wu-1"]')?.click();
    pane?.querySelector('[data-desktop-cowork-entity-action="retryWorkUnit"]')?.click();
    pane?.querySelector('[data-desktop-cowork-entity-action="skipWorkUnit"]')?.click();
    pane?.querySelector('[data-desktop-cowork-entity-action="cancelWorkUnit"]')?.click();

    pane?.querySelector('[data-desktop-cowork-entity="branch-a"]')?.click();
    pane?.querySelector('[data-desktop-cowork-entity-action="selectBranch"]')?.click();
    pane?.querySelector('[data-desktop-cowork-entity-action="selectBranchResult"]')?.click();
    pane?.querySelector('[data-desktop-cowork-entity-action="mergeBranchResults"]')?.click();

    expect(actionEvents).toEqual([
      { action: "addTask", sessionId: "cowork-1", title: "Write migration notes", assignedAgentId: "agent-2" },
      { action: "task", sessionId: "cowork-1", taskId: "task-1", taskAction: "assign", assignedAgentId: "agent-2" },
      { action: "task", sessionId: "cowork-1", taskId: "task-1", taskAction: "retry" },
      { action: "task", sessionId: "cowork-1", taskId: "task-1", taskAction: "review" },
      { action: "workUnit", sessionId: "cowork-1", workUnitId: "wu-1", workUnitAction: "retry" },
      { action: "workUnit", sessionId: "cowork-1", workUnitId: "wu-1", workUnitAction: "skip" },
      { action: "workUnit", sessionId: "cowork-1", workUnitId: "wu-1", workUnitAction: "cancel" },
      { action: "selectBranch", sessionId: "cowork-1", branchId: "branch-a" },
      { action: "selectBranchResult", sessionId: "cowork-1", branchId: "branch-a", resultId: "result-a" },
      { action: "mergeBranchResults", sessionId: "cowork-1", branchIds: ["branch-a", "branch-b"] },
    ]);
  });

  test("handles ownership-aware gateway runtime actions", () => {
    const targetDocument = new FakeDocument();
    const actionEvents: string[] = [];
    const copied: string[] = [];

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: {
        ...createDefaultWorkbenchLayout(),
        bottom: { visible: true, size: 260 },
      },
      gatewayHttp: "http://127.0.0.1:18790",
      runtimeStatus: {
        state: "running",
        owner: "shell",
        http_ok: true,
        gateway_http: "http://127.0.0.1:18790",
        gateway_ws: "ws://127.0.0.1:18790/ws",
        command: "uv run tinybot gateway",
        port: 18790,
        repo_root: "D:/Code/py/tinybot",
        logs: ["stdout: ready"],
        last_error: null,
        exit_policy: "stop_on_exit",
      },
      gatewayActions: {
        onGatewayRuntimeAction: ({ action }) => actionEvents.push(action),
        copyText: (text) => {
          copied.push(text);
        },
      },
    });

    const runtime = targetDocument.body.querySelector(".desktop-gateway-runtime");
    expect(runtime?.querySelectorAll(".desktop-gateway-action").map((action) => action.getAttribute("data-desktop-gateway-action"))).toEqual([
      "stop",
      "restart",
      "keepRunningOnExit",
      "copyDiagnostics",
      "openLogs",
    ]);

    runtime?.querySelector('[data-desktop-gateway-action="stop"]')?.click();
    runtime?.querySelector('[data-desktop-gateway-action="restart"]')?.click();
    runtime?.querySelector('[data-desktop-gateway-action="keepRunningOnExit"]')?.click();
    runtime?.querySelector('[data-desktop-gateway-action="copyDiagnostics"]')?.click();
    runtime?.querySelector('[data-desktop-gateway-action="openLogs"]')?.click();

    expect(actionEvents).toEqual(["stop", "restart", "keepRunningOnExit"]);
    expect(copied[0]).toContain("Command: uv run tinybot gateway");
    expect(copied[0]).toContain("stdout: ready");
    expect(targetDocument.body.querySelector('[data-workbench-region="inspector"]')?.textContent).toContain("Gateway Logs");
    expect(targetDocument.body.querySelector('[data-workbench-region="inspector"]')?.textContent).toContain("stdout: ready");
  });

  test("updates the installed task center surface from refreshed projections", () => {
    const targetDocument = new FakeDocument();

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: {
        ...createDefaultWorkbenchLayout(),
        bottom: { visible: true, size: 260 },
      },
      gatewayHttp: "http://127.0.0.1:18790",
    });

    updateDesktopTaskCenterItems(targetDocument as unknown as Document, buildDesktopTaskCenterItems({
      knowledgeJobs: [
        {
          id: "knowledge:kjob-1",
          title: "Index desktop-notes.md",
          status: "indexing",
          detail: "Indexing retrieval vectors",
          progress: { completed: 2, total: 5 },
          canonical: { module: "knowledge", entityId: "doc-1", href: "/knowledge" },
        },
      ],
    }));

    const rows = targetDocument.body.querySelectorAll(".desktop-task-center-item");
    expect(rows.map((row) => row.getAttribute("data-desktop-task-id"))).toEqual(["knowledge:kjob-1"]);
    expect(targetDocument.getElementById("desktop-task-center")?.textContent).toContain("Index desktop-notes.md");
    expect(targetDocument.getElementById("desktop-task-center")?.textContent).toContain("2/5");
  });

  test("handles task actions only from valid projected controls", () => {
    const targetDocument = new FakeDocument();
    const actionEvents: string[] = [];
    const copied: string[] = [];
    const taskCenterItems = buildDesktopTaskCenterItems({
      fileOperations: [
        {
          id: "file:workspace:AGENTS.md:save",
          title: "Save AGENTS.md",
          status: "failed",
          detail: "Save conflict",
          canonical: { module: "workspace", entityId: "AGENTS.md", href: "/workspace" },
          retryable: true,
          diagnostics: "HTTP 409",
        },
      ],
      chatStreams: [
        {
          id: "chat:stream:chat-1",
          title: "Streaming response",
          status: "streaming",
          detail: "Generating answer",
          canonical: { module: "chat", entityId: "chat-1", href: "/chat/chat-1" },
          cancelable: true,
        },
      ],
      providerRefreshes: [
        {
          id: "provider:openai",
          title: "Refresh OpenAI models",
          status: "completed",
          detail: "24 models loaded",
          canonical: { module: "settings", entityId: "openai", href: "/settings" },
        },
      ],
    });

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: {
        ...createDefaultWorkbenchLayout(),
        bottom: { visible: true, size: 260 },
      },
      gatewayHttp: "http://127.0.0.1:18790",
      taskCenterItems,
      taskActions: {
        onTaskAction: ({ action, item }) => actionEvents.push(`${action}:${item.id}`),
        copyText: (text) => {
          copied.push(text);
        },
      },
    });

    const failedRow = targetDocument.body.querySelector('[data-desktop-task-id="file:workspace:AGENTS.md:save"]');
    failedRow?.querySelector('[data-desktop-task-action="retry"]')?.click();
    failedRow?.querySelector('[data-desktop-task-action="copyDiagnostics"]')?.click();
    failedRow?.querySelector('[data-desktop-task-action="inspect"]')?.click();
    expect(actionEvents).toContain("retry:file:workspace:AGENTS.md:save");
    expect(actionEvents).toContain("copyDiagnostics:file:workspace:AGENTS.md:save");
    expect(copied).toEqual(["HTTP 409"]);
    expect(targetDocument.body.querySelector('[data-workbench-region="inspector"]')?.textContent).toContain("Save AGENTS.md");
    expect(targetDocument.body.querySelector('[data-workbench-region="inspector"]')?.textContent).toContain("HTTP 409");

    const activeRow = targetDocument.body.querySelector('[data-desktop-task-id="chat:stream:chat-1"]');
    expect(activeRow?.querySelector('[data-desktop-task-action="dismiss"]')).toBeNull();
    activeRow?.querySelector('[data-desktop-task-action="cancel"]')?.click();
    expect(actionEvents).toContain("cancel:chat:stream:chat-1");

    const completedRow = targetDocument.body.querySelector('[data-desktop-task-id="provider:openai"]');
    expect(completedRow?.querySelector('[data-desktop-task-action="copyDiagnostics"]')).toBeNull();
    completedRow?.querySelector('[data-desktop-task-action="dismiss"]')?.click();
    expect(actionEvents).toContain("dismiss:provider:openai");
    expect(targetDocument.body.querySelector('[data-desktop-task-id="provider:openai"]')).toBeNull();
  });

  test("renders a desktop workspace file surface with recent files and save affordances", () => {
    const targetDocument = new FakeDocument();

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
    });

    expect(targetDocument.getElementById("desktop-workspace-recent-files")?.getAttribute("aria-label")).toBe("Recent workspace files");
    expect(targetDocument.getElementById("desktop-workspace-status")?.textContent).toContain("0 files");
    expect(targetDocument.getElementById("desktop-workspace-active-path")?.textContent).toContain("No workspace file selected");
    expect(targetDocument.getElementById("desktop-workspace-updated-at")?.textContent).toContain("No timestamp");
    expect(targetDocument.getElementById("desktop-workspace-detail")?.textContent).toContain("No workspace file selected");
    expect(targetDocument.getElementById("desktop-workspace-editor")?.getAttribute("aria-label")).toBe("Workspace file editor");
    expect(targetDocument.getElementById("desktop-workspace-save")?.getAttribute("disabled")).toBe("");
    expect(targetDocument.getElementById("desktop-workspace-reveal")?.getAttribute("disabled")).toBe("");
    expect(targetDocument.getElementById("desktop-workspace-export")?.getAttribute("disabled")).toBe("");
    expect(targetDocument.getElementById("desktop-workspace-save-state")?.textContent).toContain("Select a workspace file");
    expect(targetDocument.getElementById("desktop-workspace-error")?.textContent).toBe("");
  });

  test("allows the main work area to shrink when the inspector is collapsed", () => {
    const targetDocument = new FakeDocument();

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: {
        ...createDefaultWorkbenchLayout(),
        inspector: { visible: false, size: 360 },
      },
      gatewayHttp: "http://127.0.0.1:18790",
    });

    expect(targetDocument.getElementById("desktop-workbench-shell")?.getAttribute("data-inspector-visible")).toBe("false");
    expect(targetDocument.head.querySelector("#desktop-workbench-shell-style")?.textContent).toContain(
      "minmax(0, 1fr) 0",
    );
  });

  test("collapses secondary panes at the minimum desktop width", () => {
    const targetDocument = new FakeDocument();

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
    });

    const styleText = targetDocument.head.querySelector("#desktop-workbench-shell-style")?.textContent;
    expect(styleText).toContain("@media (max-width: 760px)");
    expect(styleText).toContain("grid-template-columns: 52px 0 minmax(0, 1fr) 0;");
    expect(styleText).toContain("body.desktop-native-workbench .desktop-workbench-sidebar");
  });

  test("pins workbench regions to stable grid columns", () => {
    const targetDocument = new FakeDocument();

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
    });

    const styleText = targetDocument.head.querySelector("#desktop-workbench-shell-style")?.textContent;
    expect(styleText).toContain("grid-column: 1;");
    expect(styleText).toContain("grid-column: 2;");
    expect(styleText).toContain("grid-column: 3;");
    expect(styleText).toContain("grid-column: 4;");
  });

  test("allows dense empty-session text to wrap within narrow work areas", () => {
    const targetDocument = new FakeDocument();

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
    });

    const styleText = targetDocument.head.querySelector("#desktop-workbench-shell-style")?.textContent;
    expect(styleText).toContain("overflow-wrap: anywhere;");
    expect(styleText).toContain("min-width: 0;");
  });

  test("styles module running-work rows as compact selectable desktop controls", () => {
    const targetDocument = new FakeDocument();

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
    });

    const styleText = targetDocument.head.querySelector("#desktop-workbench-shell-style")?.textContent;
    expect(styleText).toContain(".desktop-module-work-row");
    expect(styleText).toContain("min-height: 34px;");
    expect(styleText).toContain("overflow-wrap: anywhere;");
  });

  test("declares visible focus states for workbench controls", () => {
    const targetDocument = new FakeDocument();

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
    });

    const styleText = targetDocument.head.querySelector("#desktop-workbench-shell-style")?.textContent;
    expect(styleText).toContain(".desktop-panel-control:focus-visible");
    expect(styleText).toContain(".desktop-file-action:focus-visible");
    expect(styleText).toContain(".desktop-help-action:focus-visible");
    expect(styleText).toContain(".desktop-session-upload-key:focus-visible");
    expect(styleText).toContain(".desktop-workspace-file-row:focus-visible");
    expect(styleText).toContain(".desktop-workspace-editor:focus-visible");
  });

  test("declares DESIGN.md-aligned desktop surface tokens", () => {
    const targetDocument = new FakeDocument();

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
    });

    const styleText = targetDocument.head.querySelector("#desktop-workbench-shell-style")?.textContent;
    expect(styleText).toContain("--bg: #faf9f5;");
    expect(styleText).toContain("--panel-strong: #efe9de;");
    expect(styleText).toContain("--primary: #cc785c;");
    expect(styleText).toContain("--surface-dark: #181715;");
    expect(styleText).toContain("--border: #e6dfd8;");
    expect(styleText).toContain('--font-display: "Tiempos Headline"');
  });

  test("uses dark product surfaces for runtime diagnostics", () => {
    const targetDocument = new FakeDocument();

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
    });

    const styleText = targetDocument.head.querySelector("#desktop-workbench-shell-style")?.textContent;
    expect(styleText).toContain(".desktop-gateway-runtime");
    expect(styleText).toContain("background: var(--surface-dark, #181715);");
    expect(styleText).toContain(".desktop-task-center-diagnostics:not(:empty)");
    expect(styleText).toContain(".desktop-run-chain-detail");
    expect(styleText).toContain("background: var(--surface-dark-soft, #1f1e1b);");
  });

  test("styles the task center as a constrained keyboard-accessible bottom surface", () => {
    const targetDocument = new FakeDocument();

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
    });

    const styleText = targetDocument.head.querySelector("#desktop-workbench-shell-style")?.textContent;
    expect(styleText).toContain(".desktop-task-center-list");
    expect(styleText).toContain("max-height: 148px;");
    expect(styleText).toContain('.desktop-task-center-item[data-desktop-task-state="failed"]');
    expect(styleText).toContain(".desktop-task-action:focus-visible");
  });

  test("keeps empty-session support copy concise for minimum windows", () => {
    const targetDocument = new FakeDocument();

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
    });

    expect(targetDocument.body.querySelector(".desktop-empty-session")?.textContent).not.toContain("without leaving");
    expect(targetDocument.body.querySelector(".desktop-empty-session")?.textContent).toContain(
      "Start from chat, inspect workspace, or check gateway status.",
    );
  });
});
