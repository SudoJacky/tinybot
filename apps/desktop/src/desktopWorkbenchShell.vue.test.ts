// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { createDefaultWorkbenchLayout } from "./desktopWorkbenchLayout";
import { installDesktopWorkbenchShell, type DesktopNativeChatModel } from "./desktopWorkbenchShell";

describe("desktop workbench shell Vue integration", () => {
  test("renders the activity rail through the Vue shell island", () => {
    document.body.replaceChildren();
    document.head.replaceChildren();

    installDesktopWorkbenchShell({
      targetDocument: document,
      layout: createDefaultWorkbenchLayout(),
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

    installDesktopWorkbenchShell({
      targetDocument: document,
      layout: createDefaultWorkbenchLayout(),
      gatewayHttp: "http://127.0.0.1:18790",
    });

    const workbench = document.querySelector<HTMLElement>(".desktop-chat-workbench-chrome");
    expect(workbench?.getAttribute("data-desktop-vue-island")).toBe("chat-workbench");
    expect(workbench?.textContent).toContain("Ready for a new session");
    expect(workbench?.textContent).toContain("Start from chat, inspect workspace, or check gateway status.");
    expect(workbench?.querySelector(".desktop-quick-actions")?.getAttribute("data-desktop-vue-island")).toBe("quick-actions");
    expect(workbench?.querySelector(".desktop-panel-controls")?.getAttribute("data-desktop-vue-island")).toBe("panel-controls");
    expect(workbench?.querySelector('[data-desktop-panel-control="sidebar"]')?.getAttribute("aria-pressed")).toBe("true");
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
