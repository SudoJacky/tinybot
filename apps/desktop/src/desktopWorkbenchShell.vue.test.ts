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
    expect(rail?.querySelector('[data-desktop-module-target="files"]')?.textContent).toBe("Files");
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
    document.body.click();
    expect(menu?.getAttribute("aria-expanded")).toBe("false");
    expect(popover?.hidden).toBe(true);
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
    expect(actions.every((action) => action.querySelector(".desktop-chat-menu-action") === null)).toBe(true);
    expect(popover?.querySelector(".desktop-chat-menu-popover-card")).toBeNull();
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
    const titleRow = document.querySelector<HTMLElement>(".desktop-chat-title-row");
    const actions = document.querySelector<HTMLElement>(".desktop-chat-header-actions");
    const sidebar = titleRow?.querySelector<HTMLButtonElement>('[data-desktop-panel-control="sidebar"]');
    const inspector = actions?.querySelector<HTMLButtonElement>('[data-desktop-panel-control="inspector"]');

    expect(actions?.getAttribute("data-desktop-vue-island")).toBe("chat-header-actions");
    expect(actions?.querySelector('[data-desktop-panel-control="sidebar"]')).toBeNull();
    expect(titleRow?.children[0]?.getAttribute("data-desktop-panel-control")).toBe("sidebar");
    expect(sidebar?.getAttribute("aria-label")).toBe("Collapse session list");
    expect(sidebar?.getAttribute("aria-pressed")).toBe("true");
    expect(inspector?.getAttribute("aria-label")).toBe("Open Activity inspector");
    expect(inspector?.getAttribute("aria-pressed")).toBe("false");
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
    expect(workbench?.querySelector(".desktop-quick-actions")).toBeNull();
    expect(workbench?.querySelectorAll(".desktop-quick-action")).toHaveLength(0);
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

    for (const [region, visible] of [["sidebar", "true"], ["inspector", "false"], ["bottom", "false"]]) {
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
    expect(row?.getAttribute("href")).toBe("/files");
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

  test("updates mounted sidebar recent chats when native chat sessions refresh", async () => {
    document.body.replaceChildren();
    document.head.replaceChildren();

    installDesktopWorkbenchShell({
      targetDocument: document,
      layout: createDefaultWorkbenchLayout(),
      chat: {
        activeChatId: "chat-1",
        activeSessionKey: "WebSocket:chat-1",
        messages: [],
        sessions: [
          { chatId: "chat-1", createdAt: "", key: "WebSocket:chat-1", title: "Session one", updatedAt: "2026-06-07T08:11:00.000Z" },
          { chatId: "chat-2", createdAt: "", key: "WebSocket:chat-2", title: "Session two", updatedAt: "2026-06-07T08:12:00.000Z" },
        ],
      },
      gatewayHttp: "http://127.0.0.1:18790",
    });
    await nextTick();

    expect(Array.from(document.querySelectorAll(".desktop-sidebar-chat-row")).map((row) => row.getAttribute("data-desktop-session-key"))).toEqual([
      "WebSocket:chat-1",
      "WebSocket:chat-2",
    ]);

    updateDesktopNativeChat(document, {
      activeChatId: "chat-1",
      activeSessionKey: "WebSocket:chat-1",
      messages: [],
      sessions: [
        { chatId: "chat-1", createdAt: "", key: "WebSocket:chat-1", title: "Session one updated", updatedAt: "2026-06-07T08:13:00.000Z" },
      ],
    });
    await nextTick();

    expect(Array.from(document.querySelectorAll(".desktop-sidebar-chat-row")).map((row) => row.getAttribute("data-desktop-session-key"))).toEqual([
      "WebSocket:chat-1",
    ]);
    expect(document.body.textContent).toContain("Session one updated");
    expect(document.body.textContent).not.toContain("Session two");
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
    expect(thread?.getAttribute("aria-label")).toBe("Message Timeline");
    expect(thread?.textContent).not.toContain("No messages in this session.");
    expect(document.querySelector(".desktop-chat-workbench-chrome")?.textContent).toContain("Start a new session");
  });

  test("embeds active chat Cowork runs and inspectable references in the native chat timeline", async () => {
    document.body.replaceChildren();
    document.head.replaceChildren();

    installDesktopWorkbenchShell({
      targetDocument: document,
      layout: createDefaultWorkbenchLayout(),
      chat: {
        activeChatId: "chat-live",
        activeSessionKey: "WebSocket:chat-live",
        messages: [{
          role: "assistant",
          content: "I used memory and started Cowork.",
          reasoningContent: "",
          timestamp: "2026-06-07T03:04:06.000Z",
          messageId: "assistant-1",
          references: [{ kind: "memory", title: "memory/MEMORY.md:42", detail: "Saved preference" }],
        }],
        sessions: [{ chatId: "chat-live", createdAt: "", key: "WebSocket:chat-live", title: "Live session", updatedAt: "" }],
      },
      coworkPane: {
        sessionRows: [{
          activeAgentCount: 1,
          agentCount: 1,
          attention: {
            agentIssues: 0,
            approvals: 0,
            blockers: 0,
            interventions: 0,
            label: "No attention needed",
            pendingReplies: 0,
            taskIssues: 0,
            tone: "normal",
            total: 0,
            workUnitIssues: 0,
          },
          finalOutput: "Cowork summary ready.",
          goal: "Match WebUI chat flow",
          id: "cowork-1",
          meta: "",
          raw: { id: "cowork-1", origin_chat_id: "chat-live" },
          status: "running",
          taskProgress: { blocked: 0, completed: 1, failed: 0, total: 2 },
          title: "Native chat parity",
          updatedAt: "",
          workflow: "Adaptive Starter",
        }],
        cockpitView: {
          agents: [{
            attention: { label: "", state: "normal", tone: "normal" },
            id: "agent-1",
            label: "Planner",
            latestActivity: "drafted plan",
            meta: "",
            raw: { id: "agent-1" },
            roleOrTask: "Plan desktop changes",
            status: "running",
          }],
          artifacts: [],
          branches: [],
          graph: { caption: "", edges: [], nodes: [] },
          header: {
            goal: "Match WebUI chat flow",
            id: "cowork-1",
            status: "running",
            title: "Native chat parity",
            updatedAt: "",
            workflow: "Adaptive Starter",
          },
          inspector: { body: "", id: "cowork-1", payloadText: "", raw: null, rows: [], title: "", type: "session" },
          mailbox: [],
          observabilityPanels: [],
          raw: { id: "cowork-1", origin_chat_id: "chat-live" },
          taskCenterItems: [],
          tasks: [],
          threads: [],
          trace: [],
          workUnits: [],
        },
      },
      gatewayHttp: "http://127.0.0.1:18790",
    });
    await nextTick();
    await nextTick();

    const thread = document.querySelector<HTMLElement>(".desktop-conversation-thread");
    expect(thread?.querySelector(".desktop-chat-cowork-surface")?.textContent).toContain("Native chat parity");
    expect(thread?.querySelector(".desktop-chat-cowork-surface")?.textContent).toContain("Cowork summary ready.");
    expect(thread?.querySelector('[data-desktop-cowork-agent-id="agent-1"]')?.textContent).toContain("Planner");
    expect(thread?.querySelector(".desktop-message-reference-item")?.getAttribute("role")).toBe("button");
    expect(thread?.querySelector(".desktop-message-reference-item")?.getAttribute("tabindex")).toBe("0");
  });

  test("uses inline Cowork runs as chat timeline content instead of showing the empty chat prompt", async () => {
    document.body.replaceChildren();
    document.head.replaceChildren();

    installDesktopWorkbenchShell({
      targetDocument: document,
      layout: createDefaultWorkbenchLayout(),
      chat: {
        activeChatId: "chat-live",
        activeSessionKey: "WebSocket:chat-live",
        messages: [],
        sessions: [{ chatId: "chat-live", createdAt: "", key: "WebSocket:chat-live", title: "Live session", updatedAt: "" }],
      },
      coworkPane: {
        sessionRows: [{
          activeAgentCount: 0,
          agentCount: 0,
          attention: {
            agentIssues: 0,
            approvals: 0,
            blockers: 0,
            interventions: 0,
            label: "No attention needed",
            pendingReplies: 0,
            taskIssues: 0,
            tone: "normal",
            total: 0,
            workUnitIssues: 0,
          },
          finalOutput: "",
          goal: "Match WebUI chat flow",
          id: "cowork-1",
          meta: "",
          raw: { id: "cowork-1", origin_chat_id: "chat-live" },
          status: "running",
          taskProgress: { blocked: 0, completed: 0, failed: 0, total: 0 },
          title: "Native chat parity",
          updatedAt: "",
          workflow: "Adaptive Starter",
        }],
      },
      gatewayHttp: "http://127.0.0.1:18790",
    });
    await nextTick();
    await nextTick();

    expect(document.querySelector(".desktop-conversation-thread")?.textContent).toContain("Native chat parity");
    expect(document.querySelector(".desktop-chat-workbench")?.textContent).not.toContain("Start a new session");
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
    setScrollMetrics(thread!, { scrollHeight: 2000, clientHeight: 400 });
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

  test("keeps the native composer editable while chat stream updates", async () => {
    document.body.replaceChildren();
    document.head.replaceChildren();

    const chat: DesktopNativeChatModel = {
      activeChatId: "chat-live",
      activeSessionKey: "WebSocket:chat-live",
      messages: [{
        role: "user",
        content: "Start",
        reasoningContent: "",
        timestamp: "2026-06-07T03:04:05.000Z",
        messageId: "user-1",
      }],
      runtime: {
        model: "deepseek-chat",
        tokenUsage: "10%",
      },
      sessions: [{
        chatId: "chat-live",
        createdAt: "",
        key: "WebSocket:chat-live",
        title: "Live session",
        updatedAt: "",
      }],
      usePersistentRag: true,
    };

    installDesktopWorkbenchShell({
      targetDocument: document,
      layout: createDefaultWorkbenchLayout(),
      chat,
      gatewayHttp: "http://127.0.0.1:18790",
    });
    await nextTick();

    const composer = document.getElementById("desktop-native-composer");
    const input = document.getElementById("desktop-native-composer-input") as HTMLTextAreaElement | null;
    const send = document.getElementById("desktop-native-composer-send") as HTMLButtonElement | null;
    input!.value = "Draft while streaming";
    input!.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();

    updateDesktopNativeChat(document, {
      ...chat,
      messages: [
        ...chat.messages,
        {
          role: "assistant",
          content: "first streamed chunk",
          reasoningContent: "",
          timestamp: "2026-06-07T03:04:06.000Z",
          messageId: "assistant-stream",
        },
      ],
      responding: true,
      composerState: "sending",
      runtime: {
        model: "deepseek-v4-flash",
        tokenUsage: "57%",
      },
    }, "http://127.0.0.1:18790");
    await nextTick();

    expect(document.getElementById("desktop-native-composer")).toBe(composer);
    expect(document.getElementById("desktop-native-composer-input")).toBe(input);
    expect(input?.value).toBe("Draft while streaming");
    expect(send?.getAttribute("disabled")).toBe("");
    expect(composer?.querySelector("#desktop-native-composer-runtime")?.textContent).toContain("deepseek-v4-flash");
    expect(composer?.querySelector(".desktop-native-token-orb")?.getAttribute("data-token-usage")).toBe("57");
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
