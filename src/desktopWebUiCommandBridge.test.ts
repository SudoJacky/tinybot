import { describe, expect, test } from "vitest";
import { installDesktopWebUiCommandBridge } from "./desktopWebUiCommandBridge";

class FakeButton {
  public clicks = 0;

  click(): void {
    this.clicks += 1;
  }
}

class FakeStatus {
  public textContent = "";
}

class FakeWebUiDocument {
  public documentElement = { dataset: {} as Record<string, string> };
  public listeners = new Map<string, Array<(event: Event) => unknown>>();
  public dispatched: string[] = [];
  public readonly nodes: Record<string, unknown> = {
    "#new-chat-button": new FakeButton(),
    "#settings-button": new FakeButton(),
    "#theme-toggle": new FakeButton(),
    "#sidebar-collapse-button": new FakeButton(),
    "#help-tour-button": new FakeButton(),
    "#tools-toggle": new FakeButton(),
    "#cowork-toggle": new FakeButton(),
    "[data-desktop-route-status]": new FakeStatus(),
  };

  addEventListener(type: string, listener: (event: Event) => unknown): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  dispatchEvent(event: Event): boolean {
    this.dispatched.push(event.type);
    for (const listener of this.listeners.get(event.type) ?? []) {
      listener(event);
    }
    return true;
  }

  querySelector(selector: string): unknown {
    return this.nodes[selector] ?? null;
  }
}

describe("desktop WebUI command bridge", () => {
  test("routes desktop menu commands to existing WebUI controls", () => {
    const document = new FakeWebUiDocument();

    installDesktopWebUiCommandBridge({
      targetDocument: document as unknown as Document,
      targetWindow: fakeWindow(),
      listenToMenuCommand: () => undefined,
    });

    document.dispatchEvent(new CustomEvent("desktop-menu-command", { detail: { id: "new-chat" } }));
    document.dispatchEvent(new CustomEvent("desktop-menu-command", { detail: { id: "open-settings" } }));
    document.dispatchEvent(new CustomEvent("desktop-menu-command", { detail: { id: "toggle-theme" } }));
    document.dispatchEvent(new CustomEvent("desktop-menu-command", { detail: { id: "toggle-sidebar" } }));
    document.dispatchEvent(new CustomEvent("desktop-menu-command", { detail: { id: "open-shortcut-help" } }));

    expect((document.nodes["#new-chat-button"] as FakeButton).clicks).toBe(1);
    expect((document.nodes["#settings-button"] as FakeButton).clicks).toBe(1);
    expect((document.nodes["#theme-toggle"] as FakeButton).clicks).toBe(1);
    expect((document.nodes["#sidebar-collapse-button"] as FakeButton).clicks).toBe(1);
    expect((document.nodes["#help-tour-button"] as FakeButton).clicks).toBe(1);
  });

  test("maps desktop keyboard shortcuts to WebUI controls and docs navigation", () => {
    const document = new FakeWebUiDocument();
    const assigned: string[] = [];

    installDesktopWebUiCommandBridge({
      targetDocument: document as unknown as Document,
      targetWindow: fakeWindow(assigned),
      listenToMenuCommand: () => undefined,
    });

    let newChatPrevented = false;
    document.dispatchEvent({
      type: "keydown",
      key: "n",
      ctrlKey: true,
      preventDefault: () => {
        newChatPrevented = true;
      },
    } as unknown as Event);
    document.dispatchEvent({
      type: "keydown",
      key: "F1",
      preventDefault: () => undefined,
    } as unknown as Event);

    expect(newChatPrevented).toBe(true);
    expect((document.nodes["#new-chat-button"] as FakeButton).clicks).toBe(1);
    expect(assigned).toEqual(["http://localhost:1420/docs"]);
  });

  test("listens to Tauri menu commands and reports commands without WebUI controls", () => {
    const document = new FakeWebUiDocument();
    const handlers: Array<(id: string) => void> = [];

    installDesktopWebUiCommandBridge({
      targetDocument: document as unknown as Document,
      targetWindow: fakeWindow(),
      listenToMenuCommand: (nextHandler) => {
        handlers.push(nextHandler);
      },
    });
    handlers[0]("stop-generation");

    expect(document.documentElement.dataset.desktopCommandFeedback).toBe(
      "Stop generation is unavailable in the WebUI shell.",
    );
    expect((document.nodes["[data-desktop-route-status]"] as FakeStatus).textContent).toBe(
      "Stop generation is unavailable in the WebUI shell.",
    );
  });

  test("routes stop generation only when the WebUI exposes a stop control", () => {
    const document = new FakeWebUiDocument();
    document.nodes["#stop-generation-button"] = new FakeButton();
    const handlers: Array<(id: string) => void> = [];

    installDesktopWebUiCommandBridge({
      targetDocument: document as unknown as Document,
      targetWindow: fakeWindow(),
      listenToMenuCommand: (nextHandler) => {
        handlers.push(nextHandler);
      },
    });

    handlers[0]("stop-generation");

    expect((document.nodes["#stop-generation-button"] as FakeButton).clicks).toBe(1);
    expect(document.documentElement.dataset.desktopCommandFeedback).toBe("Stop generation requested");
  });

  test("opens the desktop command palette and session search inside the WebUI shell", () => {
    const document = new FakeWebUiDocument();
    const paletteQueries: unknown[] = [];
    document.addEventListener("tinybot:open-command-palette", (event) => {
      paletteQueries.push((event as CustomEvent).detail?.query);
    });

    installDesktopWebUiCommandBridge({
      targetDocument: document as unknown as Document,
      targetWindow: fakeWindow(),
      listenToMenuCommand: () => undefined,
    });

    document.dispatchEvent(new CustomEvent("desktop-menu-command", { detail: { id: "open-command-palette" } }));
    document.dispatchEvent(new CustomEvent("desktop-menu-command", { detail: { id: "search-sessions" } }));

    expect(paletteQueries).toEqual(["", "session"]);
    expect(document.documentElement.dataset.desktopCommandFeedback).toBe("Session search opened");
  });

  test("routes desktop workbench links to root WebUI drawers", () => {
    const document = new FakeWebUiDocument();
    const window = fakeWindow();

    installDesktopWebUiCommandBridge({
      targetDocument: document as unknown as Document,
      targetWindow: window,
      listenToMenuCommand: () => undefined,
    });

    window.dispatchEvent(new CustomEvent("tinybot:desktop-route", {
      detail: { kind: "workbench-route", href: "http://localhost:1420/tools" },
    }));
    window.dispatchEvent(new CustomEvent("tinybot:desktop-route", {
      detail: { kind: "workbench-route", href: "http://localhost:1420/cowork" },
    }));

    expect((document.nodes["#tools-toggle"] as FakeButton).clicks).toBe(1);
    expect((document.nodes["#cowork-toggle"] as FakeButton).clicks).toBe(1);
    expect(document.documentElement.dataset.desktopCommandFeedback).toBe("Automations opened");
    expect((document.nodes["[data-desktop-route-status]"] as FakeStatus).textContent).toBe("Automations opened");
  });

  test("records context targets for root WebUI context navigation", () => {
    const document = new FakeWebUiDocument();
    installDesktopWebUiCommandBridge({
      targetDocument: document as unknown as Document,
      targetWindow: fakeWindow(),
      listenToMenuCommand: () => undefined,
    });

    document.dispatchEvent({
      type: "contextmenu",
      target: {
        closest: () => ({
          dataset: { sessionKey: "WebSocket:chat-1" },
          classList: { contains: () => false },
        }),
      },
    } as unknown as Event);

    expect(document.documentElement.dataset.desktopContextMenuTarget).toBe("session:WebSocket:chat-1");
  });
});

function fakeWindow(assigned: string[] = []): Window {
  const listeners = new Map<string, Array<(event: Event) => void>>();
  return {
    addEventListener: (type: string, listener: (event: Event) => void) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    dispatchEvent: (event: Event) => {
      for (const listener of listeners.get(event.type) ?? []) {
        listener(event);
      }
      return true;
    },
    location: {
      origin: "http://localhost:1420",
      assign: (href: string) => {
        assigned.push(href);
      },
    },
  } as unknown as Window;
}
