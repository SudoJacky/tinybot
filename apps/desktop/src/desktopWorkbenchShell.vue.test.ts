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
