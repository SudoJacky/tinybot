// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { nextTick } from "vue";
import { createDefaultWorkbenchLayout } from "./desktopWorkbenchLayout";
import { installDesktopWorkbenchShell, updateDesktopNativeChat, type DesktopNativeChatModel } from "./desktopWorkbenchShell";

function setScrollMetrics(element: HTMLElement, metrics: { scrollHeight: number; clientHeight: number }): void {
  Object.defineProperty(element, "scrollHeight", { configurable: true, value: metrics.scrollHeight });
  Object.defineProperty(element, "clientHeight", { configurable: true, value: metrics.clientHeight });
}

describe("desktop workbench shell Vue integration", () => {
  test("renders the activity rail through the Vue shell island", () => {
    document.body.replaceChildren();
    document.head.replaceChildren();

    installDesktopWorkbenchShell({
      targetDocument: document,
      layout: createDefaultWorkbenchLayout(),
      chat: {
        sessions: [{ key: "WebSocket:chat-live", chatId: "chat-live", title: "Live session", createdAt: "", updatedAt: "" }],
        activeSessionKey: "WebSocket:chat-live",
        activeChatId: "chat-live",
        messages: [],
      },
      gatewayHttp: "http://127.0.0.1:18790",
    });

    const rail = document.querySelector<HTMLElement>(".desktop-activity-rail");
    expect(rail?.getAttribute("data-desktop-vue-island")).toBe("activity-rail");
    expect(rail?.getAttribute("aria-label")).toBe("Desktop workbench modules");
    expect(rail?.querySelector('[data-desktop-module-target="chat"]')?.getAttribute("aria-current")).toBe("page");
    expect(rail?.querySelector('[data-desktop-module-target="workspace"]')?.textContent).toBe("Files");
    expect(rail?.querySelector('[data-desktop-module-target="settings"]')?.getAttribute("href")).toBe("/settings");
  });

  test("renders the command palette through the Vue shell island", () => {
    document.body.replaceChildren();
    document.head.replaceChildren();

    installDesktopWorkbenchShell({
      targetDocument: document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
    });

    const palette = document.getElementById("desktop-command-palette");
    expect(palette?.getAttribute("data-desktop-vue-island")).toBe("command-palette");
    expect(palette?.getAttribute("role")).toBe("dialog");
    expect(document.getElementById("desktop-command-palette-input")?.getAttribute("aria-label")).toBe("Search commands and workbench data");
    expect(document.getElementById("desktop-command-palette-results")?.getAttribute("aria-live")).toBe("polite");
  });

  test("renders the status strip through the Vue shell island", () => {
    document.body.replaceChildren();
    document.head.replaceChildren();

    installDesktopWorkbenchShell({
      targetDocument: document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
    });

    const status = document.querySelector<HTMLElement>(".desktop-status-strip");
    expect(status?.getAttribute("data-desktop-vue-island")).toBe("status-strip");
    expect(status?.getAttribute("data-desktop-route-status")).toBe("");
    expect(status?.textContent).toContain("No workspace file selected");
    expect(status?.textContent).toContain("http://127.0.0.1:18790");
  });

  test("renders the active chat title through the Vue shell island", () => {
    document.body.replaceChildren();
    document.head.replaceChildren();

    const chat: DesktopNativeChatModel = {
      activeChatId: "chat-live",
      activeSessionKey: "WebSocket:chat-live",
      messages: [],
      sessions: [{
        chatId: "chat-live",
        createdAt: "",
        key: "WebSocket:chat-live",
        title: "Live session",
        updatedAt: "",
      }],
    };

    installDesktopWorkbenchShell({
      targetDocument: document,
      layout: createDefaultWorkbenchLayout(),
      chat,
      gatewayHttp: "http://127.0.0.1:18790",
    });

    const title = document.querySelector<HTMLElement>(".desktop-chat-title");
    expect(title?.getAttribute("data-desktop-vue-island")).toBe("chat-title");
    expect(title?.textContent).toBe("Live session");
  });

  test("renders the chat menu trigger through the Vue shell island", () => {
    document.body.replaceChildren();
    document.head.replaceChildren();

    const chat: DesktopNativeChatModel = {
      activeChatId: "chat-live",
      activeSessionKey: "WebSocket:chat-live",
      messages: [],
      sessions: [{
        chatId: "chat-live",
        createdAt: "",
        key: "WebSocket:chat-live",
        title: "Live session",
        updatedAt: "",
      }],
    };

    installDesktopWorkbenchShell({
      targetDocument: document,
      layout: createDefaultWorkbenchLayout(),
      chat,
      gatewayHttp: "http://127.0.0.1:18790",
    });

    const menu = document.querySelector<HTMLButtonElement>(".desktop-chat-menu");
    const popover = document.querySelector<HTMLElement>(".desktop-chat-menu-popover");
    expect(menu?.getAttribute("data-desktop-vue-island")).toBe("chat-menu-button");
    expect(menu?.getAttribute("aria-expanded")).toBe("false");
    expect(menu?.textContent).toBe("...");
    expect(popover?.hidden).toBe(true);

    menu?.click();

    expect(menu?.getAttribute("aria-expanded")).toBe("true");
    expect(popover?.hidden).toBe(false);
  });

  test("renders the chat menu popover through the Vue shell island", () => {
    document.body.replaceChildren();
    document.head.replaceChildren();

    const chat: DesktopNativeChatModel = {
      activeChatId: "chat-live",
      activeSessionKey: "WebSocket:chat-live",
      messages: [],
      sessions: [{
        chatId: "chat-live",
        createdAt: "",
        key: "WebSocket:chat-live",
        title: "Live session",
        updatedAt: "",
      }],
    };

    installDesktopWorkbenchShell({
      targetDocument: document,
      layout: createDefaultWorkbenchLayout(),
      chat,
      gatewayHttp: "http://127.0.0.1:18790",
    });

    const popover = document.querySelector<HTMLElement>(".desktop-chat-menu-popover");
    const actions = Array.from(document.querySelectorAll<HTMLElement>(".desktop-chat-menu-action"));
    expect(popover?.getAttribute("data-desktop-vue-island")).toBe("chat-menu-popover");
    expect(popover?.getAttribute("role")).toBe("menu");
    expect(popover?.getAttribute("aria-label")).toBe("Chat session actions");
    expect(actions.map((action) => action.getAttribute("data-desktop-vue-island"))).toEqual([
      "chat-menu-action",
      "chat-menu-action",
      "chat-menu-action",
    ]);
    expect(actions.map((action) => action.textContent)).toEqual([
      "Pin session",
      "Rename session",
      "New chat",
    ]);
  });

  test("renders chat header panel actions through the Vue shell island", () => {
    document.body.replaceChildren();
    document.head.replaceChildren();

    installDesktopWorkbenchShell({
      targetDocument: document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
    });

    const shell = document.getElementById("desktop-workbench-shell");
    const actions = document.querySelector<HTMLElement>(".desktop-chat-header-actions");
    const sidebar = actions?.querySelector<HTMLButtonElement>('[data-desktop-panel-control="sidebar"]');
    const inspector = actions?.querySelector<HTMLButtonElement>('[data-desktop-panel-control="inspector"]');

    expect(actions?.getAttribute("data-desktop-vue-island")).toBe("chat-header-actions");
    expect(sidebar?.getAttribute("aria-label")).toBe("Collapse session list");
    expect(sidebar?.getAttribute("aria-pressed")).toBe("true");
    expect(inspector?.getAttribute("aria-label")).toBe("Close Run Chain panel");
    expect(inspector?.getAttribute("aria-pressed")).toBe("true");
    expect(shell?.getAttribute("data-sidebar-visible")).toBe("true");

    sidebar?.click();

    expect(shell?.getAttribute("data-sidebar-visible")).toBe("false");
  });

  test("renders the chat workbench chrome through the Vue shell island", () => {
    document.body.replaceChildren();
    document.head.replaceChildren();
    const chat = {
      sessions: [{ key: "WebSocket:chat-live", chatId: "chat-live", title: "Live session", createdAt: "", updatedAt: "" }],
      activeSessionKey: "WebSocket:chat-live",
      activeChatId: "chat-live",
      messages: [],
    };

    installDesktopWorkbenchShell({
      targetDocument: document,
      layout: createDefaultWorkbenchLayout(),
      chat,
      gatewayHttp: "http://127.0.0.1:18790",
    });

    const workbench = document.querySelector<HTMLElement>(".desktop-chat-workbench-chrome");
    expect(workbench?.getAttribute("data-desktop-vue-island")).toBe("chat-workbench");
    expect(workbench?.textContent).toContain("Start a new session");
    expect(workbench?.textContent).toContain("Ask Tinybot about the workspace, inspect files, or create a task.");
    expect(workbench?.textContent).not.toContain("sessionStart");
    expect(workbench?.textContent).not.toContain("session.Start");
    expect(workbench?.querySelector(".desktop-quick-actions")?.getAttribute("data-desktop-vue-island")).toBe("quick-actions");
    expect(workbench?.querySelector(".desktop-panel-controls")).toBeNull();
  });

  test("renders the main utility surfaces through the Vue shell island", () => {
    document.body.replaceChildren();
    document.head.replaceChildren();

    installDesktopWorkbenchShell({
      targetDocument: document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
    });

    const utilities = document.querySelector<HTMLElement>(".desktop-utility-surfaces");
    expect(utilities?.getAttribute("data-desktop-vue-island")).toBe("main-utilities-region");
    expect(utilities?.querySelector("#desktop-command-palette")?.getAttribute("data-desktop-vue-island")).toBe("command-palette");
    expect(utilities?.querySelector(".desktop-file-actions")?.getAttribute("data-desktop-vue-island")).toBe("file-actions-surface");
    expect(utilities?.querySelector(".desktop-help-pane")?.getAttribute("data-desktop-vue-island")).toBe("help-surface");
    expect(utilities?.querySelector(".desktop-workspace-files")?.getAttribute("data-desktop-vue-island")).toBe("workspace-files-surface");
  });

  test("renders the bottom region through the Vue shell island", () => {
    document.body.replaceChildren();
    document.head.replaceChildren();

    installDesktopWorkbenchShell({
      targetDocument: document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
    });

    const bottom = document.querySelector<HTMLElement>(".desktop-bottom-content");
    expect(bottom?.getAttribute("data-desktop-vue-island")).toBe("bottom-region");
    expect(bottom?.querySelector("#desktop-task-center")?.getAttribute("data-desktop-vue-island")).toBe("task-center");
    expect(bottom?.querySelector("#desktop-task-center")?.getAttribute("aria-label")).toBe("Background task center");
    expect(bottom?.querySelector(".desktop-gateway-runtime")?.getAttribute("data-desktop-vue-island")).toBe("gateway-runtime");
    expect(bottom?.querySelector(".desktop-gateway-runtime")?.getAttribute("aria-label")).toBe("Gateway runtime controls");
  });

  test("renders workbench panel shells through the Vue shell island", () => {
    document.body.replaceChildren();
    document.head.replaceChildren();

    installDesktopWorkbenchShell({
      targetDocument: document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
    });

    for (const [region, visible] of [["sidebar", "true"], ["inspector", "true"], ["bottom", "false"]]) {
      const panel = document.querySelector<HTMLElement>(`[data-workbench-region="${region}"]`);
      expect(panel?.getAttribute("data-desktop-vue-island")).toBe("workbench-panel");
      expect(panel?.getAttribute("data-visible")).toBe(visible);
      expect(panel?.querySelector(".desktop-workbench-panel-content")).not.toBeNull();
    }
  });

  test("renders sidebar content through the Vue shell island", () => {
    document.body.replaceChildren();
    document.head.replaceChildren();

    const chat: DesktopNativeChatModel = {
      activeChatId: "chat-live",
      activeSessionKey: "WebSocket:chat-live",
      messages: [],
      sessions: [{
        chatId: "chat-live",
        createdAt: "",
        key: "WebSocket:chat-live",
        title: "Live session",
        updatedAt: "",
      }],
    };

    installDesktopWorkbenchShell({
      targetDocument: document,
      layout: createDefaultWorkbenchLayout(),
      chat,
      gatewayHttp: "http://127.0.0.1:18790",
    });

    const sidebar = document.querySelector<HTMLElement>(".desktop-sidebar-content");
    expect(sidebar?.getAttribute("data-desktop-vue-island")).toBe("sidebar-content");
    expect(sidebar?.querySelector(".desktop-sidebar-actions")?.getAttribute("data-desktop-vue-island")).toBe("sidebar-actions");
    expect(sidebar?.querySelector(".desktop-sidebar-list-section-workspaces")?.getAttribute("data-desktop-vue-island")).toBe("sidebar-workspace-list");
    expect(sidebar?.querySelector(".desktop-sidebar-list-section-recent")?.getAttribute("data-desktop-vue-island")).toBe("sidebar-recent-chats");
    expect(sidebar?.querySelector('[data-desktop-session-key="WebSocket:chat-live"]')?.textContent).toContain("Live session");
  });

  test("renders sidebar actions through the Vue shell island without an active chat", () => {
    document.body.replaceChildren();
    document.head.replaceChildren();

    installDesktopWorkbenchShell({
      targetDocument: document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
    });

    const actions = document.querySelector<HTMLElement>(".desktop-sidebar-actions");
    expect(actions?.getAttribute("data-desktop-vue-island")).toBe("sidebar-actions");
    expect(actions?.querySelector(".desktop-sidebar-primary-action")?.getAttribute("href")).toBe("/chat/new");
    expect(actions?.querySelector(".desktop-sidebar-search")?.getAttribute("type")).toBe("search");
  });

  test("renders sidebar workspace list through the Vue shell island without an active chat", () => {
    document.body.replaceChildren();
    document.head.replaceChildren();

    installDesktopWorkbenchShell({
      targetDocument: document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
    });

    const workspaces = document.querySelector<HTMLElement>(".desktop-sidebar-list-section-workspaces");
    const row = workspaces?.querySelector<HTMLAnchorElement>(".desktop-sidebar-row");
    expect(workspaces?.getAttribute("data-desktop-vue-island")).toBe("sidebar-workspace-list");
    expect(workspaces?.querySelector(".desktop-sidebar-section-heading h2")?.textContent).toBe("Workspaces");
    expect(row?.getAttribute("href")).toBe("/workspace");
    expect(row?.getAttribute("data-desktop-entity-id")).toBe("tinybot");
    expect(row?.getAttribute("data-active")).toBe("true");
  });

  test("renders sidebar recent chats through the Vue shell island without an active chat", () => {
    document.body.replaceChildren();
    document.head.replaceChildren();

    installDesktopWorkbenchShell({
      targetDocument: document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
    });

    const recent = document.querySelector<HTMLElement>(".desktop-sidebar-list-section-recent");
    expect(recent?.getAttribute("data-desktop-vue-island")).toBe("sidebar-recent-chats");
    expect(recent?.querySelector(".desktop-sidebar-section-heading h2")?.textContent).toBe("Recent chats");
    expect(recent?.querySelector(".desktop-recent-chat-list")?.getAttribute("role")).toBe("list");
    expect(recent?.querySelector('[data-desktop-chat-id="Design native workbench"]')?.textContent).toContain("Design native workbench");
  });

  test("renders an empty conversation thread through the Vue shell island", () => {
    document.body.replaceChildren();
    document.head.replaceChildren();

    const chat: DesktopNativeChatModel = {
      activeChatId: "chat-live",
      activeSessionKey: "WebSocket:chat-live",
      messages: [],
      sessions: [{
        chatId: "chat-live",
        createdAt: "",
        key: "WebSocket:chat-live",
        title: "Live session",
        updatedAt: "",
      }],
    };

    installDesktopWorkbenchShell({
      targetDocument: document,
      layout: createDefaultWorkbenchLayout(),
      chat,
      gatewayHttp: "http://127.0.0.1:18790",
    });

    const thread = document.querySelector<HTMLElement>(".desktop-conversation-thread");
    expect(thread?.getAttribute("data-desktop-vue-island")).toBe("conversation-thread");
    expect(thread?.getAttribute("aria-label")).toBe("Conversation");
    expect(thread?.textContent).not.toContain("No messages in this session.");
    expect(document.querySelector(".desktop-chat-workbench-chrome")?.textContent).toContain("Start a new session");
  });

  test("keeps conversation scroll stable when live chat messages rerender", async () => {
    document.body.replaceChildren();
    document.head.replaceChildren();

    const chat: DesktopNativeChatModel = {
      activeChatId: "chat-live",
      activeSessionKey: "WebSocket:chat-live",
      messages: [{
        role: "user",
        content: "查看下工作目录中有什么内容",
        reasoningContent: "",
        timestamp: "2026-06-07T03:04:05.000Z",
        messageId: "user-1",
      }],
      sessions: [{
        chatId: "chat-live",
        createdAt: "",
        key: "WebSocket:chat-live",
        title: "Live session",
        updatedAt: "",
      }],
    };

    installDesktopWorkbenchShell({
      targetDocument: document,
      layout: createDefaultWorkbenchLayout(),
      chat,
      gatewayHttp: "http://127.0.0.1:18790",
    });
    await nextTick();

    const thread = document.querySelector<HTMLElement>(".desktop-conversation-thread");
    expect(thread).toBeTruthy();
    setScrollMetrics(thread!, { scrollHeight: 1600, clientHeight: 400 });
    thread!.scrollTop = 640;
    const originalReplaceChildren = HTMLElement.prototype.replaceChildren;
    HTMLElement.prototype.replaceChildren = function replaceChildrenWithScrollReset(...nodes: Node[]) {
      originalReplaceChildren.apply(this, nodes);
      if (this.classList.contains("desktop-conversation-thread")) {
        this.scrollTop = 0;
      }
    };
    try {
      updateDesktopNativeChat(document, {
        ...chat,
        messages: [
          ...chat.messages,
          {
            role: "assistant",
            content: "workspace contents are streaming",
            reasoningContent: "",
            timestamp: "2026-06-07T03:04:06.000Z",
            messageId: "assistant-stream",
          },
        ],
        responding: true,
      }, "http://127.0.0.1:18790");
    } finally {
      HTMLElement.prototype.replaceChildren = originalReplaceChildren;
    }
    await nextTick();

    expect(thread!.scrollTop).toBe(640);
    expect(thread!.textContent).toContain("workspace contents are streaming");

    setScrollMetrics(thread!, { scrollHeight: 1600, clientHeight: 400 });
    thread!.scrollTop = 1190;
    HTMLElement.prototype.replaceChildren = function replaceChildrenWithGrowingScrollReset(...nodes: Node[]) {
      originalReplaceChildren.apply(this, nodes);
      if (this.classList.contains("desktop-conversation-thread")) {
        setScrollMetrics(this, { scrollHeight: 2000, clientHeight: 400 });
        this.scrollTop = 0;
      }
    };
    try {
      updateDesktopNativeChat(document, {
        ...chat,
        messages: [
          ...chat.messages,
          {
            role: "assistant",
            content: "workspace contents are streaming",
            reasoningContent: "",
            timestamp: "2026-06-07T03:04:06.000Z",
            messageId: "assistant-stream",
          },
          {
            role: "assistant",
            content: "second chunk",
            reasoningContent: "",
            timestamp: "2026-06-07T03:04:07.000Z",
            messageId: "assistant-stream-2",
          },
        ],
        responding: true,
      }, "http://127.0.0.1:18790");
    } finally {
      HTMLElement.prototype.replaceChildren = originalReplaceChildren;
    }
    await nextTick();

    expect(thread!.scrollTop).toBe(1590);
    expect(thread!.textContent).toContain("second chunk");
  });

  test("renders fallback conversation messages through the Vue shell island without an active chat", () => {
    document.body.replaceChildren();
    document.head.replaceChildren();

    installDesktopWorkbenchShell({
      targetDocument: document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
    });

    const messages = document.querySelectorAll<HTMLElement>(".desktop-conversation-message");
    expect(messages.length).toBeGreaterThanOrEqual(2);
    expect(messages[0]?.getAttribute("data-desktop-vue-island")).toBe("conversation-message");
    expect(messages[0]?.getAttribute("data-message-tone")).toBe("user");
    expect(messages[1]?.getAttribute("data-desktop-vue-island")).toBe("conversation-message");
    expect(messages[1]?.getAttribute("data-message-tone")).toBe("assistant");
    expect(messages[1]?.querySelector(".desktop-conversation-attachment")?.textContent).toContain("tinybot_native_workbench_design.png");
  });

  test("renders the native composer through the Vue shell island", async () => {
    document.body.replaceChildren();
    document.head.replaceChildren();

    const submissions: unknown[] = [];
    const chat: DesktopNativeChatModel = {
      activeChatId: "chat-live",
      activeSessionKey: "WebSocket:chat-live",
      messages: [],
      runtime: {
        model: "deepseek-chat",
        tokenUsage: "42%",
      },
      sessions: [{
        chatId: "chat-live",
        createdAt: "",
        key: "WebSocket:chat-live",
        title: "Live session",
        updatedAt: "",
      }],
      usePersistentRag: false,
    };

    installDesktopWorkbenchShell({
      targetDocument: document,
      layout: createDefaultWorkbenchLayout(),
      chat,
      chatActions: {
        onComposerSubmit: (event) => submissions.push(event),
      },
      gatewayHttp: "http://127.0.0.1:18790",
    });

    const composer = document.getElementById("desktop-native-composer");
    const input = document.getElementById("desktop-native-composer-input") as HTMLTextAreaElement | null;
    const send = document.getElementById("desktop-native-composer-send") as HTMLButtonElement | null;
    expect(composer?.getAttribute("data-desktop-vue-island")).toBe("composer-surface");
    expect(composer?.getAttribute("data-active-session-key")).toBe("WebSocket:chat-live");
    expect(composer?.getAttribute("data-desktop-composer-rag")).toBe("false");
    const layout = composer?.querySelector(".desktop-native-composer-layout");
    expect(layout?.querySelector(":scope > #desktop-native-composer-input")).toBe(input);
    expect(layout?.querySelector(":scope > #desktop-native-composer-runtime")).not.toBeNull();
    expect(layout?.querySelector(":scope > #desktop-native-composer-send")).toBe(send);
    expect(composer?.querySelector("#desktop-native-composer-runtime")?.getAttribute("data-desktop-vue-island")).toBe("composer-runtime");
    expect(composer?.querySelector("#desktop-native-composer-runtime")?.textContent).toContain("deepseek-chat");
    expect(send?.getAttribute("disabled")).toBe("");

    input!.value = "Run from shell";
    input!.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    expect(send?.getAttribute("disabled")).toBeNull();
    send?.click();

    expect(submissions).toEqual([{ content: "Run from shell", usePersistentRag: false }]);
  });

  test("opens shortcut help through the Vue dialog island", () => {
    document.body.replaceChildren();
    document.head.replaceChildren();

    installDesktopWorkbenchShell({
      targetDocument: document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
    });

    document.dispatchEvent(new Event("tinybot:open-shortcut-help"));

    const dialog = document.getElementById("desktop-shortcut-help-dialog");
    const search = dialog?.querySelector<HTMLInputElement>(".desktop-shortcut-help-search");
    expect(dialog?.getAttribute("data-desktop-vue-island")).toBe("shortcut-help-dialog");
    expect(dialog?.getAttribute("role")).toBe("dialog");
    expect(dialog?.textContent).toContain("Keyboard shortcuts");
    expect(dialog?.textContent).toContain("Command palette");
    expect(search?.getAttribute("placeholder")).toBe("Search shortcuts");
    expect(document.activeElement).toBe(search);
  });
});
