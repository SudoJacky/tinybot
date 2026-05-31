import { describe, expect, test } from "vitest";
import { buildDesktopTaskCenterItems } from "./desktopTaskCenter";
import { createDefaultWorkbenchLayout } from "./desktopWorkbenchLayout";
import { installDesktopWorkbenchShell, updateDesktopTaskCenterItems } from "./desktopWorkbenchShell";

class FakeElement {
  public id = "";
  public className = "";
  public children: FakeElement[] = [];
  public attributes = new Map<string, string>();
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

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName);
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
      "/docs",
      "https://github.com/SudoJacky/tinybot",
    ]);
    expect(targetDocument.body.querySelector(".desktop-status-strip")?.getAttribute("data-desktop-route-status")).toBe("");
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
      "copyDiagnostics",
      "openLogs",
    ]);

    runtime?.querySelector('[data-desktop-gateway-action="stop"]')?.click();
    runtime?.querySelector('[data-desktop-gateway-action="restart"]')?.click();
    runtime?.querySelector('[data-desktop-gateway-action="copyDiagnostics"]')?.click();
    runtime?.querySelector('[data-desktop-gateway-action="openLogs"]')?.click();

    expect(actionEvents).toEqual(["stop", "restart"]);
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
    expect(targetDocument.getElementById("desktop-workspace-active-path")?.textContent).toContain("No workspace file selected");
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
    expect(styleText).toContain(".desktop-session-upload-key:focus-visible");
    expect(styleText).toContain(".desktop-workspace-file-row:focus-visible");
    expect(styleText).toContain(".desktop-workspace-editor:focus-visible");
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
