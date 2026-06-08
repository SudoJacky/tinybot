import { describe, expect, test } from "vitest";
import { buildDesktopCoworkCockpitView, buildDesktopCoworkSessionRows } from "./desktopCowork";
import { buildDesktopKnowledgePaneModel } from "./desktopKnowledgeTraceability";
import { buildDesktopRunChainItems } from "./desktopRunChainInspector";
import { buildDesktopSettingsFormState, buildDesktopSettingsPaneModel } from "./desktopSettingsProviders";
import { buildDesktopTaskCenterItems } from "./desktopTaskCenter";
import { buildDesktopToolsSkillsPaneModel } from "./desktopToolsSkills";
import { buildDesktopWorkLensProjection } from "./desktopWorkLens";
import { createDefaultWorkbenchLayout } from "./desktopWorkbenchLayout";
import { installDesktopWorkbenchShell, updateDesktopNativeChat, updateDesktopSettingsPane, updateDesktopTaskCenterItems, updateDesktopToolsSkillsPane } from "./desktopWorkbenchShell";
import type { NativeChatMessage, NativeChatSession } from "./nativeChat";

class FakeElement {
  public id = "";
  public className = "";
  public children: FakeElement[] = [];
  public attributes = new Map<string, string>();
  public value = "";
  public checked = false;
  public disabled = false;
  public hidden = false;
  public innerHTML = "";
  private listeners = new Map<string, ((event: unknown) => void)[]>();
  private ownTextContent = "";
  public style = {
    values: new Map<string, string>(),
    setProperty: (name: string, value: string) => {
      this.style.values.set(name, value);
    },
  };

  constructor(public readonly tagName: string, private readonly ownerDocument?: FakeDocument) {}

  set textContent(value: string) {
    this.ownTextContent = value;
  }

  get textContent(): string {
    return `${this.ownTextContent}${this.innerHTML}${this.children.map((child) => child.textContent).join("")}`;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === "id") {
      this.id = value;
    }
    if (name === "disabled") {
      this.disabled = true;
    }
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
    if (name === "disabled") {
      this.disabled = false;
    }
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

  focus(): void {
    if (this.ownerDocument) {
      this.ownerDocument.activeElement = this;
    }
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

  constructor(ownerDocument: FakeDocument) {
    super("body", ownerDocument);
  }
}

class FakeHead extends FakeElement {
  constructor(ownerDocument: FakeDocument) {
    super("head", ownerDocument);
  }
}

class FakeDocument {
  public body: FakeBody;
  public head: FakeHead;
  public activeElement: FakeElement | null = null;
  public listeners = new Map<string, ((event: unknown) => void)[]>();

  constructor() {
    this.body = new FakeBody(this);
    this.head = new FakeHead(this);
  }

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName, this);
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

function findEntityRow(root: FakeElement | null | undefined, module: string, entityId: string): FakeElement | undefined {
  return root
    ?.querySelectorAll(`[data-desktop-entity-module="${module}"]`)
    .find((row) => row.getAttribute("data-desktop-entity-id") === entityId);
}

describe("desktop workbench shell", () => {
  test("renders persistent desktop regions from layout state", () => {
    const targetDocument = new FakeDocument();

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
      chat: {
        sessions: [{ key: "WebSocket:chat-live", chatId: "chat-live", title: "Live session", createdAt: "", updatedAt: "" }],
        activeSessionKey: "WebSocket:chat-live",
        activeChatId: "chat-live",
        messages: [],
      },
    });

    expect(targetDocument.body.classList.values.has("desktop-native-workbench")).toBe(true);
    const shell = targetDocument.getElementById("desktop-workbench-shell");
    expect(shell).toBeTruthy();
    expect(shell?.style.values.get("--desktop-sidebar-size")).toBe("260px");
    expect(shell?.style.values.get("--desktop-inspector-size")).toBe("360px");
    expect(shell?.style.values.get("--desktop-bottom-size")).toBe("220px");
    expect(shell?.getAttribute("data-inspector-visible")).toBe("false");
    expect(shell?.getAttribute("data-bottom-visible")).toBe("false");
    expect(targetDocument.body.querySelector('[data-workbench-region="activity"]')).toBeTruthy();
    expect(targetDocument.body.querySelector('[data-workbench-region="sidebar"]')?.style.values.get("--region-size")).toBe("260px");
    expect(targetDocument.body.querySelector('[data-workbench-region="main"]')).toBeTruthy();
    expect(targetDocument.body.querySelector('[data-workbench-region="inspector"]')?.style.values.get("--region-size")).toBe("360px");
    expect(targetDocument.body.querySelector('[data-workbench-region="bottom"]')?.getAttribute("data-visible")).toBe("false");
    expect(targetDocument.head.querySelector("#desktop-design-tokens")).toBeTruthy();
    expect(targetDocument.head.querySelector("#desktop-workbench-shell-style")).toBeTruthy();
    const styleText = targetDocument.head.querySelector("#desktop-workbench-shell-style")?.textContent ?? "";
    expect(styleText).toContain(".desktop-workbench-shell {\n      height: 100vh;");
    expect(styleText).not.toContain("height: calc(100vh - var(--desktop-window-frame-height");
  });

  test("renders dense empty-chat context instead of a browser-style blank page", () => {
    const targetDocument = new FakeDocument();

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
      chat: {
        sessions: [{ key: "WebSocket:chat-live", chatId: "chat-live", title: "Live session", createdAt: "", updatedAt: "" }],
        activeSessionKey: "WebSocket:chat-live",
        activeChatId: "chat-live",
        messages: [],
      },
    });

    expect(targetDocument.body.querySelector(".desktop-chat-workbench-chrome")?.textContent).toContain("Start a new session");
    expect(targetDocument.body.querySelector(".desktop-chat-workbench-chrome")?.textContent).toContain("Ask Tinybot about the workspace, inspect files, or create a task.");
    expect(targetDocument.body.querySelector(".desktop-empty-session")?.textContent).not.toContain("sessionStart");
    expect(targetDocument.body.querySelector(".desktop-empty-session")?.textContent).not.toContain("session.Start");
    expect(targetDocument.body.querySelector(".desktop-quick-actions")).toBeNull();
    expect(targetDocument.body.querySelectorAll(".desktop-quick-action")).toHaveLength(0);
    expect(targetDocument.body.querySelector(".desktop-panel-controls")).toBeNull();
    expect(targetDocument.body.querySelector(".desktop-status-strip")?.textContent).toContain("http://127.0.0.1:18790");
  });

  test("renders live native chat and sidebar state instead of static shell examples", () => {
    const targetDocument = new FakeDocument();
    const deletedSessions: string[] = [];
    const sessions: NativeChatSession[] = [
      {
        key: "WebSocket:chat-live",
        chatId: "chat-live",
        title: "Live gateway session",
        createdAt: "2026-06-03T08:00:00.000Z",
        updatedAt: "2026-06-03T08:10:00.000Z",
      },
    ];
    const messages: NativeChatMessage[] = [
      {
        role: "user",
        content: "Please summarize the live runtime state.",
        reasoningContent: "",
        timestamp: "2026-06-03T08:09:00.000Z",
        messageId: "user-1",
      },
      {
        role: "assistant",
        content: "The native workbench is rendering gateway data.",
        reasoningContent: "Checked active session metadata.",
        references: [{ kind: "reference", title: "docs/desktop.md", detail: "read_file" }],
        toolActivities: [{
          argsText: "shell command",
          approvalStatus: "approval_required",
          id: "tool-shell",
          kind: "call",
          name: "shell",
          responseText: "",
        }],
        timestamp: "2026-06-03T08:10:00.000Z",
        messageId: "assistant-1",
      },
    ];

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
      chatActions: {
        onDeleteSession: (event) => deletedSessions.push(event.sessionKey),
      },
      chat: {
        sessions,
        activeSessionKey: "WebSocket:chat-live",
        activeChatId: "chat-live",
        messages,
        status: "Loaded from gateway",
        responding: true,
        usePersistentRag: false,
      },
    });

    const shellText = targetDocument.body.textContent;
    expect(shellText).toContain("Live gateway session");
    expect(shellText).toContain("Please summarize the live runtime state.");
    expect(shellText).toContain("The native workbench is rendering gateway data.");
    expect(shellText).toContain("Checked active session metadata.");
    expect(shellText).toContain("reference: docs/desktop.md");
    expect(shellText).toContain("docs/desktop.md");
    expect(shellText).not.toContain("Loaded from gateway");
    expect(shellText).not.toContain("Design native workbench");
    expect(shellText).not.toContain("tinybot_native_workbench_design.png");
    expect(shellText).not.toContain("ai-rvc");

    const recentChat = targetDocument.body.querySelector('[data-desktop-entity-id="chat-live"]');
    expect(recentChat?.getAttribute("data-desktop-entity-module")).toBe("chat");
    expect(recentChat?.getAttribute("href")).toBe("/chat/chat-live");
    const recentChatRow = targetDocument.body.querySelector(".desktop-sidebar-chat-row");
    expect(recentChatRow?.getAttribute("role")).toBe("listitem");
    expect(recentChatRow?.getAttribute("data-active")).toBe("true");
    expect(recentChatRow?.querySelector(".desktop-sidebar-row-status")).toBeNull();
    expect(recentChatRow?.textContent).not.toContain("Running");
    expect(recentChatRow?.textContent).not.toContain("Approval");
    expect(recentChatRow?.textContent).not.toContain("Knowledge Off");
    const deleteButton = targetDocument.body.querySelector('[data-desktop-chat-delete="WebSocket:chat-live"]');
    expect(recentChatRow?.querySelector('[data-desktop-chat-delete="WebSocket:chat-live"]')).toBe(deleteButton);
    expect(deleteButton?.getAttribute("aria-label")).toBe("Delete chat Live gateway session");
    expect(deleteButton?.textContent).toBe("x");
    deleteButton?.click();
    expect(deletedSessions).toEqual([]);
    expect(deleteButton?.getAttribute("aria-label")).toBe("Confirm delete chat Live gateway session");
    expect(deleteButton?.textContent).toBe("Confirm");
    deleteButton?.click();
    expect(deleteButton?.getAttribute("data-deleting")).toBe("true");
    expect(deleteButton?.getAttribute("disabled")).toBe("");
    expect(deleteButton?.textContent).toBe("Deleting");
    expect(deletedSessions).toEqual(["WebSocket:chat-live"]);
  });

  test("updates native chat regions without reinstalling the whole workbench", () => {
    const targetDocument = new FakeDocument();

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
      chat: {
        sessions: [{
          key: "WebSocket:chat-live",
          chatId: "chat-live",
          title: "Initial live session",
          createdAt: "",
          updatedAt: "",
        }],
        activeSessionKey: "WebSocket:chat-live",
        activeChatId: "chat-live",
        messages: [],
        status: "Initial status",
      },
    });
    const shell = targetDocument.getElementById("desktop-workbench-shell");

    updateDesktopNativeChat(targetDocument as unknown as Document, {
      sessions: [{
        key: "WebSocket:chat-live",
        chatId: "chat-live",
        title: "Updated live session",
        createdAt: "",
        updatedAt: "2026-06-03T08:20:00.000Z",
      }],
      activeSessionKey: "WebSocket:chat-live",
      activeChatId: "chat-live",
      messages: [{
        role: "assistant",
        content: "Updated without full shell reinstall.",
        reasoningContent: "",
        timestamp: "2026-06-03T08:20:00.000Z",
        messageId: "assistant-2",
      }],
      status: "Updated status",
      responding: true,
      usePersistentRag: false,
      composerState: "queued",
    });

    expect(targetDocument.getElementById("desktop-workbench-shell")).toBe(shell);
    expect(targetDocument.body.textContent).toContain("Updated live session");
    expect(targetDocument.body.textContent).toContain("Updated without full shell reinstall.");
    expect(targetDocument.body.textContent).not.toContain("Ready for a new session");
    expect(targetDocument.body.querySelector(".desktop-chat-workbench-chrome")).toBeNull();
    expect(targetDocument.body.textContent).not.toContain("Updated status");
    expect(targetDocument.getElementById("desktop-native-composer")?.getAttribute("data-desktop-composer-responding")).toBe("true");
    expect(targetDocument.getElementById("desktop-native-composer")?.getAttribute("data-desktop-composer-rag")).toBe("false");
    expect(targetDocument.getElementById("desktop-native-composer")?.getAttribute("data-desktop-composer-state")).toBe("queued");
    expect(targetDocument.getElementById("desktop-native-composer-send")?.getAttribute("disabled")).toBe("");
    expect(targetDocument.getElementById("desktop-native-composer-runtime")?.textContent).toContain("Tinybot Pro");
    expect(targetDocument.body.querySelector(".desktop-native-token-orb")?.getAttribute("data-token-usage")).toBe("0");
    expect(targetDocument.getElementById("desktop-session-upload-key")?.value).toBe("WebSocket:chat-live");
    expect(targetDocument.getElementById("desktop-session-upload-key")?.getAttribute("data-active-session-key")).toBe("WebSocket:chat-live");
    expect(targetDocument.getElementById("desktop-session-file-list")?.textContent).toContain("Temporary files");
  });

  test("renders native conversation messages without fake avatars and with assistant markdown", () => {
    const targetDocument = new FakeDocument();

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
      chat: {
        sessions: [{
          key: "WebSocket:chat-live",
          chatId: "chat-live",
          title: "Markdown chat",
          createdAt: "",
          updatedAt: "",
        }],
        activeSessionKey: "WebSocket:chat-live",
        activeChatId: "chat-live",
        messages: [
          {
            role: "user",
            content: "<img src=x onerror=alert(1)>",
            reasoningContent: "",
            timestamp: "2026-06-03T08:19:00.000Z",
            messageId: "user-1",
          },
          {
            role: "assistant",
            content: [
              "Here is a list:",
              "",
              "- first",
              "",
              "```ts",
              "const answer = 42;",
              "```",
              "",
              "[Open docs](https://example.test/docs)",
            ].join("\n"),
            reasoningContent: "",
            timestamp: "2026-06-03T08:20:00.000Z",
            messageId: "assistant-1",
          },
        ],
        status: "Connected",
      },
    });

    const thread = targetDocument.body.querySelector(".desktop-conversation-thread");
    const messages = thread?.querySelectorAll(".desktop-conversation-message") ?? [];
    expect(thread?.querySelector(".desktop-conversation-avatar")).toBeNull();
    expect(messages).toHaveLength(2);
    expect(targetDocument.body.textContent).not.toContain("Ready for a new session");
    expect(targetDocument.body.querySelector(".desktop-chat-workbench-chrome")).toBeNull();

    const userBody = messages[0].querySelector(".desktop-conversation-body");
    expect(userBody?.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(userBody?.innerHTML).toBe("");

    const assistantBody = messages[1].querySelector(".desktop-conversation-body");
    expect(assistantBody?.innerHTML).toContain("<ul>");
    expect(assistantBody?.innerHTML).toContain("<code");
    expect(assistantBody?.innerHTML).toContain('href="https://example.test/docs"');
    expect(assistantBody?.innerHTML).toContain('target="_blank"');
    expect(assistantBody?.innerHTML).toContain('rel="noreferrer"');
  });

  test("renders native reasoning and tool activities as interactive middle conversation blocks", () => {
    const targetDocument = new FakeDocument();

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
      chat: {
        sessions: [{
          key: "WebSocket:chat-live",
          chatId: "chat-live",
          title: "Tool chat",
          createdAt: "",
          updatedAt: "",
        }],
        activeSessionKey: "WebSocket:chat-live",
        activeChatId: "chat-live",
        messages: [
          {
            role: "assistant",
            content: "The command finished.",
            reasoningContent: "I should inspect the workspace first.",
            toolActivities: [
              {
                id: "call-shell",
                name: "shell",
                argsText: "{\"command\":\"pwd\"}",
                responseText: "D:/code/tinybot/tinybot",
                kind: "result",
              },
            ],
            timestamp: "2026-06-03T08:20:00.000Z",
            messageId: "assistant-1",
          },
        ],
        status: "Connected",
      },
    });

    const message = targetDocument.body.querySelector(".desktop-conversation-message");
    const thread = targetDocument.body.querySelector(".desktop-conversation-thread");
    const reasoning = message?.querySelector(".desktop-message-reasoning");
    const toolActivity = message?.querySelector(".desktop-tool-activity");
    const body = message?.querySelector(".desktop-conversation-body");

    expect(thread?.getAttribute("aria-label")).toBe("Message Timeline");
    expect(thread?.getAttribute("data-desktop-chat-region")).toBe("message-timeline");
    expect(thread?.getAttribute("role")).toBe("log");
    expect(thread?.getAttribute("aria-live")).toBe("polite");
    expect(message?.querySelector(".desktop-conversation-header")?.querySelector(".desktop-conversation-meta")?.textContent).toContain("Tinybot");
    expect(reasoning?.querySelector(".desktop-message-reasoning-summary")?.textContent).toBe("Thinking complete");
    expect(message?.querySelector(".desktop-conversation-content")?.children[1]).toBe(reasoning);
    expect(reasoning?.tagName).toBe("details");
    expect(reasoning?.querySelector(".desktop-message-reasoning-title")).toBeNull();
    expect(reasoning?.textContent).toContain("I should inspect the workspace first.");
    expect(message?.querySelector(".desktop-tool-activities")?.getAttribute("data-desktop-chat-region")).toBe("tool-timeline");
    expect(message?.querySelector(".desktop-tool-activities")?.getAttribute("aria-label")).toBe("Tool Timeline");
    expect(toolActivity?.tagName).toBe("div");
    expect(toolActivity?.querySelector(".desktop-tool-activity-row")?.getAttribute("aria-label")).toBe("Open shell tool details, Pending");
    expect(toolActivity?.querySelector(".desktop-tool-activity-title")?.textContent).toBe("shell");
    expect(toolActivity?.querySelector(".desktop-tool-activity-kind")?.textContent).toBe("Tool");
    expect(toolActivity?.querySelector(".desktop-tool-activity-status-label")?.textContent).toBe("Pending");
    expect(toolActivity?.textContent).not.toContain("{\"command\":\"pwd\"}");
    expect(toolActivity?.textContent).not.toContain("D:/code/tinybot/tinybot");
    expect(body?.textContent).not.toContain("I should inspect the workspace first.");
    expect(body?.textContent).toContain("The command finished.");
  });

  test("renders standalone native tool results without duplicating response text as message body", () => {
    const targetDocument = new FakeDocument();

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
      chat: {
        sessions: [{
          key: "WebSocket:chat-live",
          chatId: "chat-live",
          title: "Tool result chat",
          createdAt: "",
          updatedAt: "",
        }],
        activeSessionKey: "WebSocket:chat-live",
        activeChatId: "chat-live",
        messages: [
          {
            role: "tool",
            content: "stdout: done",
            reasoningContent: "",
            toolActivities: [
              {
                id: "call-shell",
                name: "shell",
                argsText: "",
                responseText: "stdout: done",
                kind: "result",
              },
            ],
            timestamp: "2026-06-03T08:20:00.000Z",
            messageId: "tool-1",
          },
        ],
        status: "Connected",
      },
    });

    const message = targetDocument.body.querySelector(".desktop-conversation-message");
    expect(message?.querySelector(".desktop-tool-activity")?.textContent).not.toContain("stdout: done");
    expect(message?.querySelector(".desktop-tool-activity-title")?.textContent).toBe("shell");
    expect(message?.querySelector(".desktop-conversation-body")?.textContent).not.toContain("stdout: done");
  });

  test("routes native composer send and temporary file attach actions", () => {
    const targetDocument = new FakeDocument();
    const composerActions: string[] = [];

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
      chat: {
        sessions: [{ key: "WebSocket:chat-live", chatId: "chat-live", title: "Live session", createdAt: "", updatedAt: "" }],
        activeSessionKey: "WebSocket:chat-live",
        activeChatId: "chat-live",
        messages: [],
        responding: false,
        usePersistentRag: false,
      },
      chatActions: {
        onComposerSubmit: (event) => {
          composerActions.push(`send:${event.content}:${event.usePersistentRag}`);
        },
        onAttachSessionFile: () => {
          composerActions.push("attach");
        },
        onPersistentRagChange: (enabled) => {
          composerActions.push(`rag:${enabled}`);
        },
      },
    });

    const input = targetDocument.getElementById("desktop-native-composer-input");
    const send = targetDocument.getElementById("desktop-native-composer-send");
    expect(send?.getAttribute("disabled")).toBe("");
    send?.click();
    expect(composerActions).toEqual([]);
    input!.value = "Run live composer";
    input!.dispatchEvent({ type: "input" });
    expect(send?.getAttribute("disabled")).toBeNull();
    expect(targetDocument.getElementById("desktop-native-composer-stop")).toBeNull();
    send?.click();
    input!.value = "   ";
    input!.dispatchEvent({ type: "input" });
    expect(send?.getAttribute("disabled")).toBe("");
    send?.click();
    targetDocument.body.querySelector('[data-desktop-composer-action="attach"]')?.click();
    const ragToggle = targetDocument.body.querySelector('[data-desktop-composer-action="rag-toggle"]');
    expect(ragToggle?.getAttribute("aria-pressed")).toBe("false");
    ragToggle?.click();

    expect(composerActions).toEqual(["send:Run live composer:false", "attach", "rag:true"]);
  });

  test("styles native composer input without focus chrome or manual resizing", () => {
    const targetDocument = new FakeDocument();

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
      chat: {
        sessions: [{ key: "WebSocket:chat-live", chatId: "chat-live", title: "Live session", createdAt: "", updatedAt: "" }],
        activeSessionKey: "WebSocket:chat-live",
        activeChatId: "chat-live",
        messages: [],
      },
    });

    const styleText = targetDocument.head.querySelector("#desktop-workbench-shell-style")?.textContent ?? "";
    expect(styleText).toContain(".desktop-native-composer-input:focus-visible {\n      outline: 0;");
    expect(styleText).toContain("resize: none;");
    expect(styleText).toContain("max-height: calc(24px * 3);");
    expect(styleText).toContain("overflow-y: auto;");
    expect(styleText).toContain("scrollbar-gutter: stable;");
    expect(styleText).not.toContain(".desktop-native-composer-input:focus-visible,\n    body.desktop-native-workbench .desktop-native-composer-action:focus-visible");
    expect(styleText).toContain(".desktop-native-composer-send:not(:disabled)");
    expect(styleText).toContain("width: 36px;\n      min-width: 36px;\n      height: 36px;\n      min-height: 36px;");
    expect(styleText).toContain(".desktop-native-token-orb {\n      width: 36px;\n      height: 36px;");
    expect(styleText).toContain("min-height: 38px;\n      max-height: none;");
    expect(styleText).toContain("overflow-y: visible;");
    expect(styleText).toContain("gap: 10px 18px;");
    expect(styleText).toContain("gap: 16px;");
    expect(styleText).toContain("border-radius: 999px;");
    expect(styleText).toContain("border: 0;");
    expect(styleText).toContain("box-shadow: none;");
    expect(styleText).toContain("background: transparent;");
    expect(styleText).toContain("background: #fff7ef;");
    expect(styleText).toContain(".desktop-native-composer-model:hover");
    expect(styleText).toContain(".desktop-native-composer-model:focus-visible");
    expect(styleText).toContain(".desktop-native-composer-rag-toggle:hover");
    expect(styleText).toContain('.desktop-native-composer-rag-toggle[aria-pressed="true"]');
    expect(styleText).toContain('.desktop-native-composer-rag-toggle[aria-pressed="false"]:not(:hover):not(:focus-visible)');
    expect(styleText).not.toContain("box-shadow: 0 8px 20px rgba(216, 112, 72, 0.18);");
    expect(styleText).toContain("padding: 14px 8px 8px 14px;");
    expect(styleText).toContain("grid-template-rows: auto auto;");
    expect(styleText).toContain("min-height: 0;");
    expect(styleText).toContain(".desktop-run-chain-tabs {\n      display: flex;");
    expect(styleText).toContain("flex-flow: row nowrap !important;");
    expect(styleText).toContain("overflow-x: auto;");
    expect(styleText).toContain("scrollbar-width: none;");
    expect(styleText).toContain(".desktop-run-chain-tabs .n-space-item {\n      margin-bottom: 0 !important;");
    expect(styleText).toContain(".desktop-run-chain-tabs > * {\n      flex: 0 0 auto;");
    expect(styleText).toMatch(/\.desktop-run-chain-tab \{[\s\S]*?flex: 0 0 auto;[\s\S]*?padding: 0 7px;[\s\S]*?font: 650 11px\/1\.2 var\(--font-sans\);[\s\S]*?white-space: nowrap;/);
    expect(styleText).toContain(".desktop-run-chain-summary-strip {\n      display: flex;");
    expect(styleText).toContain("flex-flow: row nowrap !important;");
    expect(styleText).toContain("overflow-x: auto;");
    expect(styleText).toContain("scrollbar-width: none;");
    expect(styleText).toContain(".desktop-run-chain-summary-strip .n-space-item {\n      margin-bottom: 0 !important;");
    expect(styleText).toContain(".desktop-run-chain-summary-strip > * {\n      flex: 0 0 auto;");
    expect(styleText).toMatch(/\.desktop-run-chain-summary-item \{[\s\S]*?flex: 0 0 auto;[\s\S]*?min-height: 24px;[\s\S]*?padding: 0 7px;[\s\S]*?font: 650 10px\/1\.2 var\(--font-sans\);[\s\S]*?white-space: nowrap;/);
    expect(styleText).not.toContain("grid-template-columns: repeat(3, minmax(0, 1fr));");
    expect(styleText).not.toContain("min-height: 118px;");
    expect(styleText).not.toContain("min-height: 88px;");
    expect(styleText).not.toContain("margin-left: 10px;");
  });

  test("renders compact runtime affordances near the native composer", () => {
    const targetDocument = new FakeDocument();

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
      chat: {
        sessions: [],
        activeSessionKey: "",
        activeChatId: "",
        messages: [],
        runtime: {
          provider: "deepseek",
          model: "deepseek-chat",
          webSocket: "Connected",
          tokenReady: true,
          tokenUsage: "42%",
          gatewayHttp: "http://127.0.0.1:18790",
        },
      },
    });

    expect(targetDocument.body.querySelector(".desktop-native-composer-model")?.textContent).toBe("deepseek-chat");
    const tokenOrb = targetDocument.body.querySelector(".desktop-native-token-orb");
    expect(tokenOrb?.getAttribute("aria-label")).toBe("Token usage 42%");
    expect(tokenOrb?.getAttribute("data-token-usage")).toBe("42");
    expect(tokenOrb?.style.values.get("--token-usage-fill")).toBe("42%");
    expect(targetDocument.getElementById("desktop-native-composer-runtime")?.textContent).not.toContain("Provider:");
    expect(targetDocument.getElementById("desktop-native-composer-runtime")?.textContent).not.toContain("Session:");
    expect(targetDocument.getElementById("desktop-native-composer-runtime")?.textContent).not.toContain("WebSocket:");
    expect(targetDocument.getElementById("desktop-native-composer-runtime")?.textContent).not.toContain("Gateway:");
    expect(targetDocument.getElementById("desktop-native-composer-runtime")?.getAttribute("data-desktop-composer-region")).toBe("runtime-status");
    expect(targetDocument.getElementById("desktop-native-composer-runtime")?.getAttribute("aria-label")).toBe("Runtime status");
  });

  test("renders the native workbench in the latest Codex-style three-column layout", () => {
    const targetDocument = new FakeDocument();

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
      runtimeStatus: {
        state: "running",
        owner: "external",
        http_ok: true,
        gateway_http: "http://127.0.0.1:18790",
        gateway_ws: "ws://127.0.0.1:18790/ws",
        command: "uv run tinybot gateway",
        port: 18790,
        repo_root: "D:/code/tinybot/tinybot",
        logs: [],
        last_error: null,
        exit_policy: "keep_running",
      },
    });

    const primaryAction = targetDocument.body.querySelector(".desktop-sidebar-primary-action");
    const sidebarSearch = targetDocument.body.querySelector(".desktop-sidebar-search");
    const workspaceList = targetDocument.body.querySelector(".desktop-workspace-list");
    const recentChats = targetDocument.body.querySelector(".desktop-recent-chat-list");
    expect(primaryAction).toBeTruthy();
    expect(sidebarSearch).toBeTruthy();
    expect(workspaceList).toBeTruthy();
    expect(recentChats).toBeTruthy();
    expect(primaryAction?.textContent).toContain("New chat");
    expect(sidebarSearch?.getAttribute("placeholder")).toBe("Search");
    expect(workspaceList?.textContent).toContain("tinybot");
    expect(recentChats?.textContent).toContain("Design native workbench");
    const sidebarStyle = targetDocument.head.querySelector("#desktop-workbench-shell-style")?.textContent ?? "";
    expect(sidebarStyle).toContain("flex-direction: column;");
    expect(sidebarStyle).toContain("overflow-y: auto;");
    expect(sidebarStyle).toContain(".desktop-sidebar-list-section-recent");
    expect(sidebarStyle).toContain("max-height: min(42vh, 360px)");

    const chatHeader = targetDocument.body.querySelector(".desktop-chat-header");
    const conversationThread = targetDocument.body.querySelector(".desktop-conversation-thread");
    const composerModel = targetDocument.body.querySelector(".desktop-native-composer-model");
    expect(chatHeader).toBeTruthy();
    expect(conversationThread).toBeTruthy();
    expect(composerModel).toBeTruthy();
    expect(chatHeader?.querySelector(".desktop-chat-context")?.textContent).toBe("tinybot");
    expect(chatHeader?.textContent).toContain("Design native workbench");
    expect(conversationThread?.textContent).toContain("这是目前的 native 界面");
    expect(composerModel?.textContent).toContain("Tinybot Pro");

    const inspector = targetDocument.body.querySelector(".desktop-inspector-content");
    const runTabs = targetDocument.body.querySelector(".desktop-run-chain-tabs");
    const runCards = targetDocument.body.querySelector(".desktop-run-chain-cards");
    expect(inspector).toBeTruthy();
    expect(runTabs).toBeTruthy();
    expect(runCards).toBeTruthy();
    expect(inspector?.textContent).toContain("Activity");
    expect(inspector?.textContent).not.toContain("Run Chain");
    expect(runTabs?.textContent).toBe("ContextFilesTasksApprovalsActivity");
    expect(runCards?.textContent).toContain("Gateway");
    targetDocument.body.querySelector('[data-desktop-run-chain-tab="files"]')?.click();
    expect(runCards?.textContent).toContain("Files");
    expect(targetDocument.body.querySelectorAll(".desktop-run-chain-new-item")).toHaveLength(0);
    targetDocument.body.querySelector('[data-desktop-run-chain-tab="tasks"]')?.click();
    const runNewItem = targetDocument.body.querySelector(".desktop-run-chain-new-item");
    expect(runNewItem?.textContent).toContain("New Activity Item");
    expect(runCards?.textContent).toContain("No chain items yet.");
    targetDocument.body.querySelector('[data-desktop-run-chain-tab="approvals"]')?.click();
    expect(runCards?.textContent).toContain("Approvals");
    expect(runCards?.textContent).toContain("No pending approvals");
    targetDocument.body.querySelector('[data-desktop-run-chain-tab="activity"]')?.click();
    expect(runCards?.textContent).toContain("Activity Feed");
    expect(runCards?.textContent).toContain("Gateway events, tool calls, and runtime logs appear here.");
  });

  test("renders explicit desktop navigation links for workbench, docs, gateway, and external routes", () => {
    const targetDocument = new FakeDocument();
    const chat = {
      sessions: [{ key: "WebSocket:chat-live", chatId: "chat-live", title: "Live session", createdAt: "", updatedAt: "" }],
      activeSessionKey: "WebSocket:chat-live",
      activeChatId: "chat-live",
      messages: [],
    };

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
      chat,
    });

    expect(targetDocument.body.querySelectorAll(".desktop-activity-button").map((node) => node.getAttribute("href"))).toEqual([
      "/chat",
      "/files",
      "/knowledge",
      "/cowork",
      "/docs",
      "https://github.com/SudoJacky/tinybot",
    ]);
    expect([
      ...targetDocument.body.querySelectorAll(".desktop-activity-button"),
      ...targetDocument.body.querySelectorAll(".desktop-activity-secondary-button"),
    ].filter((node) => node.getAttribute("href") === "/files")).toHaveLength(1);
    expect(targetDocument.body.querySelectorAll(".desktop-quick-action")).toHaveLength(0);
    expect(targetDocument.body.querySelectorAll(".desktop-workbench-link")).toHaveLength(0);
    expect(targetDocument.body.querySelectorAll("[data-sidebar-command]")).toHaveLength(0);
    expect(targetDocument.body.querySelector(".desktop-status-strip")?.getAttribute("data-desktop-route-status")).toBe("");
  });

  test("keeps resource and system navigation out of the native sidebar", () => {
    const targetDocument = new FakeDocument();

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
      chat: {
        sessions: [{ key: "WebSocket:chat-live", chatId: "chat-live", title: "Live session", createdAt: "", updatedAt: "" }],
        activeSessionKey: "WebSocket:chat-live",
        activeChatId: "chat-live",
        messages: [],
      },
    });

    expect(targetDocument.body.querySelector(".desktop-sidebar-list-section-workspaces")?.textContent).toContain("tinybot");
    expect(targetDocument.body.querySelector(".desktop-sidebar-list-section-recent")?.textContent).toContain("Live session");
    expect(targetDocument.body.querySelectorAll(".desktop-workbench-link")).toHaveLength(0);
    expect(targetDocument.body.querySelectorAll("[data-sidebar-command]")).toHaveLength(0);
    expect(targetDocument.body.textContent).not.toContain("RESOURCES");
    expect(targetDocument.body.textContent).not.toContain("SYSTEM");
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
    const shortcutDialog = targetDocument.body.querySelector("#desktop-shortcut-help-dialog");
    expect(shortcutDialog?.getAttribute("role")).toBe("dialog");
    expect(shortcutDialog?.getAttribute("aria-modal")).toBe("true");
    expect(shortcutDialog?.textContent).toContain("Keyboard shortcuts");
    const shortcutSearch = shortcutDialog?.querySelector(".desktop-shortcut-help-search");
    expect(shortcutSearch?.getAttribute("placeholder")).toBe("Search shortcuts");
    expect(targetDocument.activeElement).toBe(shortcutSearch);
    expect(shortcutDialog?.textContent).toContain("Chat");
    expect(shortcutDialog?.textContent).toContain("Navigation");
    expect(shortcutDialog?.textContent).toContain("Ctrl+Shift+P");
    expect(shortcutDialog?.textContent).toContain("Command palette");

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
    expect(activityButtons.map((node) => node.getAttribute("href"))).toEqual([
      "/chat",
      "/files",
      "/knowledge",
      "/cowork",
      "/docs",
      "https://github.com/SudoJacky/tinybot",
    ]);
    expect(activityButtons.map((node) => node.getAttribute("aria-label"))).toEqual(["Chat", "Files", "Knowledge", "Cowork", "Docs", "GitHub"]);
    expect(activityButtons.map((node) => node.textContent)).toEqual(["Chat", "Files", "Knowledge", "Cowork", "Docs", "GitHub"]);
    expect(activityButtons.map((node) => node.getAttribute("data-desktop-module-target"))).toEqual(["chat", "files", "knowledge", "cowork", "docs", "gateway"]);
    expect(activityButtons.map((node) => node.getAttribute("data-focus-order"))).toEqual([
      "activity-1",
      "activity-2",
      "activity-3",
      "activity-4",
      "activity-5",
      "activity-6",
    ]);
  });

  test("routes recent chat rows by stable session key and keeps selected title visible", () => {
    const targetDocument = new FakeDocument();

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
      chat: {
        sessions: [
          {
            key: "7e9e439b4487",
            chatId: "chat-7e9e",
            title: "你好",
            createdAt: "",
            updatedAt: "2026-06-03T08:11:21Z",
          },
        ],
        activeSessionKey: "7e9e439b4487",
        activeChatId: "chat-7e9e",
        messages: [],
        status: "Session loaded from gateway.",
      },
    });

    const row = targetDocument.body.querySelector('[data-desktop-entity-id="7e9e439b4487"]');
    expect(row?.getAttribute("href")).toBe("/chat/7e9e439b4487");
    expect(targetDocument.body.querySelector(".desktop-chat-header")?.textContent).toContain("你好");
    expect(targetDocument.body.querySelector(".desktop-chat-header")?.textContent).not.toContain("New session");
  });

  test("keeps chat header actions compact and owns sidebar and run-chain toggles there", () => {
    const targetDocument = new FakeDocument();

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
      chat: {
        sessions: [{ key: "WebSocket:chat-1", chatId: "chat-1", title: "Session one", createdAt: "", updatedAt: "" }],
        activeSessionKey: "WebSocket:chat-1",
        activeChatId: "chat-1",
        messages: [],
        status: "Session loaded from gateway.",
      },
    });

    const header = targetDocument.body.querySelector(".desktop-chat-header");
    expect(header?.textContent).toContain("Session one");
    expect(header?.textContent).toContain("...");
    expect(header?.textContent).not.toContain("Session loaded from gateway.");
    expect(targetDocument.body.querySelector(".desktop-chat-runtime-status")).toBeNull();
    expect(header?.querySelector(".desktop-chat-menu")?.getAttribute("data-desktop-chat-menu")).toBe("more");
    expect(header?.querySelector(".desktop-chat-menu")?.textContent).toBe("...");
    const titleRow = header?.querySelector(".desktop-chat-title-row");
    const headerActions = header?.querySelector(".desktop-chat-header-actions");
    expect(titleRow?.children[0]?.getAttribute("data-desktop-panel-control")).toBe("sidebar");
    expect(titleRow?.children[1]?.className).toBe("desktop-chat-title-group");
    expect(headerActions?.querySelector('[data-desktop-panel-control="sidebar"]')).toBeNull();
    expect(headerActions?.querySelector('[data-desktop-panel-control="inspector"]')?.getAttribute("aria-label")).toBe("Open Activity inspector");
    expect(header?.querySelector('[data-desktop-panel-control="sidebar"]')?.getAttribute("aria-label")).toBe("Collapse session list");
    expect(header?.querySelector('[data-desktop-panel-control="inspector"]')?.getAttribute("aria-label")).toBe("Open Activity inspector");
    expect(header?.querySelector('[data-desktop-panel-control="sidebar"]')?.textContent).toBe("");
    expect(header?.querySelector('[data-desktop-panel-control="inspector"]')?.textContent).toBe("");
    expect(
      header?.querySelector('[data-desktop-panel-control="sidebar"]')?.querySelector(".desktop-chat-header-panel-icon")?.getAttribute("data-panel-icon"),
    ).toBe("collapse-left");
    expect(
      header?.querySelector('[data-desktop-panel-control="inspector"]')?.querySelector(".desktop-chat-header-panel-icon")?.getAttribute("data-panel-icon"),
    ).toBe("collapse-right");
    expect(targetDocument.body.querySelector("[data-desktop-inspector-restore]")).toBeNull();

    header?.querySelector('[data-desktop-panel-control="sidebar"]')?.click();
    expect(targetDocument.getElementById("desktop-workbench-shell")?.getAttribute("data-sidebar-visible")).toBe("false");
    expect(targetDocument.body.querySelector('[data-workbench-region="sidebar"]')?.getAttribute("data-visible")).toBe("false");
    expect(header?.querySelector('[data-desktop-panel-control="sidebar"]')?.getAttribute("aria-label")).toBe("Expand session list");
  });

  test("keeps the chat header focused on title actions and stop state", () => {
    const targetDocument = new FakeDocument();
    const interrupts: string[] = [];

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
      chatActions: {
        onInterrupt: () => interrupts.push("stop"),
      },
      chat: {
        sessions: [{ key: "WebSocket:chat-live", chatId: "chat-live", title: "Live session", createdAt: "", updatedAt: "" }],
        activeSessionKey: "WebSocket:chat-live",
        activeChatId: "chat-live",
        messages: [{
          role: "assistant",
          content: "Used a workspace reference.",
          reasoningContent: "",
          references: [{ kind: "reference", title: "README.md", detail: "workspace file" }],
          timestamp: "2026-06-03T08:20:00.000Z",
          messageId: "assistant-1",
        }],
        responding: true,
        usePersistentRag: false,
        runtime: {
          model: "deepseek-chat",
          tokenUsage: "42%",
        },
      },
    });

    const header = targetDocument.body.querySelector(".desktop-chat-header");
    expect(header?.querySelectorAll(".desktop-chat-header-chip")).toHaveLength(0);
    expect(header?.textContent).not.toContain("Model deepseek-chat");
    expect(header?.textContent).not.toContain("Knowledge Off");
    expect(header?.textContent).not.toContain("1 ref");
    expect(header?.textContent).not.toContain("42% tokens");

    const stop = header?.querySelector('[data-desktop-chat-action="stop"]') as HTMLButtonElement | null | undefined;
    expect(stop?.getAttribute("aria-label")).toBe("Stop current response");
    expect(stop?.textContent).toBe("Stop");
    stop?.click();
    expect(interrupts).toEqual(["stop"]);
  });

  test("opens chat header menu actions and updates the active session affordances", () => {
    const targetDocument = new FakeDocument();
    (targetDocument as unknown as { defaultView: { prompt: () => string } }).defaultView = {
      prompt: () => {
        throw new Error("Rename session should edit inline instead of opening a prompt.");
      },
    };
    const pinEvents: unknown[] = [];
    const renameEvents: unknown[] = [];

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
      chat: {
        sessions: [
          { key: "WebSocket:chat-2", chatId: "chat-2", title: "Session two", createdAt: "", updatedAt: "" },
          { key: "WebSocket:chat-1", chatId: "chat-1", title: "Session one", createdAt: "", updatedAt: "" },
        ],
        activeSessionKey: "WebSocket:chat-1",
        activeChatId: "chat-1",
        messages: [],
      },
      chatActions: {
        onPinSession: (event) => pinEvents.push(event),
        onRenameSession: (event) => renameEvents.push(event),
      },
    });

    const header = targetDocument.body.querySelector(".desktop-chat-header");
    const menu = header?.querySelector(".desktop-chat-menu");
    const popover = header?.querySelector(".desktop-chat-menu-popover") as unknown as { hidden: boolean } | null;
    expect(menu?.getAttribute("aria-expanded")).toBe("false");
    expect(popover?.hidden).toBe(true);

    menu?.click();
    expect(menu?.getAttribute("aria-expanded")).toBe("true");
    expect(popover?.hidden).toBe(false);
    targetDocument.dispatchEvent({ type: "click" });
    expect(menu?.getAttribute("aria-expanded")).toBe("false");
    expect(popover?.hidden).toBe(true);

    menu?.click();
    expect(menu?.getAttribute("aria-expanded")).toBe("true");
    expect(popover?.hidden).toBe(false);
    header?.querySelector('[data-desktop-chat-menu-action="pin"]')?.click();
    expect(pinEvents).toEqual([{ sessionKey: "WebSocket:chat-1", chatId: "chat-1", title: "Session one", pinned: true }]);
    expect(targetDocument.body.querySelector('[data-desktop-session-key]')?.getAttribute("data-desktop-session-key")).toBe(
      "WebSocket:chat-1",
    );
    expect(targetDocument.body.querySelector('[data-desktop-session-key]')?.getAttribute("data-pinned")).toBe("true");
    expect(
      targetDocument.body.querySelector('[data-desktop-session-key]')?.querySelector("[data-desktop-session-pin-icon]")?.textContent,
    ).toBe("📌");
    expect(header?.querySelector('[data-desktop-chat-menu-action="pin"]')?.textContent).toBe("Unpin session");
    expect(menu?.getAttribute("aria-expanded")).toBe("false");

    menu?.click();
    header?.querySelector('[data-desktop-chat-menu-action="rename"]')?.click();
    const editor = header?.querySelector(".desktop-chat-title-editor");
    expect(editor).toBeTruthy();
    expect(editor?.getAttribute("aria-label")).toBe("Rename session");
    expect(editor?.value).toBe("Session one");
    editor!.value = "Renamed session";
    editor!.dispatchEvent({ type: "keydown", key: "Enter", preventDefault: () => undefined });
    expect(renameEvents).toEqual([{ sessionKey: "WebSocket:chat-1", chatId: "chat-1", title: "Renamed session" }]);
    expect(header?.querySelector(".desktop-chat-title")?.textContent).toBe("Renamed session");
    expect(targetDocument.body.querySelector('[data-desktop-session-key]')?.querySelector(".desktop-sidebar-row-label")?.textContent).toBe(
      "Renamed session",
    );
    expect(header?.querySelector('[data-desktop-panel-control="sidebar"]')?.textContent).toBe("");
    expect(header?.querySelector('[data-desktop-panel-control="inspector"]')?.textContent).toBe("");
  });

  test("anchors the chat header menu popover inside the main work area", () => {
    const targetDocument = new FakeDocument();

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
      chat: {
        sessions: [{ key: "WebSocket:chat-1", chatId: "chat-1", title: "你好", createdAt: "", updatedAt: "" }],
        activeSessionKey: "WebSocket:chat-1",
        activeChatId: "chat-1",
        messages: [],
      },
    });

    const styleText = targetDocument.head.querySelector("#desktop-workbench-shell-style")?.textContent ?? "";
    expect(styleText).toContain("body.desktop-native-workbench .desktop-chat-menu-popover");
    expect(styleText).toContain("left: 0;");
    expect(styleText).toContain("right: auto;");
    expect(styleText).not.toContain("right: 0;\n      z-index: 8;");
  });

  test("preserves pinned sessions when native chat refreshes", () => {
    const targetDocument = new FakeDocument();
    const chat = {
      sessions: [
        { key: "WebSocket:chat-2", chatId: "chat-2", title: "Session two", createdAt: "", updatedAt: "" },
        { key: "WebSocket:chat-1", chatId: "chat-1", title: "Session one", createdAt: "", updatedAt: "" },
      ],
      activeSessionKey: "WebSocket:chat-1",
      activeChatId: "chat-1",
      messages: [],
    };

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
      chat,
    });

    const header = targetDocument.body.querySelector(".desktop-chat-header");
    header?.querySelector(".desktop-chat-menu")?.click();
    header?.querySelector('[data-desktop-chat-menu-action="pin"]')?.click();

    updateDesktopNativeChat(targetDocument as unknown as Document, chat, "http://127.0.0.1:18790");

    const firstRow = targetDocument.body.querySelector('[data-desktop-session-key]');
    expect(firstRow?.getAttribute("data-desktop-session-key")).toBe("WebSocket:chat-1");
    expect(firstRow?.getAttribute("data-pinned")).toBe("true");
    expect(firstRow?.querySelector("[data-desktop-session-pin-icon]")?.textContent).toBe("📌");
    const refreshedHeader = targetDocument.body.querySelector(".desktop-chat-header");
    refreshedHeader?.querySelector(".desktop-chat-menu")?.click();
    expect(refreshedHeader?.querySelector('[data-desktop-chat-menu-action="pin"]')?.textContent).toBe("Unpin session");
  });

  test("renders keyboard-operable panel controls with accessible labels", () => {
    const targetDocument = new FakeDocument();

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
    });

    const controls = targetDocument.body.querySelectorAll(".desktop-chat-header-panel-button");
    expect(controls.map((node) => node.getAttribute("data-desktop-panel-control"))).toEqual(["sidebar", "inspector"]);
    expect(controls.map((node) => node.getAttribute("aria-label"))).toEqual([
      "Collapse session list",
      "Open Activity inspector",
    ]);
    expect(controls.map((node) => node.getAttribute("aria-pressed"))).toEqual(["true", "false"]);
    expect(controls[0].querySelector(".desktop-chat-header-panel-icon")?.getAttribute("data-panel-icon")).toBe("collapse-left");

    let prevented = false;
    controls[1].dispatchEvent({
      type: "keydown",
      key: "Enter",
      preventDefault: () => {
        prevented = true;
      },
    });

    expect(prevented).toBe(true);
    expect(targetDocument.getElementById("desktop-workbench-shell")?.getAttribute("data-inspector-visible")).toBe("true");
    expect(targetDocument.body.querySelector('[data-workbench-region="inspector"]')?.getAttribute("data-visible")).toBe("true");
    expect(controls[1].getAttribute("aria-pressed")).toBe("true");
    expect(targetDocument.body.querySelector("[data-desktop-route-status]")?.textContent).toContain("Activity inspector panel shown");
  });

  test("makes the native Run Chain overview compact, switchable, and recoverable after close", () => {
    const targetDocument = new FakeDocument();

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
    });

    const overview = targetDocument.body.querySelector(".desktop-run-chain-overview");
    const panel = overview?.querySelector(".desktop-run-chain-panel");
    expect(overview?.querySelector(".desktop-run-chain-summary-strip")?.textContent).toContain("Gateway");
    expect(overview?.querySelector(".desktop-run-chain-summary-strip")?.textContent).toContain("Idle");
    expect(overview?.querySelector(".desktop-run-chain-summary-strip")?.textContent).toContain("0 items");
    expect(overview?.querySelector('[data-desktop-run-chain-summary="gateway"]')?.getAttribute("aria-label")).toBe("Gateway: Connected");
    expect(overview?.querySelector('[data-desktop-run-chain-summary="gateway"]')?.getAttribute("title")).toBe("Gateway: Connected");
    expect(overview?.querySelector('[data-desktop-run-chain-summary="run"]')?.getAttribute("aria-label")).toBe("Run: Idle");
    expect(overview?.querySelector('[data-desktop-run-chain-summary="gateway"]')?.className).toContain("desktop-run-chain-status-pill");
    expect(overview?.querySelector('[data-desktop-run-chain-summary="gateway"]')?.getAttribute("data-status-tone")).toBe("connected");
    expect(overview?.querySelector('[data-desktop-run-chain-summary="run"]')?.getAttribute("data-status-tone")).toBe("muted");
    expect(overview?.querySelector(".desktop-run-chain-status-dot")).not.toBeNull();
    expect(panel?.getAttribute("data-desktop-run-chain-panel")).toBe("context");
    expect(panel?.textContent).toContain("Endpoint");

    overview?.querySelector('[data-desktop-run-chain-tab="files"]')?.click();
    expect(overview?.querySelector('[data-desktop-run-chain-tab="files"]')?.getAttribute("aria-selected")).toBe("true");
    expect(panel?.getAttribute("data-desktop-run-chain-panel")).toBe("files");
    expect(panel?.textContent).toContain("Files");
    expect(panel?.textContent).toContain("Open Files");

    overview?.querySelector('[data-desktop-run-chain-tab="tasks"]')?.click();
    expect(overview?.querySelector('[data-desktop-run-chain-tab="tasks"]')?.getAttribute("aria-selected")).toBe("true");
    expect(panel?.getAttribute("data-desktop-run-chain-panel")).toBe("tasks");
    expect(panel?.textContent).toContain("Tasks");
    expect(panel?.textContent).toContain("Task center: Available");
    expect(panel?.textContent).toContain("No chain items yet.");
    expect(panel?.textContent).toContain("New Activity Item");
    expect(panel?.querySelector(".desktop-run-chain-new-item")?.getAttribute("data-button-variant")).toBe("secondary");

    overview?.querySelector('[data-desktop-run-chain-summary="gateway"]')?.click();
    expect(overview?.querySelector('[data-desktop-run-chain-tab="context"]')?.getAttribute("aria-selected")).toBe("true");
    expect(overview?.querySelector('[data-desktop-run-chain-tab="tasks"]')?.getAttribute("aria-selected")).toBe("false");
    expect(panel?.getAttribute("data-desktop-run-chain-panel")).toBe("context");

    overview?.querySelector('[data-desktop-run-chain-summary="items"]')?.click();
    expect(overview?.querySelector('[data-desktop-run-chain-tab="context"]')?.getAttribute("aria-selected")).toBe("false");
    expect(overview?.querySelector('[data-desktop-run-chain-tab="activity"]')?.getAttribute("aria-selected")).toBe("true");
    expect(panel?.getAttribute("data-desktop-run-chain-panel")).toBe("activity");

    const pin = overview?.querySelector('[data-desktop-run-chain-control="pin"]');
    expect(pin?.getAttribute("data-button-variant")).toBe("ghost");
    expect(pin?.getAttribute("aria-label")).toBe("Pin panel");
    expect(overview?.querySelector('[data-desktop-run-chain-control="close"]')?.getAttribute("title")).toBe("Close panel");
    expect(overview?.querySelector('[data-desktop-run-chain-action="Open Task Center"]')?.getAttribute("data-button-variant")).toBe("primary");
    expect(pin?.getAttribute("aria-pressed")).toBe("false");
    pin?.click();
    expect(pin?.getAttribute("aria-pressed")).toBe("true");

    overview?.querySelector('[data-desktop-run-chain-control="close"]')?.click();
    const restore = targetDocument.body.querySelector("[data-desktop-inspector-restore]");
    expect(targetDocument.getElementById("desktop-workbench-shell")?.getAttribute("data-inspector-visible")).toBe("false");
    expect(restore).toBeNull();
    targetDocument.body.querySelector(".desktop-chat-header")?.querySelector('[data-desktop-panel-control="inspector"]')?.click();
    expect(targetDocument.getElementById("desktop-workbench-shell")?.getAttribute("data-inspector-visible")).toBe("true");
    expect(targetDocument.body.querySelector('[data-workbench-region="inspector"]')?.getAttribute("data-visible")).toBe("true");
    expect(targetDocument.body.querySelectorAll('[data-desktop-panel-control="inspector"]').map((node) => node.getAttribute("aria-pressed"))).toContain("true");
  });

  test("renders live approval queue in the native Run Chain overview", () => {
    const targetDocument = new FakeDocument();
    const taskCenterItems = buildDesktopTaskCenterItems({
      approvals: [
        {
          id: "approval-1",
          title: "Approve shell command",
          status: "requires_approval",
          detail: "Shell command approval required",
          canonical: { module: "approvals", entityId: "approval-1", href: "/chat/chat-1" },
          approval: { approvalId: "approval-1", sessionKey: "WebSocket:chat-1" },
        },
      ],
    });

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
      taskCenterItems,
    });

    const overview = targetDocument.body.querySelector(".desktop-run-chain-overview");
    const panel = overview?.querySelector(".desktop-run-chain-panel");
    expect(overview?.querySelector(".desktop-run-chain-summary-strip")?.textContent).toContain("1 approval");
    expect(overview?.querySelector('[data-desktop-run-chain-summary="approvals"]')?.getAttribute("data-status-tone")).toBe("attention");

    overview?.querySelector('[data-desktop-run-chain-tab="approvals"]')?.click();

    expect(panel?.getAttribute("data-desktop-run-chain-panel")).toBe("approvals");
    expect(panel?.textContent).toContain("Pending: 1");
    expect(panel?.textContent).toContain("Queue: 1 pending approval");
    expect(panel?.textContent).toContain("Approve shell command");
    expect(panel?.textContent).toContain("Shell command approval required");
    expect(panel?.querySelector('[data-desktop-run-chain-approval-item="approval-1"]')).not.toBeNull();
  });

  test("refreshes the Inspector approval queue when Task Center items change", () => {
    const targetDocument = new FakeDocument();

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
    });

    let overview = targetDocument.body.querySelector(".desktop-run-chain-overview");
    let panel = overview?.querySelector(".desktop-run-chain-panel");
    overview?.querySelector('[data-desktop-run-chain-tab="approvals"]')?.click();
    expect(panel?.getAttribute("data-desktop-run-chain-panel")).toBe("approvals");
    expect(panel?.textContent).toContain("Pending: 0");
    expect(overview?.querySelector(".desktop-run-chain-summary-strip")?.textContent).toContain("0 approvals");

    updateDesktopTaskCenterItems(targetDocument as unknown as Document, buildDesktopTaskCenterItems({
      approvals: [
        {
          id: "approval-1",
          title: "Approve shell command",
          status: "requires_approval",
          detail: "Shell command approval required",
          canonical: { module: "approvals", entityId: "approval-1", href: "/chat/chat-1" },
          approval: { approvalId: "approval-1", sessionKey: "WebSocket:chat-1" },
        },
      ],
    }));

    overview = targetDocument.body.querySelector(".desktop-run-chain-overview");
    panel = overview?.querySelector(".desktop-run-chain-panel");
    expect(panel?.getAttribute("data-desktop-run-chain-panel")).toBe("approvals");
    expect(overview?.querySelector(".desktop-run-chain-summary-strip")?.textContent).toContain("1 approval");
    expect(panel?.textContent).toContain("Pending: 1");
    expect(panel?.textContent).toContain("Approve shell command");

    updateDesktopTaskCenterItems(targetDocument as unknown as Document, []);

    overview = targetDocument.body.querySelector(".desktop-run-chain-overview");
    panel = overview?.querySelector(".desktop-run-chain-panel");
    expect(panel?.getAttribute("data-desktop-run-chain-panel")).toBe("approvals");
    expect(overview?.querySelector(".desktop-run-chain-summary-strip")?.textContent).toContain("0 approvals");
    expect(panel?.textContent).toContain("Pending: 0");
    expect(panel?.textContent).toContain("No pending approvals");
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
    expect(targetDocument.body.querySelector(".desktop-chat-workbench-chrome")).toBeNull();
    expect(targetDocument.body.querySelector(".desktop-empty-session")?.textContent).not.toContain("Ready for a new session.");

    targetDocument.body.querySelector('[data-desktop-run-chain-control="close"]')?.click();
    expect(targetDocument.getElementById("desktop-workbench-shell")?.getAttribute("data-inspector-visible")).toBe("false");
    expect(targetDocument.body.querySelector('[data-workbench-region="inspector"]')?.getAttribute("data-visible")).toBe("false");
    expect(targetDocument.body.querySelector('[data-desktop-panel-control="inspector"]')?.getAttribute("aria-pressed")).toBe("false");
  });

  test("opens the run-chain inspector detail when a conversation tool activity is selected", () => {
    const targetDocument = new FakeDocument();
    const layout = createDefaultWorkbenchLayout();
    layout.inspector.visible = false;
    const runChainItems = buildDesktopRunChainItems([
      {
        role: "assistant",
        message_id: "assistant-1",
        content: "The command finished.",
        tool_calls: [
          {
            id: "call-shell",
            type: "function",
            function: {
              name: "shell",
              arguments: "{\"command\":\"pwd\"}",
            },
          },
        ],
      },
      {
        role: "tool",
        message_id: "tool-result-1",
        tool_call_id: "call-shell",
        name: "shell",
        content: "D:/code/tinybot",
      },
    ]);

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout,
      gatewayHttp: "http://127.0.0.1:18790",
      chat: {
        sessions: [{ key: "WebSocket:chat-live", chatId: "chat-live", title: "Tool chat", createdAt: "", updatedAt: "" }],
        activeSessionKey: "WebSocket:chat-live",
        activeChatId: "chat-live",
        messages: [
          {
            role: "assistant",
            content: "The command finished.",
            reasoningContent: "",
            toolActivities: [
              {
                id: "call-shell",
                name: "shell",
                argsText: "{\"command\":\"pwd\"}",
                responseText: "D:/code/tinybot",
                kind: "result",
              },
            ],
            timestamp: "2026-06-03T08:20:00.000Z",
            messageId: "assistant-1",
          },
        ],
        status: "Connected",
      },
      runChainItems,
    });

    expect(targetDocument.getElementById("desktop-workbench-shell")?.getAttribute("data-inspector-visible")).toBe("false");
    const toolActivity = targetDocument.body.querySelector(".desktop-tool-activity");
    expect(toolActivity?.getAttribute("data-desktop-run-chain-item-key")).toBe("assistant-1:call-shell");

    toolActivity?.querySelector(".desktop-tool-activity-row")?.click();

    expect(targetDocument.getElementById("desktop-workbench-shell")?.getAttribute("data-inspector-visible")).toBe("true");
    expect(targetDocument.body.querySelector('[data-workbench-region="inspector"]')?.getAttribute("data-visible")).toBe("true");
    const selectedRow = targetDocument.body.querySelector('[data-desktop-run-chain-item="assistant-1:call-shell"]');
    expect(selectedRow?.getAttribute("aria-selected")).toBe("true");
    expect(targetDocument.body.querySelector(".desktop-run-chain-detail")?.textContent).toContain("shell");
    expect(targetDocument.body.querySelector(".desktop-run-chain-detail")?.textContent).toContain("\"command\": \"pwd\"");
  });

  test("renders pending tool approvals as inline approval cards in the tool timeline", () => {
    const targetDocument = new FakeDocument();
    const layout = createDefaultWorkbenchLayout();
    layout.inspector.visible = false;
    const inspected: string[] = [];
    const approvals: unknown[] = [];
    targetDocument.addEventListener("desktop-run-chain-inspect", (event) => {
      inspected.push((event as CustomEvent).detail.itemKey);
    });
    targetDocument.addEventListener("desktop-tool-approval-action", (event) => {
      approvals.push((event as CustomEvent).detail);
    });
    const runChainItems = buildDesktopRunChainItems([
      {
        role: "assistant",
        message_id: "assistant-1",
        content: "I need to run a command.",
        tool_calls: [
          {
            id: "call-shell",
            type: "function",
            function: {
              name: "shell",
              arguments: "{\"command\":\"python scripts/build_index.py\"}",
            },
          },
        ],
      },
    ]);

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout,
      gatewayHttp: "http://127.0.0.1:18790",
      chat: {
        sessions: [{ key: "WebSocket:chat-live", chatId: "chat-live", title: "Approval chat", createdAt: "", updatedAt: "" }],
        activeSessionKey: "WebSocket:chat-live",
        activeChatId: "chat-live",
        messages: [
          {
            role: "assistant",
            content: "I need to run a command.",
            reasoningContent: "",
            toolActivities: [
              {
                approvalId: "approval-1",
                approvalStatus: "approval_required",
                argsText: "python scripts/build_index.py",
                id: "call-shell",
                kind: "call",
                name: "shell",
                responseText: "",
                sessionKey: "WebSocket:chat-live",
              },
            ],
            timestamp: "2026-06-03T08:20:00.000Z",
            messageId: "assistant-1",
          },
        ],
        status: "Connected",
      },
      runChainItems,
    });

    const toolActivity = targetDocument.body.querySelector(".desktop-tool-activity");
    const approvalCard = toolActivity?.querySelector(".desktop-tool-approval-card");
    expect(toolActivity?.getAttribute("data-desktop-approval-status")).toBe("approval_required");
    expect(approvalCard?.getAttribute("role")).toBe("group");
    expect(approvalCard?.getAttribute("aria-label")).toBe("Approval required for shell");
    expect(approvalCard?.getAttribute("data-desktop-chat-region")).toBe("approval-card");
    expect(approvalCard?.textContent).toContain("Approval required");
    expect(approvalCard?.textContent).toContain("shell");
    expect(approvalCard?.textContent).toContain("python scripts/build_index.py");
    expect(toolActivity?.getAttribute("data-desktop-tool-status")).toBe("blocked");
    expect(toolActivity?.querySelector(".desktop-tool-activity-status-label")?.textContent).toBe("Pending approval");
    expect(toolActivity?.querySelector(".desktop-tool-activity-status-dot")?.getAttribute("data-tool-status-tone")).toBe("pending");

    approvalCard?.querySelector('[data-desktop-approval-action="approveOnce"]')?.click();
    approvalCard?.querySelector('[data-desktop-approval-action="approveSession"]')?.click();
    approvalCard?.querySelector('[data-desktop-approval-action="deny"]')?.click();
    approvalCard?.querySelector('[data-desktop-approval-action="review"]')?.click();

    expect(approvals).toEqual([
      { action: "approveOnce", approvalId: "approval-1", runChainItemKey: "assistant-1:call-shell", sessionKey: "WebSocket:chat-live", toolActivityId: "call-shell", toolName: "shell" },
      { action: "approveSession", approvalId: "approval-1", runChainItemKey: "assistant-1:call-shell", sessionKey: "WebSocket:chat-live", toolActivityId: "call-shell", toolName: "shell" },
      { action: "deny", approvalId: "approval-1", runChainItemKey: "assistant-1:call-shell", sessionKey: "WebSocket:chat-live", toolActivityId: "call-shell", toolName: "shell" },
    ]);
    expect(inspected).toEqual(["assistant-1:call-shell"]);
    expect(targetDocument.getElementById("desktop-workbench-shell")?.getAttribute("data-inspector-visible")).toBe("true");
    expect(targetDocument.body.querySelector('[data-desktop-run-chain-item="assistant-1:call-shell"]')?.getAttribute("aria-selected")).toBe("true");
  });

  test("renders tool execution status in the shell fallback timeline", () => {
    const targetDocument = new FakeDocument();

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
      chat: {
        sessions: [{ key: "WebSocket:chat-live", chatId: "chat-live", title: "Tool chat", createdAt: "", updatedAt: "" }],
        activeSessionKey: "WebSocket:chat-live",
        activeChatId: "chat-live",
        messages: [
          {
            role: "assistant",
            content: "The command is running.",
            reasoningContent: "",
            toolActivities: [
              {
                argsText: "npm test",
                approvalStatus: "",
                id: "call-shell",
                kind: "call",
                name: "shell",
                responseText: "",
                status: "running",
              },
            ],
            timestamp: "2026-06-03T08:20:00.000Z",
            messageId: "assistant-1",
          },
        ],
        status: "Connected",
      },
    });

    const toolActivity = targetDocument.body.querySelector(".desktop-tool-activity");
    expect(toolActivity?.getAttribute("data-desktop-tool-activity-status")).toBe("running");
    expect(toolActivity?.querySelector(".desktop-tool-activity-row")?.getAttribute("aria-label")).toBe("Open shell tool details, Running");
    expect(toolActivity?.querySelector(".desktop-tool-activity-status-label")?.textContent).toBe("Running");
    expect(toolActivity?.querySelector(".desktop-tool-activity-status-dot")?.getAttribute("data-tool-status-tone")).toBe("running");
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
          relatedResources: [
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
        },
      ],
    });

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
      taskCenterItems: items,
      chat: {
        sessions: [{ key: "WebSocket:chat-live", chatId: "chat-live", title: "Live session", createdAt: "", updatedAt: "" }],
        activeSessionKey: "WebSocket:chat-live",
        activeChatId: "chat-live",
        messages: [],
      },
    });

    targetDocument.body.querySelector('[data-desktop-task-action="inspect"]')?.click();

    const inspector = targetDocument.body.querySelector('[data-workbench-region="inspector"]');
    const lens = inspector?.querySelector(".desktop-work-lens");
    expect(lens?.getAttribute("data-desktop-work-lens-kind")).toBe("knowledgeJob");
    expect(lens?.textContent).toContain("Index Desktop UX Notes");
    expect(lens?.textContent).toContain("Embedding provider returned 429");
    expect(lens?.textContent).toContain("Desktop UX evidence");
    expect(lens?.textContent).toContain("Failure diagnostics");
    expect(lens?.textContent).toContain("What can I do next?");
    expect(lens?.querySelector('[data-desktop-work-lens-resource="evidence:doc-1"]')?.getAttribute("href")).toBe("/knowledge");
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
      chat: {
        sessions: [{ key: "WebSocket:chat-live", chatId: "chat-live", title: "Live session", createdAt: "", updatedAt: "" }],
        activeSessionKey: "WebSocket:chat-live",
        activeChatId: "chat-live",
        messages: [],
      },
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

  test("opens the Activity inspector for Work Lens when the inspector starts hidden", () => {
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

    const inspector = targetDocument.body.querySelector('[data-workbench-region="inspector"]');
    const inspectorLens = inspector?.querySelector(".desktop-work-lens");
    expect(targetDocument.getElementById("desktop-workbench-shell")?.getAttribute("data-inspector-visible")).toBe("true");
    expect(inspector?.getAttribute("data-visible")).toBe("true");
    expect(inspectorLens?.getAttribute("data-desktop-work-lens-kind")).toBe("knowledgeJob");
    expect(inspectorLens?.getAttribute("data-desktop-work-lens-placement")).toBe("inspector");
    expect(inspectorLens?.textContent).toContain("Index Desktop UX Notes");
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
      chat: {
        sessions: [{ key: "WebSocket:chat-live", chatId: "chat-live", title: "Live session", createdAt: "", updatedAt: "" }],
        activeSessionKey: "WebSocket:chat-live",
        activeChatId: "chat-live",
        messages: [],
      },
    });

    expect(targetDocument.getElementById("desktop-knowledge-upload")?.getAttribute("data-desktop-file-upload")).toBe("knowledge-document");
    expect(targetDocument.getElementById("desktop-knowledge-upload")?.getAttribute("data-desktop-drop-target")).toBe("knowledge-document");
    expect(targetDocument.getElementById("desktop-session-file-upload")?.getAttribute("data-desktop-file-upload")).toBe("session-temporary-file");
    expect(targetDocument.getElementById("desktop-session-file-upload")?.getAttribute("data-desktop-drop-target")).toBe("session-temporary-file");
    expect(targetDocument.getElementById("desktop-workspace-file-drop")?.getAttribute("data-desktop-drop-target")).toBe("workspace-file");
    expect(targetDocument.getElementById("desktop-session-upload-key")?.getAttribute("aria-label")).toBe("Session key for temporary file upload");
    expect(targetDocument.getElementById("desktop-session-upload-key")?.getAttribute("readonly")).toBe("");
    expect(targetDocument.getElementById("desktop-session-upload-key")?.getAttribute("data-active-session-key")).toBe("WebSocket:chat-live");
    expect(targetDocument.getElementById("desktop-session-upload-key")?.value).toBe("WebSocket:chat-live");
    expect(targetDocument.getElementById("desktop-file-upload-status")?.textContent).toContain("No file operation running");
    expect(targetDocument.body.querySelector(".desktop-file-import-grid")?.textContent).toContain("Drop files here or click to select");
    expect(targetDocument.getElementById("desktop-file-knowledge-formats")?.textContent).toContain("pdf");
    expect(targetDocument.getElementById("desktop-file-session-formats")?.textContent).toContain("png");
    expect(targetDocument.getElementById("desktop-file-workspace-formats")?.textContent).toContain("toml");
    expect(targetDocument.getElementById("desktop-session-file-count")?.textContent).toContain("0");
    expect(targetDocument.getElementById("desktop-session-files-refresh")?.getAttribute("data-desktop-session-files-refresh")).toBe("true");
  });

  test("renders native Agent UI form cards and routes submit and cancel actions", () => {
    const targetDocument = new FakeDocument();
    const actions: string[] = [];

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
      agentUiForms: [
        {
          form_id: "approval-form-1",
          title: "Approve deployment",
          description: "Confirm release target",
          status: "validation_failed",
          correlation: { chat_id: "chat-1", message_id: "msg-1" },
          initial_values: { target: "staging", force: false },
          values: { target: "", force: false },
          errors: { target: "Target is required" },
          fields: [
            { name: "target", type: "text", label: "Target", required: true },
            { name: "force", type: "checkbox", label: "Force", required: false },
          ],
        },
      ],
      agentUiActions: {
        onAgentUiFormAction: ({ action, values }) => {
          actions.push(`${action}:${values?.target ?? ""}:${String(values?.force ?? "")}`);
        },
      },
    });

    const card = targetDocument.body.querySelector('[data-agent-ui-form-id="approval-form-1"]');
    expect(card?.getAttribute("data-desktop-entity-module")).toBe("approvals");
    expect(card?.getAttribute("data-desktop-entity-id")).toBe("approval-form-1");
    expect(card?.textContent).toContain("Approve deployment");
    expect(card?.textContent).toContain("validation_failed");
    expect(card?.textContent).toContain("Target is required");

    const target = card?.querySelector('[data-agent-ui-form-field="target"]');
    const force = card?.querySelector('[data-agent-ui-form-field="force"]');
    expect(target?.value).toBe("");
    target!.value = "production";
    force!.checked = true;

    card?.querySelector('[data-agent-ui-form-action="submit"]')?.click();
    card?.querySelector('[data-agent-ui-form-action="cancel"]')?.click();

    expect(actions).toEqual(["submit:production:true", "cancel::"]);
  });

  test("projects active chat Agent UI forms into the message timeline", () => {
    const targetDocument = new FakeDocument();
    const actions: string[] = [];

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
      chat: {
        sessions: [{ key: "WebSocket:chat-1", chatId: "chat-1", title: "Agent form chat", createdAt: "", updatedAt: "" }],
        activeSessionKey: "WebSocket:chat-1",
        activeChatId: "chat-1",
        messages: [{
          role: "assistant",
          content: "Tinybot needs more information.",
          reasoningContent: "",
          timestamp: "2026-06-03T08:20:00.000Z",
          messageId: "assistant-1",
        }],
      },
      agentUiActions: {
        onAgentUiFormAction: ({ action, form, values }) => {
          actions.push(`${action}:${form.form_id}:${values?.target ?? ""}`);
        },
      },
      agentUiForms: [
        {
          form_id: "form-active",
          title: "Choose target",
          description: "Select deployment target",
          status: "pending",
          correlation: { chat_id: "chat-1", message_id: "assistant-1" },
          initial_values: { target: "staging" },
          fields: [{ name: "target", type: "text", label: "Target", required: true }],
        },
        {
          form_id: "form-other",
          title: "Other chat form",
          status: "pending",
          correlation: { chat_id: "chat-2" },
          fields: [{ name: "target", type: "text", label: "Target", required: true }],
        },
      ],
    });

    const thread = targetDocument.body.querySelector(".desktop-conversation-thread");
    const inlineForms = thread?.querySelectorAll(".desktop-agent-ui-form-inline");
    expect(inlineForms).toHaveLength(1);
    expect(inlineForms?.[0]?.getAttribute("data-agent-ui-form-id")).toBe("form-active");
    expect(inlineForms?.[0]?.getAttribute("data-desktop-chat-region")).toBe("agent-form-card");
    expect(inlineForms?.[0]?.textContent).toContain("Choose target");
    expect(inlineForms?.[0]?.textContent).not.toContain("Other chat form");

    const target = inlineForms?.[0]?.querySelector('[data-agent-ui-form-field="target"]');
    target!.value = "production";
    inlineForms?.[0]?.querySelector('[data-agent-ui-form-action="submit"]')?.click();

    expect(actions).toEqual(["submit:form-active:production"]);
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
    (targetDocument as unknown as { defaultView: { prompt: () => string } }).defaultView = {
      prompt: () => "custom-openai",
    };
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
        providerSummaries: [
          {
            id: "openai",
            label: "OpenAI",
            profileId: "work",
            apiKey: "sk-live",
            apiBase: "https://api.openai.com/v1",
            modelsText: "gpt-4.1\ngpt-4.1-mini",
            supportsModelDiscovery: true,
            status: "ready",
            enabled: true,
            enabledConfigured: false,
          },
          {
            id: "deepseek",
            label: "DeepSeek",
            profileId: "deepseek",
            apiKey: "sk-deepseek",
            apiBase: "https://api.deepseek.com",
            modelsText: "deepseek-chat",
            supportsModelDiscovery: true,
            status: "ready",
            enabled: true,
            enabledConfigured: false,
          },
          {
            id: "ollama",
            label: "Ollama",
            profileId: "ollama",
            apiKey: "",
            apiBase: null,
            modelsText: "",
            supportsModelDiscovery: true,
            status: "not_configured",
            enabled: false,
            enabledConfigured: false,
          },
        ],
      },
      {
        lastSavedState: null,
        saveStatus: "failed",
        saveError: "HTTP 400",
        providerCatalog: [
          { id: "openai", displayName: "OpenAI", status: "ready" },
          { id: "deepseek", displayName: "DeepSeek", status: "ready" },
          { id: "ollama", displayName: "Ollama", status: "not_configured" },
        ],
      },
    );

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
      settingsPane,
      settingsActions: {
        onSettingsAction: (event) => {
          if (event.action === "edit") {
            settingsActions.push(`${event.action}:${event.fieldId}:${String(event.value)}`);
            return;
          }
          settingsActions.push(event.action);
        },
      },
    });

    const pane = targetDocument.body.querySelector(".desktop-settings-pane");
    expect(pane?.getAttribute("aria-label")).toBe("Settings and providers");
    expect(pane?.getAttribute("data-settings-layout")).toBe("capability-center");
    expect(pane?.querySelector(".desktop-settings-search")?.getAttribute("placeholder")).toBe("Search settings...");
    expect(pane?.querySelectorAll(".desktop-settings-nav-item").map((item) => item.textContent)).toEqual([
      "General",
      "Provider & Models",
      "Knowledge",
      "Tools & Approvals",
      "Files & Workspace",
      "Memory & Experience",
      "Skills",
      "Channels",
      "Automations",
      "Gateway & Runtime",
      "Logs & Diagnostics",
    ]);
    expect(pane?.querySelector(".desktop-settings-nav-item")?.getAttribute("data-active")).toBe("true");
    expect(pane?.querySelector(".desktop-settings-content")?.textContent).toContain("Settings / Capability Center");
    expect(pane?.querySelector(".desktop-settings-capability-map")?.getAttribute("data-desktop-settings-center")).toBe("capability-boundaries");
    expect(pane?.querySelectorAll("[data-desktop-settings-capability]").map((node) => node.getAttribute("data-desktop-settings-capability"))).toEqual([
      "provider-models",
      "knowledge",
      "tools-approvals",
      "files-workspace",
      "gateway-runtime",
      "logs-diagnostics",
    ]);
    expect(pane?.querySelector('[data-desktop-settings-capability="provider-models"]')?.textContent).toContain("OpenAI");
    expect(pane?.querySelector('[data-desktop-settings-capability="knowledge"]')?.textContent).toContain("Knowledge On");
    expect(pane?.querySelector('[data-desktop-settings-capability="tools-approvals"]')?.textContent).toContain("Shell Off");
    expect(pane?.querySelector('[data-desktop-settings-capability="gateway-runtime"]')?.textContent).toContain("Gateway 0.0.0.0:18790");
    expect(pane?.querySelector(".desktop-settings-default-llm-card")?.textContent).toContain("默认 LLM");
    expect(pane?.querySelector(".desktop-settings-default-llm-card")?.textContent).toContain("提供商");
    expect(pane?.querySelector(".desktop-settings-default-llm-card")?.textContent).toContain("模型");
    expect(pane?.querySelector(".desktop-settings-default-llm-card")?.textContent).toContain("这里设置全局默认的 LLM 模型");
    expect(pane?.querySelector(".desktop-settings-provider-section")?.textContent).toContain("提供商");
    expect(pane?.querySelector(".desktop-settings-provider-search")?.getAttribute("placeholder")).toBe("搜索提供商...");
    expect(pane?.querySelector('[data-desktop-settings-action="addProvider"]')?.textContent).toBe("+ 添加提供商");
    expect(pane?.querySelector(".desktop-settings-provider-card")?.textContent).toContain("OpenAI");
    expect(pane?.querySelector(".desktop-settings-provider-card")?.textContent).toContain("Base URL: https://api.openai.com/v1");
    expect(pane?.querySelector(".desktop-settings-provider-card")?.textContent).toContain("API Key: ********");
    expect(pane?.querySelector(".desktop-settings-provider-card")?.textContent).toContain("Model: gpt-4.1, gpt-4.1-mini");
    expect(pane?.querySelector('[data-desktop-settings-provider-card="deepseek"]')?.textContent).toContain("Base URL: https://api.deepseek.com");
    expect(pane?.querySelector('[data-desktop-settings-provider-card="deepseek"]')?.textContent).toContain("Model: deepseek-chat");
    expect(pane?.querySelectorAll(".desktop-settings-provider-card").map((card) => card.getAttribute("data-desktop-settings-provider-card"))).toEqual([
      "openai",
      "deepseek",
      "ollama",
    ]);
    expect(pane?.querySelector('[data-desktop-settings-group="general"]')?.getAttribute("id")).toBe("desktop-settings-group-general");
    expect(pane?.textContent).toContain("Settings / Capability Center");
    expect(pane?.textContent).toContain("Model: ");
    expect(pane?.querySelector(".desktop-settings-status-card")).toBeNull();
    expect(pane?.textContent).not.toContain("Save: HTTP 400");
    expect(pane?.textContent).not.toContain("Catalog: OpenAI (ready)");
    expect(pane?.textContent).not.toContain("Open docs");
    expect(pane?.textContent).not.toContain("Shortcut help");
    expect(pane?.querySelector('[data-desktop-settings-control="model"]')?.getAttribute("aria-invalid")).toBe("true");
    expect(pane?.querySelector('[data-desktop-settings-control="timezone"]')?.getAttribute("aria-invalid")).toBe("true");
    expect(pane?.querySelector('[data-desktop-settings-control="enabled"]')?.checked).toBe(true);
    expect(pane?.querySelector('[data-desktop-settings-control="mcpServers"]')?.tagName).toBe("textarea");
    expect(pane?.querySelector('[data-desktop-settings-action="save"]')?.getAttribute("disabled")).toBe("true");
    expect(pane?.querySelector('[data-desktop-settings-action="discoverModels"]')?.textContent).toBe("Refresh models");

    const modelInput = pane?.querySelector('[data-desktop-settings-control="model"]');
    expect(modelInput?.tagName).toBe("select");
    modelInput!.value = "gpt-4.1";
    modelInput?.dispatchEvent({ type: "change", target: modelInput });

    const knowledgeToggle = pane?.querySelector('[data-desktop-settings-control="enabled"]');
    knowledgeToggle!.checked = false;
    knowledgeToggle?.dispatchEvent({ type: "change", target: knowledgeToggle });

    pane?.querySelector('[data-desktop-settings-action="save"]')?.click();
    pane?.querySelector('[data-desktop-settings-action="discoverModels"]')?.click();
    expect(settingsActions).toEqual(["edit:model:gpt-4.1", "edit:enabled:false", "save", "discoverModels"]);

    const defaultProviderSelect = pane?.querySelector('[data-desktop-settings-control="provider"]');
    defaultProviderSelect!.value = "deepseek";
    defaultProviderSelect?.dispatchEvent({ type: "change", target: defaultProviderSelect });
    expect(settingsActions[settingsActions.length - 1]).toBe("edit:provider:deepseek");

    const providerSearch = pane?.querySelector(".desktop-settings-provider-search");
    providerSearch!.value = "deep";
    providerSearch?.dispatchEvent({ type: "input", target: providerSearch });
    const filteredCards = pane?.querySelectorAll(".desktop-settings-provider-card") ?? [];
    expect(filteredCards.map((card) => card.hidden)).toEqual([true, false, true]);

    settingsActions.length = 0;
    pane?.querySelector('[data-desktop-settings-action="addProvider"]')?.click();
    expect(settingsActions).toEqual(["edit:selectedProvider:custom-openai"]);

    settingsActions.length = 0;
    pane?.querySelector('[data-desktop-settings-provider-card="deepseek"]')
      ?.querySelector('[data-desktop-settings-provider-action="settings"]')
      ?.click();
    expect(settingsActions).toEqual(["edit:selectedProvider:deepseek"]);

    settingsActions.length = 0;
    pane?.querySelector('[data-desktop-settings-provider-card="deepseek"]')
      ?.querySelector('[data-desktop-settings-provider-action="toggle"]')
      ?.click();
    expect(settingsActions).toEqual(["edit:providerEnabled:deepseek:false"]);

    pane?.querySelector('[data-desktop-settings-provider-card="openai"]')
      ?.querySelector('[data-desktop-settings-provider-action="models"]')
      ?.click();
    expect(targetDocument.activeElement).toBe(pane?.querySelector('[data-desktop-settings-control="models"]'));

    const apiBaseInput = pane?.querySelector('[data-desktop-settings-control="apiBase"]');
    pane?.querySelector('[data-desktop-settings-provider-card="openai"]')
      ?.querySelector('[data-desktop-settings-provider-action="settings"]')
      ?.click();
    expect(targetDocument.activeElement).toBe(apiBaseInput);
  });

  test("allows custom model entry when no provider model catalog is loaded", () => {
    const targetDocument = new FakeDocument();
    const settingsActions: string[] = [];
    const settingsPane = buildDesktopSettingsPaneModel(
      buildDesktopSettingsFormState({
        agents: { defaults: { provider: "openai", model: "", active_profile: "work" } },
        providers: { profiles: { work: { provider: "openai", api_key: "sk-live", models: [] } } },
      }, [{ id: "openai", displayName: "OpenAI", status: "ready" }]),
      {
        lastSavedState: null,
        providerCatalog: [{ id: "openai", displayName: "OpenAI", status: "ready" }],
      },
    );

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
      settingsPane,
      settingsActions: {
        onSettingsAction: (event) => {
          if (event.action === "edit") {
            settingsActions.push(`${event.action}:${event.fieldId}:${String(event.value)}`);
          }
        },
      },
    });

    const modelInput = targetDocument.body.querySelector('[data-desktop-settings-control="model"]');
    expect(modelInput?.tagName).toBe("input");
    modelInput!.value = "custom-model";
    modelInput?.dispatchEvent({ type: "input", target: modelInput });
    expect(settingsActions).toEqual(["edit:model:custom-model"]);
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
    expect(pane?.querySelector(".desktop-settings-status-card")).toBeNull();
    expect(pane?.querySelector(".desktop-settings-default-llm-card")).not.toBeNull();
    expect(pane?.querySelector('[data-desktop-settings-provider-card="openai"]')?.textContent).toContain("OpenAI");
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
    expect(findEntityRow(pane, "tools", "exec")?.textContent).toContain("Command");
    expect(findEntityRow(pane, "skills", "planner")?.textContent).toContain("planner");

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
    expect(findEntityRow(pane, "tools", "read_file")?.textContent).toContain("Read file");
    expect(findEntityRow(pane, "skills", "reviewer")?.textContent).toContain("reviewer");
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
    expect(pane?.querySelector(".desktop-knowledge-workbench-grid")?.getAttribute("data-desktop-knowledge-layout")).toBe(
      "filters-graph-detail-results",
    );
    expect(pane?.querySelectorAll("[data-desktop-knowledge-region]").map((node) => node.getAttribute("data-desktop-knowledge-region"))).toEqual([
      "filters",
      "graph",
      "detail",
      "results",
    ]);
    expect(pane?.textContent).toContain("Knowledge");
    expect(pane?.textContent).toContain("1 doc / readiness 100% / graph 1 nodes / 0 edges");
    expect(pane?.textContent).toContain("Knowledge enabled");
    expect(pane?.querySelector('[data-desktop-knowledge-region="filters"]')?.textContent).toContain("Desktop UX: indexed / 4 chunks");
    expect(findEntityRow(pane, "knowledge", "doc-1")?.textContent).toContain("Desktop UX");
    expect(pane?.querySelector('[data-desktop-knowledge-region="detail"]')?.textContent).toContain("Document detail: Desktop UX");
    expect(pane?.querySelector('[data-desktop-knowledge-region="detail"]')?.textContent).toContain("docs/desktop.md / indexed / 4 chunks");
    expect(pane?.querySelector('[data-desktop-knowledge-region="results"]')?.textContent).toContain("Query: desktop");
    expect(pane?.querySelector('[data-desktop-knowledge-region="results"]')?.textContent).toContain("Results: 1");
    expect(pane?.querySelector('[data-desktop-knowledge-region="graph"]')?.textContent).toContain("Graph: 1 nodes / 0 edges / 0 evidence");
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
    expect(pane?.querySelector(".desktop-cowork-session-row")?.getAttribute("data-desktop-entity-module")).toBe("cowork");
    expect(pane?.querySelector(".desktop-cowork-session-row")?.getAttribute("data-desktop-entity-id")).toBe("cowork-1");
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

  test("routes approval task center actions", () => {
    const targetDocument = new FakeDocument();
    const actionEvents: string[] = [];
    const taskCenterItems = buildDesktopTaskCenterItems({
      approvals: [
        {
          id: "approval:approval-1",
          title: "Approve shell command",
          status: "waiting",
          detail: "Run local command",
          canonical: { module: "approvals", entityId: "approval-1", href: "/chat/WebSocket%3Achat-1" },
          approval: { approvalId: "approval-1", sessionKey: "WebSocket:chat-1" },
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
        onTaskAction: ({ action, item }) => actionEvents.push(`${action}:${item.approval?.approvalId}:${item.approval?.sessionKey}`),
      },
    });

    const row = targetDocument.body.querySelector('[data-desktop-task-id="approval:approval-1"]');
    expect(row?.querySelectorAll(".desktop-task-action").map((action) => action.getAttribute("data-desktop-task-action"))).toEqual([
      "approveOnce",
      "approveSession",
      "deny",
      "open",
      "inspect",
    ]);

    row?.querySelector('[data-desktop-task-action="approveOnce"]')?.click();
    row?.querySelector('[data-desktop-task-action="approveSession"]')?.click();
    row?.querySelector('[data-desktop-task-action="deny"]')?.click();

    expect(actionEvents).toEqual([
      "approveOnce:approval-1:WebSocket:chat-1",
      "approveSession:approval-1:WebSocket:chat-1",
      "deny:approval-1:WebSocket:chat-1",
    ]);
  });

  test("renders a desktop workspace file surface with recent files and save affordances", () => {
    const targetDocument = new FakeDocument();

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
      chat: {
        sessions: [{ key: "WebSocket:chat-live", chatId: "chat-live", title: "Live session", createdAt: "", updatedAt: "" }],
        activeSessionKey: "WebSocket:chat-live",
        activeChatId: "chat-live",
        messages: [],
      },
    });

    expect(targetDocument.getElementById("desktop-workspace-recent-files")?.getAttribute("aria-label")).toBe("Recent workspace files");
    expect(targetDocument.getElementById("desktop-workspace-status")?.textContent).toContain("0 files");
    expect(targetDocument.getElementById("desktop-workspace-active-path")?.textContent).toContain("No workspace file selected");
    expect(targetDocument.getElementById("desktop-workspace-updated-at")?.textContent).toContain("No timestamp");
    expect(targetDocument.getElementById("desktop-workspace-detail")?.textContent).toContain("No workspace file selected");
    expect(targetDocument.getElementById("desktop-workspace-search")?.getAttribute("placeholder")).toBe("Search workspace files...");
    expect(targetDocument.getElementById("desktop-workspace-size")?.textContent).toContain("No size");
    expect(targetDocument.getElementById("desktop-workspace-editor")?.getAttribute("aria-label")).toBe("Workspace file editor");
    expect(targetDocument.getElementById("desktop-workspace-save")?.getAttribute("disabled")).toBe("");
    expect(targetDocument.getElementById("desktop-workspace-reveal")?.getAttribute("disabled")).toBe("");
    expect(targetDocument.getElementById("desktop-workspace-export")?.getAttribute("disabled")).toBe("");
    expect(targetDocument.getElementById("desktop-workspace-reload")?.getAttribute("disabled")).toBe("");
    expect(targetDocument.getElementById("desktop-workspace-save-state")?.textContent).toContain("Select a workspace file");
    expect(targetDocument.getElementById("desktop-workspace-error")?.textContent).toBe("");
  });

  test("groups the desktop Files page into native browser, detail, editor, and action regions", () => {
    const targetDocument = new FakeDocument();

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
    });

    const filesSurface = targetDocument.body.querySelector(".desktop-workspace-files");
    expect(filesSurface?.getAttribute("data-desktop-module-surface")).toBe("files workspace");
    expect(filesSurface?.getAttribute("data-desktop-workspace-layout")).toBe("source-browser-detail-actions");
    expect(filesSurface?.querySelector(".desktop-file-source-tree")?.getAttribute("aria-label")).toBe("File sources");
    expect(filesSurface?.querySelector(".desktop-file-source-tree")?.textContent).toContain("Session Files");
    expect(filesSurface?.querySelector(".desktop-file-source-tree")?.textContent).toContain("Knowledge Documents");
    expect(filesSurface?.querySelector(".desktop-file-source-tree")?.textContent).toContain("Workspace Files");
    expect(filesSurface?.querySelectorAll("[data-desktop-file-source]").map((node) => node.getAttribute("data-desktop-file-source"))).toEqual([
      "session",
      "knowledge",
      "workspace",
    ]);
    expect(filesSurface?.querySelectorAll(".desktop-file-scope-chip").map((node) => node.textContent)).toEqual([
      "All",
      "Session",
      "Knowledge",
      "Workspace",
    ]);
    expect(filesSurface?.querySelector(".desktop-workspace-browser")?.querySelector("#desktop-workspace-recent-files")).toBeTruthy();
    expect(filesSurface?.querySelector(".desktop-workspace-detail-panel")?.querySelector("#desktop-workspace-detail")).toBeTruthy();
    expect(filesSurface?.querySelector(".desktop-workspace-editor-panel")?.querySelector("#desktop-workspace-editor")).toBeTruthy();
    expect(filesSurface?.querySelector(".desktop-workspace-action-rail")?.getAttribute("aria-label")).toBe("Workspace file actions");
    expect(filesSurface?.querySelector(".desktop-workspace-action-rail")?.querySelector("#desktop-workspace-save")).toBeTruthy();
    expect(filesSurface?.querySelector(".desktop-workspace-action-rail")?.querySelector("#desktop-workspace-reload")).toBeTruthy();
  });

  test("keeps the desktop Files workspace grid shrinkable inside the main work area", () => {
    const targetDocument = new FakeDocument();

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
    });

    const styleText = targetDocument.head.querySelector("#desktop-workbench-shell-style")?.textContent ?? "";
    expect(styleText).not.toContain("grid-template-columns: minmax(220px, 0.78fr) minmax(0, 1.55fr) minmax(150px, 0.48fr);");
    expect(styleText).toContain("grid-template-columns: minmax(180px, 0.62fr) minmax(240px, 0.9fr) minmax(300px, 1.5fr) minmax(160px, 0.7fr);");
    expect(styleText).toContain('"source browser detail actions"');
    expect(styleText).toContain(".desktop-file-source-tree");
    expect(styleText).toContain(".desktop-file-source-row");
    expect(styleText).toContain(".desktop-workspace-file-row > span");
    expect(styleText).toContain(".desktop-workspace-file-path");
    expect(styleText).toContain(".desktop-workspace-file-meta");
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

  test("keeps the activity rail at its native width when both side panels are collapsed", () => {
    const targetDocument = new FakeDocument();

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: {
        ...createDefaultWorkbenchLayout(),
        sidebar: { visible: false, size: 260 },
        inspector: { visible: false, size: 360 },
      },
      gatewayHttp: "http://127.0.0.1:18790",
    });

    const styleText = targetDocument.head.querySelector("#desktop-workbench-shell-style")?.textContent ?? "";
    expect(targetDocument.getElementById("desktop-workbench-shell")?.getAttribute("data-sidebar-visible")).toBe("false");
    expect(targetDocument.getElementById("desktop-workbench-shell")?.getAttribute("data-inspector-visible")).toBe("false");
    expect(styleText).toContain(
      'body.desktop-native-workbench .desktop-workbench-shell[data-sidebar-visible="false"][data-inspector-visible="false"] {\n      grid-template-columns: 92px 0 minmax(0, 1fr) 0;',
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

    const tokenText = targetDocument.head.querySelector("#desktop-design-tokens")?.textContent;
    const styleText = targetDocument.head.querySelector("#desktop-workbench-shell-style")?.textContent;
    expect(tokenText).toContain("--bg: #faf9f5;");
    expect(tokenText).toContain("--panel-strong: #faf9f5;");
    expect(tokenText).toContain("--primary: var(--accent);");
    expect(tokenText).toContain("--surface-dark: #181715;");
    expect(tokenText).toContain("--border: #e6dfd8;");
    expect(tokenText).toContain('--font-display: "Cormorant Garamond"');
    expect(styleText).not.toContain(":root {");
  });

  test("declares dark theme overrides for native workbench surfaces", () => {
    const targetDocument = new FakeDocument();

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
    });

    const styleText = targetDocument.head.querySelector("#desktop-workbench-shell-style")?.textContent;
    expect(styleText).toContain('html[data-theme="dark"] body.desktop-native-workbench .desktop-activity-rail');
    expect(styleText).toContain('html[data-theme="dark"] body.desktop-native-workbench .desktop-workbench-sidebar');
    expect(styleText).toContain('html[data-theme="dark"] body.desktop-native-workbench .desktop-chat-workbench');
    expect(styleText).toContain('html[data-theme="dark"] body.desktop-native-workbench .desktop-native-composer');
    expect(styleText).toContain('html[data-theme="dark"] body.desktop-native-workbench .desktop-inspector-content');
    expect(styleText).toContain('html[data-theme="dark"] body.desktop-native-workbench .desktop-settings-pane');
    expect(styleText).toContain('html[data-theme="dark"] body.desktop-native-workbench .desktop-workspace-files');
    expect(styleText).toContain('html[data-theme="dark"] body.desktop-native-workbench .desktop-sidebar-chat-row[data-active="true"]');
    expect(styleText).toContain('html[data-theme="dark"] body.desktop-native-workbench .desktop-sidebar-chat-row:hover');
    expect(styleText).toContain('html[data-theme="dark"] body.desktop-native-workbench .desktop-chat-header h1');
    expect(styleText).toContain('html[data-theme="dark"] body.desktop-native-workbench .desktop-conversation-content');
    expect(styleText).toContain('html[data-theme="dark"] body.desktop-native-workbench .desktop-chat-menu-popover');
    expect(styleText).toContain('html[data-theme="dark"] body.desktop-native-workbench .desktop-sidebar-search');
    expect(styleText).toContain('html[data-theme="dark"] body.desktop-native-workbench .desktop-native-composer-model');
  });

  test("keeps settings module chrome and content columns from overlapping", () => {
    const targetDocument = new FakeDocument();

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
    });

    const styleText = targetDocument.head.querySelector("#desktop-workbench-shell-style")?.textContent ?? "";
    expect(styleText).toContain('html[data-desktop-active-workbench-module="settings"] body.desktop-native-workbench .desktop-workbench-shell {\n      grid-template-columns: 92px');
    expect(styleText).toContain('html[data-desktop-active-workbench-module="settings"] body.desktop-native-workbench .desktop-workbench-shell[data-sidebar-visible="false"] {\n      grid-template-columns: 92px 0');
    expect(styleText).toContain("body.desktop-native-workbench .desktop-settings-pane > .n-config-provider {\n      display: contents;");
  });

  test("renders a bottom composer-like surface for native visual parity", () => {
    const targetDocument = new FakeDocument();

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
    });

    const composer = targetDocument.getElementById("desktop-native-composer");
    expect(composer?.getAttribute("aria-label")).toBe("Native desktop composer");
    expect(targetDocument.body.querySelector(".desktop-native-composer-context")).toBeNull();
    expect(targetDocument.body.querySelectorAll(".desktop-native-composer-chip")).toHaveLength(0);
    expect(targetDocument.getElementById("desktop-native-composer-input")?.getAttribute("aria-label")).toBe("Native composer input");
    expect(targetDocument.getElementById("desktop-native-composer-input")?.getAttribute("placeholder")).toBe("Ask Tinybot");
    expect(targetDocument.getElementById("desktop-native-composer-input")?.getAttribute("rows")).toBe("1");
    expect(targetDocument.getElementById("desktop-native-composer-input")?.getAttribute("data-max-rows")).toBe("3");
    expect(targetDocument.getElementById("desktop-native-composer-attach")?.getAttribute("data-desktop-composer-action")).toBe("attach");
    expect(targetDocument.getElementById("desktop-native-composer-send")?.getAttribute("data-desktop-composer-action")).toBe("send");
    expect(targetDocument.getElementById("desktop-native-composer-send")?.textContent).not.toContain("Send");
    expect(targetDocument.getElementById("desktop-native-composer-send")?.querySelector('[data-desktop-composer-send-icon="true"]')).not.toBeNull();
    const ragToggle = targetDocument.body.querySelector('[data-desktop-composer-action="rag-toggle"]');
    expect(ragToggle?.textContent).toBe("RAG");
    expect(ragToggle?.textContent).not.toContain("On");
    expect(ragToggle?.textContent).not.toContain("Off");
    expect(targetDocument.getElementById("desktop-native-composer-microphone")).toBeNull();
    expect(targetDocument.getElementById("desktop-native-composer-runtime")?.textContent).toContain("Tinybot Pro");
    expect(targetDocument.body.querySelector(".desktop-native-token-orb")?.getAttribute("data-token-usage")).toBe("0");
  });

  test("declares non-overlapping native workbench layout rules for composer, scroll, modules, and inspector", () => {
    const targetDocument = new FakeDocument();

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
    });

    const styleText = targetDocument.head.querySelector("#desktop-workbench-shell-style")?.textContent ?? "";
    expect(styleText).toContain("grid-template-columns: 92px minmax(220px, 280px) minmax(0, 1fr) minmax(280px, 340px);");
    expect(styleText).toContain('grid-template-areas: "input input input" "attach runtime send";');
    expect(styleText).toContain("body.desktop-native-workbench .desktop-native-composer-layout {");
    expect(styleText).toContain("display: grid;");
    expect(styleText).toContain("grid-template-rows: auto auto;");
    expect(styleText).not.toContain(".desktop-native-composer-context {\n      grid-area: context;");
    expect(styleText).not.toContain("microphone");
    expect(styleText).toContain("border-radius: 24px;");
    expect(styleText).toContain("padding: 14px 8px 8px 14px;");
    expect(styleText).toContain("min-height: 0;");
    expect(styleText).not.toContain("min-height: 118px;");
    expect(styleText).not.toContain("min-height: 88px;");
    expect(styleText).not.toContain("margin-left: 10px;");
    expect(styleText).toContain(".desktop-native-composer-runtime {\n      grid-area: runtime;");
    expect(styleText).toContain("body.desktop-native-workbench .desktop-conversation-thread {\n      display: grid;");
    expect(styleText).toContain("overflow-y: auto;");
    expect(styleText).toContain("--desktop-chat-column-width: clamp(720px, calc(100vw - 240px), 1760px);");
    expect(styleText).toContain("--desktop-chat-gutter: clamp(16px, 2vw, 36px);");
    expect(styleText).toContain("--desktop-chat-composer-gutter: clamp(32px, 4vw, 72px);");
    expect(styleText).toContain("body.desktop-native-workbench .desktop-chat-workbench {");
    expect(styleText).toContain("align-self: stretch;");
    expect(styleText).toContain("height: 100%;");
    expect(styleText).toContain("padding: 0 var(--desktop-chat-gutter);");
    expect(styleText).toContain("width: min(var(--desktop-chat-column-width), 100%);");
    expect(styleText).toContain("width: min(var(--desktop-chat-column-width), calc(100% - var(--desktop-chat-composer-gutter)));");
    expect(styleText).toContain("body.desktop-native-workbench .desktop-conversation-layout {\n      display: grid;\n      grid-template-columns: minmax(0, 1fr) 0;");
    expect(styleText).toContain("grid-template-columns 320ms cubic-bezier(0.16, 1, 0.3, 1);");
    expect(styleText).toContain("body.desktop-native-workbench .desktop-conversation-layout[data-detail-panel-state=\"open\"] {\n      column-gap: 18px;\n      grid-template-columns: minmax(0, 1fr) minmax(300px, var(--desktop-tool-detail-width, 50%));");
    expect(styleText).toContain("body.desktop-native-workbench .desktop-conversation-layout[data-detail-panel-state=\"closing\"] {\n      column-gap: 0;\n      grid-template-columns: minmax(0, 1fr) 0;");
    expect(styleText).toContain("body.desktop-native-workbench .desktop-detail-panel-slot {\n      position: sticky;\n      top: 0;");
    expect(styleText).toContain("body.desktop-native-workbench .desktop-detail-panel-slot[data-detail-panel-state=\"closing\"] {");
    expect(styleText).toContain("body.desktop-native-workbench .desktop-tool-detail-panel {\n      position: relative;");
    expect(styleText).toContain("opacity 260ms cubic-bezier(0.33, 0, 0.2, 1)");
    expect(styleText).toContain("transform 360ms cubic-bezier(0.16, 1, 0.3, 1)");
    expect(styleText).toContain("transform 340ms cubic-bezier(0.7, 0, 0.84, 0)");
    expect(styleText).toContain("body.desktop-native-workbench .desktop-conversation-timeline {\n      display: grid;\n      gap: 6px;\n      min-width: 0;\n      width: 100%;");
    expect(styleText).toContain("body.desktop-native-workbench .desktop-conversation-message[data-message-tone=\"user\"] .desktop-user-message-bubble {\n      box-sizing: border-box;\n      width: fit-content;\n      max-width: min(100%, var(--desktop-chat-column-width));");
    expect(styleText).not.toContain("max-width: min(75%, 640px);");
    expect(styleText).toContain("body.desktop-native-workbench .desktop-conversation-header {\n      display: flex;\n      align-items: baseline;\n      justify-content: flex-start;");
    expect(styleText).toContain("body.desktop-native-workbench .desktop-message-reasoning-toggle {\n      display: flex;\n      align-items: center;\n      gap: 5px;\n      width: fit-content;\n      margin-left: 0;");
    expect(styleText).not.toContain("body.desktop-native-workbench .desktop-message-reasoning-toggle {\n      display: flex;\n      align-items: center;\n      gap: 5px;\n      width: fit-content;\n      margin-left: auto;");
    expect(styleText).toContain("body.desktop-native-workbench .desktop-conversation-content-card .n-card-content {\n      padding: 0;");
    expect(styleText).toContain("body.desktop-native-workbench .desktop-assistant-step-list {\n      display: grid;\n      gap: 6px;");
    expect(styleText).toContain("--desktop-composer-reserve: 36px;");
    expect(styleText).toContain("padding: 18px 0 var(--desktop-composer-reserve);");
    expect(styleText).toContain("gap: 10px;");
    expect(styleText).toContain("grid-template-rows: minmax(0, 1fr) auto 0;");
    expect(styleText).toContain("margin: 0 auto 8px;");
    expect(styleText).toContain("margin: 16px 16px 16px 0;");
    expect(styleText).toContain("border-radius: 14px;");
    expect(styleText).toContain(".desktop-status-strip {\n      height: 0;");
    expect(styleText).toContain('html[data-desktop-active-workbench-module="files"] body.desktop-native-workbench .desktop-utility-surfaces');
    expect(styleText).toContain("[data-desktop-module-surface]");
    expect(styleText).toContain(".desktop-activity-button[data-active=\"true\"]");
    expect(styleText).toContain(".desktop-workbench-link[data-active=\"true\"]");
    expect(styleText).toContain(".desktop-inspector-content {\n      display: grid;");
    expect(styleText).toContain("overflow-x: hidden;");
  });

  test("reserves dark product surfaces for diagnostics instead of the runtime panel", () => {
    const targetDocument = new FakeDocument();

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
    });

    const styleText = targetDocument.head.querySelector("#desktop-workbench-shell-style")?.textContent;
    expect(styleText).toContain(".desktop-gateway-runtime");
    expect(styleText).toContain("background: var(--panel);");
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
    const chat = {
      sessions: [{ key: "WebSocket:chat-live", chatId: "chat-live", title: "Live session", createdAt: "", updatedAt: "" }],
      activeSessionKey: "WebSocket:chat-live",
      activeChatId: "chat-live",
      messages: [],
    };

    installDesktopWorkbenchShell({
      targetDocument: targetDocument as unknown as Document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
      chat,
    });

    expect(targetDocument.body.querySelector(".desktop-empty-session")?.textContent).not.toContain("without leaving");
    expect(targetDocument.body.querySelector(".desktop-empty-session")?.textContent).toContain("Start a new session");
    expect(targetDocument.body.querySelector(".desktop-empty-session")?.textContent).toContain(
      "Ask Tinybot about the workspace, inspect files, or create a task.",
    );
    expect(targetDocument.body.querySelector(".desktop-empty-session")?.textContent).not.toContain("sessionStart");
    expect(targetDocument.body.querySelector(".desktop-empty-session")?.textContent).not.toContain("session.Start");
  });
});
