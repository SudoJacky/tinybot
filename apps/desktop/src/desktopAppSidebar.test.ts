// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { renderDesktopAppSidebar } from "./desktopAppSidebar";
import {
  buildRootWebUiSidebarModel,
  buildRootWebUiWorkspaceContext,
  type DesktopSidebarItem,
} from "./desktopSharedModels";

function sidebarItems(): DesktopSidebarItem[] {
  return [
    {
      id: "session:active",
      kind: "session",
      label: "Desktop shell planning",
      meta: "2 min",
      active: true,
    },
    {
      id: "session:older",
      kind: "session",
      label: "Gateway follow-up",
      meta: "1 day",
    },
  ];
}

describe("desktop app sidebar", () => {
  test("renders action, workspace, and footer groups from the shared sidebar model", () => {
    const host = document.createElement("aside");
    host.className = "sidebar desktop-app-sidebar-card";
    const model = buildRootWebUiSidebarModel({
      workspace: buildRootWebUiWorkspaceContext({
        workspaceLabel: "tinybot",
        activeSession: { id: "active", title: "Desktop shell planning", meta: "2 min" },
      }),
      sessions: sidebarItems(),
    });

    renderDesktopAppSidebar(host, model, document);

    expect(host.getAttribute("data-desktop-vue-island")).toBe("desktop-app-sidebar");
    expect(host.getAttribute("data-desktop-app-sidebar")).toBe("true");
    expect(host.classList.contains("desktop-app-sidebar")).toBe(true);
    expect(host.classList.contains("desktop-app-sidebar-card")).toBe(false);
    expect(Array.from(host.querySelectorAll(".desktop-app-sidebar-group")).map((node) => node.getAttribute("data-sidebar-group"))).toEqual([
      "actions",
      "workspace",
      "footer",
    ]);
    expect(host.querySelector('[data-sidebar-group="workspace"]')?.textContent).toContain("tinybot");
    expect(Array.from(host.querySelectorAll(".desktop-app-sidebar-item")).map((node) => node.getAttribute("data-sidebar-item-kind"))).toContain("command");
    expect(Array.from(host.querySelectorAll(".desktop-app-sidebar-item")).map((node) => node.getAttribute("data-sidebar-item-kind"))).toContain("link");
    expect(Array.from(host.querySelectorAll(".desktop-app-sidebar-item")).map((node) => node.getAttribute("data-sidebar-item-kind"))).toContain("session");
  });

  test("keeps command, link, and selected session metadata on sidebar items", () => {
    const host = document.createElement("aside");
    const model = buildRootWebUiSidebarModel({ sessions: sidebarItems() });

    renderDesktopAppSidebar(host, model, document);

    const newChat = host.querySelector('[data-sidebar-command="new-chat"]');
    const tools = host.querySelector('[data-sidebar-href="/tools"]');
    const activeSession = host.querySelector('[data-sidebar-item-id="session:active"]');

    expect(newChat?.getAttribute("type")).toBe("button");
    expect(newChat?.getAttribute("data-sidebar-item-kind")).toBe("command");
    expect(newChat?.textContent).toContain("New");
    expect(tools?.getAttribute("href")).toBe("/tools");
    expect(tools?.getAttribute("data-sidebar-item-kind")).toBe("link");
    expect(activeSession?.getAttribute("aria-current")).toBe("page");
    expect(activeSession?.getAttribute("data-active")).toBe("true");
    expect(activeSession?.textContent).toContain("Desktop shell planning");
    expect(activeSession?.textContent).toContain("2 min");
  });

  test("dispatches sidebar commands through the desktop menu command event path", () => {
    const host = document.createElement("aside");
    const model = buildRootWebUiSidebarModel({ sessions: sidebarItems() });
    const events: Array<{ type: string; detail: unknown }> = [];
    document.addEventListener("desktop-menu-command", (event) => {
      events.push({ type: event.type, detail: (event as CustomEvent).detail });
    }, { once: true });

    renderDesktopAppSidebar(host, model, document);
    host.querySelector<HTMLButtonElement>('[data-sidebar-command="new-chat"]')?.click();

    expect(events).toEqual([
      {
        type: "desktop-menu-command",
        detail: { id: "new-chat", source: "desktop-sidebar" },
      },
    ]);
  });
});
