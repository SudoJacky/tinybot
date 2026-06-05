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
    expect(shell?.getAttribute("data-inspector-visible")).toBe("true");
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

    expect(targetDocument.body.querySelector(".desktop-empty-session")?.textContent).toContain("Ready for a new session");
    expect(targetDocument.body.querySelectorAll(".desktop-quick-action").map((node) => node.textContent)).toEqual([
      "New chat",
      "Open workspace",
      "Gateway status",
    ]);
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
        references: [{ kind: "tool", title: "read_file", detail: "docs/desktop.md" }],
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
        responding: false,
      },
    });

    const shellText = targetDocument.body.textContent;
    expect(shellText).toContain("Live gateway session");
    expect(shellText).toContain("Please summarize the live runtime state.");
    expect(shellText).toContain("The native workbench is rendering gateway data.");
    expect(shellText).toContain("Checked active session metadata.");
    expect(shellText).toContain("tool: read_file");
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
    const reasoning = message?.querySelector(".desktop-message-reasoning");
    const toolActivity = message?.querySelector(".desktop-tool-activity");
    const body = message?.querySelector(".desktop-conversation-body");

    expect(reasoning?.tagName).toBe("details");
    expect(reasoning?.querySelector(".desktop-message-reasoning-title")?.textContent).toBe("Thinking");
    expect(reasoning?.textContent).toContain("I should inspect the workspace first.");
    expect(toolActivity?.tagName).toBe("details");
    expect(toolActivity?.querySelector(".desktop-tool-activity-title")?.textContent).toBe("shell");
    expect(toolActivity?.querySelector(".desktop-tool-activity-badge")?.textContent).toBe("Result");
    expect(toolActivity?.textContent).toContain("Arguments");
    expect(toolActivity?.textContent).toContain("{\"command\":\"pwd\"}");
    expect(toolActivity?.textContent).toContain("Response");
    expect(toolActivity?.textContent).toContain("D:/code/tinybot/tinybot");
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
    expect(message?.querySelector(".desktop-tool-activity")?.textContent).toContain("stdout: done");
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
    });

    const styleText = targetDocument.head.querySelector("#desktop-workbench-shell-style")?.textContent ?? "";
    expect(styleText).toContain(".desktop-native-composer-input:focus-visible {\n      outline: 0;");
    expect(styleText).toContain("resize: none;");
    expect(styleText).not.toContain(".desktop-native-composer-input:focus-visible,\n    body.desktop-native-workbench .desktop-native-composer-action:focus-visible");
    expect(styleText).toContain(".desktop-native-composer-send:not(:disabled)");
    expect(styleText).toContain("width: 36px;\n      min-width: 36px;\n      height: 36px;\n      min-height: 36px;");
    expect(styleText).toContain(".desktop-native-token-orb {\n      width: 36px;\n      height: 36px;");
    expect(styleText).toContain("min-height: 38px;\n      max-height: none;");
    expect(styleText).toContain("overflow-y: visible;");
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
    expect(sidebarStyle).toContain("grid-template-rows: auto auto auto");
    expect(sidebarStyle).toContain(".desktop-sidebar-list-section-recent");
    expect(sidebarStyle).toContain("max-height: min(42vh, 360px)");

    const chatHeader = targetDocument.body.querySelector(".desktop-chat-header");
    const conversationThread = targetDocument.body.querySelector(".desktop-conversation-thread");
    const composerModel = targetDocument.body.querySelector(".desktop-native-composer-model");
    expect(chatHeader).toBeTruthy();
    expect(conversationThread).toBeTruthy();
    expect(composerModel).toBeTruthy();
    expect(chatHeader?.textContent).toContain("Design native workbench");
    expect(conversationThread?.textContent).toContain("这是目前的 native 界面");
    expect(composerModel?.textContent).toContain("Tinybot Pro");

    const inspector = targetDocument.body.querySelector(".desktop-inspector-content");
    const runTabs = targetDocument.body.querySelector(".desktop-run-chain-tabs");
    const runCards = targetDocument.body.querySelector(".desktop-run-chain-cards");
    const runNewItem = targetDocument.body.querySelector(".desktop-run-chain-new-item");
    expect(inspector).toBeTruthy();
    expect(runTabs).toBeTruthy();
    expect(runCards).toBeTruthy();
    expect(runNewItem).toBeTruthy();
    expect(inspector?.textContent).toContain("Run Chain");
    expect(runTabs?.textContent).toContain("Context");
    expect(runCards?.textContent).toContain("Gateway");
    targetDocument.body.querySelector('[data-desktop-run-chain-tab="files"]')?.click();
    expect(runCards?.textContent).toContain("Workspace");
    expect(runNewItem?.textContent).toContain("New Run Chain Item");
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
    expect([
      ...targetDocument.body.querySelectorAll(".desktop-activity-button"),
      ...targetDocument.body.querySelectorAll(".desktop-activity-secondary-button"),
    ].filter((node) => node.getAttribute("href") === "/workspace")).toHaveLength(1);
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
    expect(activityButtons.map((node) => node.getAttribute("href"))).toEqual(["/chat", "/workspace", "/knowledge", "/cowork"]);
    expect(activityButtons.map((node) => node.getAttribute("aria-label"))).toEqual(["Chat", "Files", "Knowledge", "Cowork"]);
    expect(activityButtons.map((node) => node.textContent)).toEqual(["Chat", "Files", "Knowledge", "Cowork"]);
    expect(activityButtons.map((node) => node.getAttribute("data-desktop-module-target"))).toEqual(["chat", "workspace", "knowledge", "cowork"]);
    expect(activityButtons.map((node) => node.getAttribute("data-focus-order"))).toEqual([
      "activity-1",
      "activity-2",
      "activity-3",
      "activity-4",
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
    expect(header?.querySelector('[data-desktop-panel-control="sidebar"]')?.getAttribute("aria-label")).toBe("Collapse session list");
    expect(header?.querySelector('[data-desktop-panel-control="inspector"]')?.getAttribute("aria-label")).toBe("Close Run Chain panel");
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

    const controls = targetDocument.body.querySelectorAll(".desktop-panel-control");
    expect(controls.map((node) => node.getAttribute("data-desktop-panel-control"))).toEqual(["sidebar", "inspector", "bottom"]);
    expect(controls.map((node) => node.getAttribute("aria-label"))).toEqual([
      "Toggle sidebar panel",
      "Toggle Run Chain panel",
      "Toggle task and runtime panel",
    ]);
    expect(controls.map((node) => node.textContent)).toEqual(["Sidebar", "Run Chain", "Tasks"]);
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
    expect(targetDocument.body.querySelector("[data-desktop-route-status]")?.textContent).toContain("Run Chain panel hidden");
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
    expect(panel?.getAttribute("data-desktop-run-chain-panel")).toBe("context");
    expect(panel?.textContent).toContain("Endpoint");

    overview?.querySelector('[data-desktop-run-chain-tab="files"]')?.click();
    expect(overview?.querySelector('[data-desktop-run-chain-tab="files"]')?.getAttribute("aria-selected")).toBe("true");
    expect(panel?.getAttribute("data-desktop-run-chain-panel")).toBe("files");
    expect(panel?.textContent).toContain("Workspace");
    expect(panel?.textContent).toContain("Open Workspace");

    overview?.querySelector('[data-desktop-run-chain-tab="tasks"]')?.click();
    expect(overview?.querySelector('[data-desktop-run-chain-tab="tasks"]')?.getAttribute("aria-selected")).toBe("true");
    expect(panel?.getAttribute("data-desktop-run-chain-panel")).toBe("tasks");
    expect(panel?.textContent).toContain("Current Run");
    expect(panel?.textContent).toContain("New Run Chain Item");

    overview?.querySelector('[data-desktop-run-chain-summary="gateway"]')?.click();
    expect(overview?.querySelector('[data-desktop-run-chain-tab="context"]')?.getAttribute("aria-selected")).toBe("true");
    expect(overview?.querySelector('[data-desktop-run-chain-tab="tasks"]')?.getAttribute("aria-selected")).toBe("false");
    expect(panel?.getAttribute("data-desktop-run-chain-panel")).toBe("context");

    overview?.querySelector('[data-desktop-run-chain-summary="items"]')?.click();
    expect(overview?.querySelector('[data-desktop-run-chain-tab="context"]')?.getAttribute("aria-selected")).toBe("false");
    expect(overview?.querySelector('[data-desktop-run-chain-tab="tasks"]')?.getAttribute("aria-selected")).toBe("true");
    expect(panel?.getAttribute("data-desktop-run-chain-panel")).toBe("tasks");

    const pin = overview?.querySelector('[data-desktop-run-chain-control="pin"]');
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

    targetDocument.body.querySelector('[data-desktop-run-chain-control="close"]')?.click();
    expect(targetDocument.getElementById("desktop-workbench-shell")?.getAttribute("data-inspector-visible")).toBe("false");
    expect(targetDocument.body.querySelector('[data-workbench-region="inspector"]')?.getAttribute("data-visible")).toBe("false");
    expect(targetDocument.body.querySelector('[data-desktop-panel-control="inspector"]')?.getAttribute("aria-pressed")).toBe("false");
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
    expect(pane?.getAttribute("data-settings-layout")).toBe("codex-like");
    expect(pane?.querySelector(".desktop-settings-search")?.getAttribute("placeholder")).toBe("Search settings...");
    expect(pane?.querySelectorAll(".desktop-settings-nav-item").map((item) => item.textContent)).toEqual([
      "General",
      "Provider",
      "Knowledge",
      "Tools",
      "Gateway",
      "Channels",
    ]);
    expect(pane?.querySelector(".desktop-settings-nav-item")?.getAttribute("data-active")).toBe("true");
    expect(pane?.querySelector(".desktop-settings-content")?.textContent).toContain("设置 / 模型");
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
    expect(pane?.querySelectorAll(".desktop-settings-provider-card").map((card) => card.getAttribute("data-desktop-settings-provider-card"))).toEqual([
      "openai",
      "deepseek",
      "ollama",
    ]);
    expect(pane?.querySelector('[data-desktop-settings-group="agent"]')?.getAttribute("id")).toBe("desktop-settings-group-agent");
    expect(pane?.textContent).toContain("设置 / 模型");
    expect(pane?.textContent).toContain("Save: HTTP 400");
    expect(pane?.textContent).toContain("Validation: model, timezone");
    expect(pane?.textContent).toContain("Model: ");
    expect(pane?.textContent).toContain("Provider profile: work");
    expect(pane?.textContent).toContain("API key: ********");
    expect(pane?.textContent).toContain("Catalog: OpenAI (ready)");
    expect(pane?.textContent).toContain("Models: gpt-4.1, gpt-4.1-mini");
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

    const providerSelect = pane?.querySelector('[data-desktop-settings-control="selectedProvider"]');
    providerSelect!.value = "deepseek";
    providerSelect?.dispatchEvent({ type: "change", target: providerSelect });
    expect(settingsActions[settingsActions.length - 1]).toBe("edit:selectedProvider:deepseek");

    const providerSearch = pane?.querySelector(".desktop-settings-provider-search");
    providerSearch!.value = "deep";
    providerSearch?.dispatchEvent({ type: "input", target: providerSearch });
    const filteredCards = pane?.querySelectorAll(".desktop-settings-provider-card") ?? [];
    expect(filteredCards.map((card) => card.hidden)).toEqual([true, false, true]);

    settingsActions.length = 0;
    pane?.querySelector('[data-desktop-settings-action="addProvider"]')?.click();
    expect(settingsActions).toEqual(["edit:selectedProvider:deepseek"]);

    settingsActions.length = 0;
    pane?.querySelector('[data-desktop-settings-provider-card="deepseek"]')
      ?.querySelector('[data-desktop-settings-provider-action="settings"]')
      ?.click();
    expect(settingsActions).toEqual(["edit:selectedProvider:deepseek"]);

    pane?.querySelector('[data-desktop-settings-provider-card="openai"]')
      ?.querySelector('[data-desktop-settings-provider-action="models"]')
      ?.click();
    expect(targetDocument.activeElement).toBe(modelInput);

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
    expect(pane?.textContent).toContain("Knowledge");
    expect(pane?.textContent).toContain("1 doc / readiness 100% / graph 1 nodes / 0 edges");
    expect(pane?.textContent).toContain("Knowledge enabled");
    expect(pane?.textContent).toContain("Desktop UX: indexed / 4 chunks");
    expect(findEntityRow(pane, "knowledge", "doc-1")?.textContent).toContain("Desktop UX");
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
    expect(filesSurface?.getAttribute("data-desktop-workspace-layout")).toBe("browser-detail-actions");
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
    expect(styleText).not.toContain("grid-template-columns: minmax(190px, 260px) minmax(280px, 1fr) minmax(120px, 160px);");
    expect(styleText).toContain("grid-template-columns: minmax(220px, 0.78fr) minmax(0, 1.55fr) minmax(150px, 0.48fr);");
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
    expect(targetDocument.getElementById("desktop-native-composer-input")?.getAttribute("aria-label")).toBe("Native composer input");
    expect(targetDocument.getElementById("desktop-native-composer-input")?.getAttribute("placeholder")).toBe("Ask Tinybot");
    expect(targetDocument.getElementById("desktop-native-composer-attach")?.getAttribute("data-desktop-composer-action")).toBe("attach");
    expect(targetDocument.getElementById("desktop-native-composer-send")?.getAttribute("data-desktop-composer-action")).toBe("send");
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
    expect(styleText).not.toContain("microphone");
    expect(styleText).toContain("border-radius: 24px;");
    expect(styleText).toContain("min-height: 118px;");
    expect(styleText).toContain(".desktop-native-composer-runtime {\n      grid-area: runtime;");
    expect(styleText).toContain("body.desktop-native-workbench .desktop-conversation-thread {\n      display: grid;");
    expect(styleText).toContain("min-height: 0;");
    expect(styleText).toContain("overflow-y: auto;");
    expect(styleText).toContain("body.desktop-native-workbench .desktop-chat-workbench {\n      align-self: stretch;");
    expect(styleText).toContain("height: 100%;");
    expect(styleText).toContain("grid-template-rows: minmax(0, 1fr) auto 0;");
    expect(styleText).toContain("margin: 0 auto 8px;");
    expect(styleText).toContain(".desktop-status-strip {\n      height: 0;");
    expect(styleText).toContain('html[data-desktop-active-workbench-module="workspace"] body.desktop-native-workbench .desktop-utility-surfaces');
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
