import { describe, expect, test, vi } from "vitest";
import {
  installDesktopWindowFrame,
  resolveDesktopRuntimeStatusView,
  setDesktopWindowRuntimeStatus,
} from "./desktopWindowFrame";

class FakeElement {
  public className = "";
  public textContent = "";
  public children: FakeElement[] = [];
  public attributes = new Map<string, string>();
  private listeners = new Map<string, Array<(event: { stopPropagation(): void }) => void>>();

  constructor(public readonly tagName: string) {}

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  append(...children: FakeElement[]): void {
    this.children.push(...children);
  }

  addEventListener(event: string, listener: (event: { stopPropagation(): void }) => void): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
  }

  click(): void {
    this.dispatch("click");
  }

  dispatch(event: string): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener({ stopPropagation: vi.fn() });
    }
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
}

class FakeClassList {
  public values = new Set<string>();

  add(value: string): void {
    this.values.add(value);
  }
}

class FakeBody extends FakeElement {
  public classList = new FakeClassList();
  public prepended: FakeElement[] = [];

  constructor() {
    super("body");
  }

  prepend(element: FakeElement): void {
    this.prepended.unshift(element);
    this.children.unshift(element);
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
}

function matchesSelector(element: FakeElement, selector: string): boolean {
  if (selector.startsWith("#")) {
    return element.getAttribute("id") === selector.slice(1);
  }
  const action = selector.match(/^\[data-window-action="(.+)"\]$/);
  if (action) {
    return element.getAttribute("data-window-action") === action[1];
  }
  const menuCommand = selector.match(/^\[data-desktop-menu-command="(.+)"\]$/);
  if (menuCommand) {
    return element.getAttribute("data-desktop-menu-command") === menuCommand[1];
  }
  return false;
}

describe("desktop window frame", () => {
  test("installs a custom draggable frame with working window controls", () => {
    const targetDocument = new FakeDocument();
    const currentWindow = {
      minimize: vi.fn(async () => {}),
      toggleMaximize: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      startDragging: vi.fn(async () => {}),
    };

    installDesktopWindowFrame({
      targetDocument: targetDocument as unknown as Document,
      currentWindow,
    });

    const frame = targetDocument.getElementById("desktop-window-frame");
    expect(frame?.getAttribute("data-tauri-drag-region")).toBe("");
    expect(targetDocument.body.classList.values.has("desktop-custom-frame")).toBe(true);
    expect(targetDocument.head.querySelector("#desktop-window-frame-style")).toBeTruthy();
    expect(targetDocument.body.querySelector('[data-window-action="minimize"]')?.textContent).toBe("−");
    expect(targetDocument.body.querySelector('[data-window-action="maximize"]')?.textContent).toBe("□");
    expect(targetDocument.body.querySelector('[data-window-action="close"]')?.textContent).toBe("×");

    targetDocument.body.querySelector('[data-window-action="minimize"]')?.click();
    targetDocument.body.querySelector('[data-window-action="maximize"]')?.click();
    targetDocument.body.querySelector('[data-window-action="close"]')?.click();
    frame?.dispatch("pointerdown");

    expect(currentWindow.minimize).toHaveBeenCalledTimes(1);
    expect(currentWindow.toggleMaximize).toHaveBeenCalledTimes(1);
    expect(currentWindow.close).toHaveBeenCalledTimes(1);
    expect(currentWindow.startDragging).toHaveBeenCalledTimes(1);
  });

  test("maps runtime ownership to a compact desktop status view", () => {
    expect(
      resolveDesktopRuntimeStatusView({
        state: "running",
        owner: "shell",
        http_ok: true,
        gateway_http: "http://127.0.0.1:18790",
        gateway_ws: "ws://127.0.0.1:18790/ws",
        command: "uv run tinybot gateway",
        repo_root: "D:/Code/py/tinybot",
        logs: [],
        last_error: null,
      }),
    ).toEqual({
      tone: "ok",
      label: "Gateway: Shell",
      detail: "Running on http://127.0.0.1:18790",
    });

    expect(resolveDesktopRuntimeStatusView(null)).toEqual({
      tone: "ok",
      label: "Gateway: External",
      detail: "Connected to an existing Tinybot gateway",
    });
  });

  test("updates the installed frame runtime status without replacing window controls", () => {
    const targetDocument = new FakeDocument();
    const currentWindow = {
      minimize: vi.fn(async () => {}),
      toggleMaximize: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      startDragging: vi.fn(async () => {}),
    };

    installDesktopWindowFrame({
      targetDocument: targetDocument as unknown as Document,
      currentWindow,
    });

    setDesktopWindowRuntimeStatus(
      {
        state: "starting",
        owner: "shell",
        http_ok: false,
        gateway_http: "http://127.0.0.1:18790",
        gateway_ws: "ws://127.0.0.1:18790/ws",
        command: "uv run tinybot gateway",
        repo_root: "D:/Code/py/tinybot",
        logs: [],
        last_error: null,
      },
      targetDocument as unknown as Document,
    );

    const status = targetDocument.getElementById("desktop-runtime-status");
    expect(status?.textContent).toBe("Gateway: Starting");
    expect(status?.getAttribute("title")).toBe("Starting shell gateway at http://127.0.0.1:18790");
    expect(status?.getAttribute("data-runtime-tone")).toBe("pending");
    expect(targetDocument.body.querySelector('[data-window-action="close"]')).toBeTruthy();
  });

  test("renders desktop application menu entries inside the custom app chrome", () => {
    const targetDocument = new FakeDocument();
    const currentWindow = {
      minimize: vi.fn(async () => {}),
      toggleMaximize: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      startDragging: vi.fn(async () => {}),
    };

    installDesktopWindowFrame({
      targetDocument: targetDocument as unknown as Document,
      currentWindow,
    });

    expect(targetDocument.body.querySelector('[data-desktop-menu-command="new-chat"]')?.textContent).toBe("New Chat");
    expect(targetDocument.body.querySelector('[data-desktop-menu-command="open-command-palette"]')?.textContent).toBe("Command Palette");
    expect(targetDocument.body.querySelector('[data-desktop-menu-command="refresh-gateway-status"]')?.textContent).toBe("Gateway Status");
  });
});
