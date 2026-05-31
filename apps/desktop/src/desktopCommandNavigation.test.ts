import { describe, expect, test } from "vitest";
import {
  DESKTOP_MENU_COMMANDS,
  installDesktopMenuCommandRouting,
  resolveDesktopShortcutCommand,
  routeDesktopMenuCommand,
  type DesktopMenuCommandContext,
} from "./desktopCommandNavigation";

class FakeCommandElement {
  public textContent = "";
  public dataset: Record<string, string> = {};
  private attributes = new Map<string, string>();

  constructor(attributes: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(attributes)) {
      this.setAttribute(key, value);
    }
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name.startsWith("data-")) {
      this.dataset[toDatasetKey(name)] = value;
    }
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
}

class FakeCommandDocument {
  public documentElement = { dataset: { theme: "light" } as Record<string, string> };
  public listeners = new Map<string, ((event: Event) => void)[]>();
  public shell = new FakeCommandElement({ id: "desktop-workbench-shell", "data-sidebar-visible": "true" });
  public sidebar = new FakeCommandElement({ "data-workbench-region": "sidebar", "data-visible": "true" });
  public sidebarControl = new FakeCommandElement({ "data-desktop-panel-control": "sidebar", "aria-pressed": "true" });
  public status = new FakeCommandElement({ "data-desktop-route-status": "" });
  public dispatched: string[] = [];

  addEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  dispatchEvent(event: Event): boolean {
    this.dispatched.push(event.type);
    for (const listener of this.listeners.get(event.type) ?? []) {
      listener(event);
    }
    return true;
  }

  querySelector(selector: string): FakeCommandElement | null {
    if (selector === "#desktop-workbench-shell") {
      return this.shell;
    }
    if (selector === "[data-workbench-region=\"sidebar\"]") {
      return this.sidebar;
    }
    if (selector === "[data-desktop-panel-control=\"sidebar\"]") {
      return this.sidebarControl;
    }
    if (selector === "[data-desktop-route-status]") {
      return this.status;
    }
    return null;
  }
}

function toDatasetKey(attribute: string): string {
  return attribute
    .slice("data-".length)
    .replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

describe("desktop command navigation", () => {
  test("defines application menu entries for core desktop commands", () => {
    expect(DESKTOP_MENU_COMMANDS.map((command) => command.id)).toEqual([
      "new-chat",
      "stop-generation",
      "search-sessions",
      "open-settings",
      "open-docs",
      "toggle-theme",
      "toggle-sidebar",
      "open-command-palette",
      "refresh-gateway-status",
    ]);
    expect(DESKTOP_MENU_COMMANDS.map((command) => command.label)).toEqual([
      "New Chat",
      "Stop Generation",
      "Search Sessions",
      "Settings",
      "Documentation",
      "Toggle Theme",
      "Toggle Sidebar",
      "Command Palette",
      "Gateway Status",
    ]);
    expect(DESKTOP_MENU_COMMANDS.map((command) => command.shortcut)).toEqual([
      "Ctrl+N",
      "Ctrl+.",
      "Ctrl+F",
      "Ctrl+,",
      "F1",
      "Ctrl+Shift+T",
      "Ctrl+B",
      "Ctrl+Shift+P",
      "Ctrl+Shift+G",
    ]);
  });

  test("routes menu commands to desktop navigation targets or command actions", () => {
    const context: DesktopMenuCommandContext = {
      activeGeneration: true,
      sidebarVisible: true,
      theme: "light",
    };

    expect(routeDesktopMenuCommand("new-chat", context)).toMatchObject({ kind: "navigate", href: "/chat/new" });
    expect(routeDesktopMenuCommand("search-sessions", context)).toMatchObject({ kind: "action", action: "open-session-search" });
    expect(routeDesktopMenuCommand("open-settings", context)).toMatchObject({ kind: "navigate", href: "/settings" });
    expect(routeDesktopMenuCommand("open-docs", context)).toMatchObject({ kind: "navigate", href: "/docs" });
    expect(routeDesktopMenuCommand("toggle-theme", context)).toMatchObject({ kind: "action", action: "set-theme", value: "dark" });
    expect(routeDesktopMenuCommand("toggle-sidebar", context)).toMatchObject({ kind: "action", action: "set-sidebar-visible", value: false });
    expect(routeDesktopMenuCommand("open-command-palette", context)).toMatchObject({ kind: "action", action: "open-command-palette" });
    expect(routeDesktopMenuCommand("refresh-gateway-status", context)).toMatchObject({ kind: "navigate", href: "/api/status" });
    expect(routeDesktopMenuCommand("stop-generation", context)).toMatchObject({ kind: "action", action: "stop-generation" });
  });

  test("reports unavailable menu commands without destructive fallback", () => {
    expect(routeDesktopMenuCommand("stop-generation", { activeGeneration: false, sidebarVisible: true, theme: "dark" })).toEqual({
      kind: "unavailable",
      feedback: "Stop generation is unavailable without an active response.",
    });
  });

  test("maps keyboard shortcuts to the same core command ids", () => {
    expect(resolveDesktopShortcutCommand({ key: "n", ctrlKey: true })).toBe("new-chat");
    expect(resolveDesktopShortcutCommand({ key: ".", ctrlKey: true })).toBe("stop-generation");
    expect(resolveDesktopShortcutCommand({ key: "f", ctrlKey: true })).toBe("search-sessions");
    expect(resolveDesktopShortcutCommand({ key: ",", ctrlKey: true })).toBe("open-settings");
    expect(resolveDesktopShortcutCommand({ key: "F1" })).toBe("open-docs");
    expect(resolveDesktopShortcutCommand({ key: "T", ctrlKey: true, shiftKey: true })).toBe("toggle-theme");
    expect(resolveDesktopShortcutCommand({ key: "b", ctrlKey: true })).toBe("toggle-sidebar");
    expect(resolveDesktopShortcutCommand({ key: "P", ctrlKey: true, shiftKey: true })).toBe("open-command-palette");
    expect(resolveDesktopShortcutCommand({ key: "G", ctrlKey: true, shiftKey: true })).toBe("refresh-gateway-status");
    expect(resolveDesktopShortcutCommand({ key: "n" })).toBeNull();
  });

  test("applies routed keyboard commands to panel state and unavailable feedback", () => {
    const targetDocument = new FakeCommandDocument();
    const targetWindow = {
      location: { origin: "http://localhost:1420" },
      history: { pushState: () => undefined },
      dispatchEvent: () => true,
    };
    installDesktopMenuCommandRouting({
      gatewayOrigin: "http://127.0.0.1:18790",
      listenToMenuCommand: () => undefined,
      targetDocument: targetDocument as unknown as Document,
      targetWindow: targetWindow as unknown as Window,
    });

    let togglePrevented = false;
    targetDocument.dispatchEvent({
      type: "keydown",
      key: "b",
      ctrlKey: true,
      preventDefault: () => {
        togglePrevented = true;
      },
    } as unknown as Event);

    expect(togglePrevented).toBe(true);
    expect(targetDocument.shell.getAttribute("data-sidebar-visible")).toBe("false");
    expect(targetDocument.sidebar.getAttribute("data-visible")).toBe("false");
    expect(targetDocument.sidebarControl.getAttribute("aria-pressed")).toBe("false");
    expect(targetDocument.status.textContent).toBe("Sidebar hidden");

    let stopPrevented = false;
    targetDocument.dispatchEvent({
      type: "keydown",
      key: ".",
      ctrlKey: true,
      preventDefault: () => {
        stopPrevented = true;
      },
    } as unknown as Event);

    expect(stopPrevented).toBe(true);
    expect(targetDocument.documentElement.dataset.desktopCommandFeedback).toBe(
      "Stop generation is unavailable without an active response.",
    );
    expect(targetDocument.status.textContent).toBe("Stop generation is unavailable without an active response.");
  });
});
