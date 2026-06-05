// @vitest-environment happy-dom

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
  public hidden = false;
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
  public documentElement = { dataset: {} as Record<string, string> };
  public dispatched: string[] = [];

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName);
  }

  getElementById(id: string): FakeElement | null {
    return this.body.querySelector(`#${id}`) ?? this.head.querySelector(`#${id}`);
  }

  dispatchEvent(event: Event): boolean {
    this.dispatched.push(event.type);
    return true;
  }
}

function matchesSelector(element: FakeElement, selector: string): boolean {
  if (selector.startsWith("#")) {
    return element.getAttribute("id") === selector.slice(1);
  }
  if (selector.startsWith(".")) {
    return element.className.split(/\s+/).includes(selector.slice(1));
  }
  const action = selector.match(/^\[data-window-action="(.+)"\]$/);
  if (action) {
    return element.getAttribute("data-window-action") === action[1];
  }
  const menuCommand = selector.match(/^\[data-desktop-menu-command="(.+)"\]$/);
  if (menuCommand) {
    return element.getAttribute("data-desktop-menu-command") === menuCommand[1];
  }
  const runtimeCommand = selector.match(/^\[data-desktop-runtime-command="(.+)"\]$/);
  if (runtimeCommand) {
    return element.getAttribute("data-desktop-runtime-command") === runtimeCommand[1];
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
    expect(targetDocument.body.querySelector(".desktop-window-brand-mark")).toBeNull();
    expect(targetDocument.body.querySelector(".desktop-window-title-group")).toBeNull();
    expect(targetDocument.body.querySelector(".desktop-window-title")).toBeNull();
    expect(targetDocument.body.querySelector(".desktop-window-context")).toBeNull();
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

  test("applies the bundled Tinybot icon to the current native window", async () => {
    const targetDocument = new FakeDocument();
    const currentWindow = {
      minimize: vi.fn(async () => {}),
      toggleMaximize: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      startDragging: vi.fn(async () => {}),
      setIcon: vi.fn(async () => {}),
    };

    installDesktopWindowFrame({
      targetDocument: targetDocument as unknown as Document,
      currentWindow,
      defaultWindowIcon: async () => "tinybot-window-icon",
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(currentWindow.setIcon).toHaveBeenCalledWith("tinybot-window-icon");
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

  test("renders only primary desktop commands inside the compact app chrome", () => {
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

    expect(targetDocument.body.querySelector('[data-desktop-menu-command="new-chat"]')).toBeNull();
    expect(targetDocument.body.querySelector('[data-desktop-menu-command="search-sessions"]')).toBeNull();
    expect(targetDocument.body.querySelector('[data-desktop-menu-command="stop-generation"]')).toBeNull();
    expect(targetDocument.body.querySelector('[data-desktop-menu-command="open-command-palette"]')).toBeNull();
    expect(targetDocument.body.querySelector('[data-desktop-menu-command="open-settings"]')?.textContent).toBe("Settings");
    expect(targetDocument.body.querySelector('[data-desktop-menu-command="open-docs"]')?.textContent).toBe("Documentation");
    expect(targetDocument.body.querySelector('[data-desktop-menu-command="toggle-theme"]')?.textContent).toBe("Toggle Theme");
    expect(targetDocument.body.querySelector('[data-desktop-menu-command="refresh-gateway-status"]')).toBeNull();

    const helpTrigger = targetDocument.body.querySelector(".desktop-help-menu-trigger");
    const helpMenu = targetDocument.body.querySelector(".desktop-help-menu-popover");
    expect(helpTrigger?.textContent).toBe("Help");
    expect(helpTrigger?.getAttribute("aria-haspopup")).toBe("menu");
    expect(helpTrigger?.getAttribute("aria-expanded")).toBe("false");
    expect(helpMenu?.getAttribute("role")).toBe("menu");
    expect(helpMenu?.hidden).toBe(true);

    helpTrigger?.click();
    expect(helpTrigger?.getAttribute("aria-expanded")).toBe("true");
    expect(helpMenu?.hidden).toBe(false);
    const shortcutHelp = helpMenu?.querySelector('[data-desktop-menu-command="open-shortcut-help"]');
    const pageHelp = helpMenu?.querySelector('[data-desktop-menu-command="open-page-help"]');
    expect(shortcutHelp?.querySelector(".desktop-help-menu-label")?.textContent).toBe("Shortcut Help");
    expect(shortcutHelp?.querySelector(".desktop-help-menu-shortcut")?.textContent).toBe("Ctrl+/");
    expect(pageHelp?.querySelector(".desktop-help-menu-label")?.textContent).toBe("Page Help");
    expect(pageHelp?.querySelector(".desktop-help-menu-shortcut")?.textContent).toBe("Ctrl+Shift+/");
  });

  test("routes runtime status clicks through the gateway status command", () => {
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

    const runtimeStatus = targetDocument.body.querySelector('[data-desktop-runtime-command="refresh-gateway-status"]');
    expect(runtimeStatus?.getAttribute("role")).toBe("button");
    expect(runtimeStatus?.getAttribute("tabindex")).toBe("0");

    runtimeStatus?.click();

    expect(targetDocument.dispatched).toContain("desktop-menu-command");
    expect(currentWindow.startDragging).not.toHaveBeenCalled();
  });

  test("uses a Vue island host for the real runtime status command", () => {
    document.body.replaceChildren();
    document.head.replaceChildren();
    const currentWindow = {
      minimize: vi.fn(async () => {}),
      toggleMaximize: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      startDragging: vi.fn(async () => {}),
    };
    const dispatched: string[] = [];
    document.addEventListener("desktop-menu-command", (event) => {
      dispatched.push((event as CustomEvent<{ id: string }>).detail.id);
    });

    installDesktopWindowFrame({
      targetDocument: document,
      currentWindow,
    });

    const runtimeStatus = document.getElementById("desktop-runtime-status");
    expect(runtimeStatus?.getAttribute("data-desktop-vue-island")).toBe("desktop-runtime-status");
    expect(runtimeStatus?.getAttribute("data-desktop-runtime-command")).toBe("refresh-gateway-status");
    expect(runtimeStatus?.getAttribute("data-runtime-tone")).toBe("pending");
    expect(runtimeStatus?.textContent).toContain("Gateway: Starting");

    runtimeStatus?.click();

    expect(dispatched).toEqual(["refresh-gateway-status"]);
  });

  test("uses a Vue island host for real window controls", () => {
    document.body.replaceChildren();
    document.head.replaceChildren();
    const currentWindow = {
      minimize: vi.fn(async () => {}),
      toggleMaximize: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      startDragging: vi.fn(async () => {}),
    };

    installDesktopWindowFrame({
      targetDocument: document,
      currentWindow,
    });

    const controls = document.body.querySelector<HTMLElement>(".desktop-window-controls");
    expect(controls?.getAttribute("data-desktop-vue-island")).toBe("desktop-window-controls");
    expect(controls?.querySelector('[data-window-action="minimize"]')?.getAttribute("aria-label")).toBe("Minimize");
    expect(controls?.querySelector('[data-window-action="maximize"]')?.getAttribute("aria-label")).toBe("Maximize");
    expect(controls?.querySelector('[data-window-action="close"]')?.getAttribute("aria-label")).toBe("Close");

    controls?.querySelector<HTMLButtonElement>('[data-window-action="minimize"]')?.click();

    expect(currentWindow.minimize).toHaveBeenCalledTimes(1);
    expect(currentWindow.startDragging).not.toHaveBeenCalled();
  });

  test("keeps app chrome focused on commands without product or surface labels", () => {
    const targetDocument = new FakeDocument();
    targetDocument.documentElement.dataset.desktopWorkbenchMode = "root-webui";
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
    expect(frame?.textContent).not.toContain("Tinybot");
    expect(frame?.textContent).not.toContain("WebUI shell");
    expect(targetDocument.body.querySelector("#desktop-window-context")).toBeNull();

    targetDocument.documentElement.dataset.desktopWorkbenchMode = "native-workbench";
    installDesktopWindowFrame({
      targetDocument: targetDocument as unknown as Document,
      currentWindow,
    });

    expect(frame?.textContent).not.toContain("Native workbench");
    expect(targetDocument.body.querySelector("#desktop-window-context")).toBeNull();
  });

  test("declares DESIGN.md shell chrome tokens for the custom frame", () => {
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

    const styleText = targetDocument.head.querySelector("#desktop-window-frame-style")?.textContent;
    expect(styleText).toContain("--desktop-window-frame-height: 38px;");
    expect(styleText).toContain("height: 28px;");
    expect(styleText).toContain("width: 28px;");
    expect(styleText).toContain("--bg: #faf9f5;");
    expect(styleText).toContain("--panel-strong: #efe9de;");
    expect(styleText).toContain("--primary: #cc785c;");
    expect(styleText).toContain("--success: #5db872;");
    expect(styleText).toContain("--border: #e6dfd8;");
    const menuInteractionRule = styleText?.match(
      /body\.desktop-custom-frame \.desktop-application-menu-item:hover,[\s\S]*?body\.desktop-custom-frame \.desktop-application-menu-item:focus-visible \{[\s\S]*?\}/,
    )?.[0];
    expect(menuInteractionRule).toContain("background: #f2ede7;");
    expect(menuInteractionRule).toContain("outline: 0;");
    expect(menuInteractionRule).not.toContain("outline: 2px solid var(--primary, #cc785c);");
  });
});
