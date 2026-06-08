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
  private listeners = new Map<string, Array<(event: Event) => void>>();

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName);
  }

  getElementById(id: string): FakeElement | null {
    return this.body.querySelector(`#${id}`) ?? this.head.querySelector(`#${id}`);
  }

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
  const attribute = selector.match(/^\[([^=\]]+)="([^"]*)"\]$/);
  if (attribute) {
    return element.getAttribute(attribute[1]) === attribute[2];
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
    expect(targetDocument.body.querySelector('[data-desktop-runtime-command="refresh-gateway-status"]')).toBeNull();
    expect(targetDocument.body.querySelector('[data-window-action="minimize"]')?.textContent).toBe("");
    expect(targetDocument.body.querySelector('[data-window-action="maximize"]')?.textContent).toBe("");
    expect(targetDocument.body.querySelector('[data-window-action="close"]')?.textContent).toBe("");
    expect(targetDocument.body.querySelector('[data-window-action="minimize"]')?.className).toContain("desktop-window-traffic-light");
    expect(targetDocument.body.querySelector('[data-window-action="maximize"]')?.className).toContain("desktop-window-traffic-light");
    expect(targetDocument.body.querySelector('[data-window-action="close"]')?.className).toContain("desktop-window-traffic-light");

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

  test("ignores runtime status updates after removing the gateway badge", () => {
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

    expect(targetDocument.getElementById("desktop-runtime-status")).toBeNull();
    expect(targetDocument.body.querySelector('[data-desktop-runtime-command="refresh-gateway-status"]')).toBeNull();
    expect(targetDocument.body.querySelector('[data-window-action="close"]')).toBeTruthy();
  });

  test("renders reorganized desktop commands inside the compact app chrome", () => {
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

    const appContainer = targetDocument.body.querySelector('[data-desktop-menu-label="App"]');
    const appTrigger = appContainer?.querySelector(".desktop-help-menu-trigger");
    const appMenu = appContainer?.querySelector(".desktop-help-menu-popover");
    expect(appTrigger?.textContent).toBe("App");
    expect(appTrigger?.getAttribute("aria-expanded")).toBe("false");
    expect(appMenu?.hidden).toBe(true);
    appTrigger?.click();
    expect(appTrigger?.getAttribute("aria-expanded")).toBe("true");
    expect(appMenu?.querySelector('[data-desktop-menu-command="new-chat"]')?.querySelector(".desktop-help-menu-label")?.textContent).toBe("New Chat");
    expect(appMenu?.querySelector('[data-desktop-menu-command="search-sessions"]')?.querySelector(".desktop-help-menu-label")?.textContent).toBe("Search Sessions");
    expect(appMenu?.querySelector('[data-desktop-menu-command="open-command-palette"]')?.querySelector(".desktop-help-menu-label")?.textContent).toBe("Command Palette");
    expect(appMenu?.querySelector('[data-desktop-menu-command="stop-generation"]')?.querySelector(".desktop-help-menu-label")?.textContent).toBe("Stop Generation");
    expect(appMenu?.querySelector('[data-desktop-menu-command="toggle-theme"]')?.querySelector(".desktop-help-menu-label")?.textContent).toBe("Toggle Theme");
    expect(appMenu?.querySelector('[data-desktop-menu-command="toggle-sidebar"]')?.querySelector(".desktop-help-menu-label")?.textContent).toBe("Toggle Sidebar");
    expect(appMenu?.querySelector('[data-desktop-menu-command="open-settings"]')).toBeNull();

    const resourcesContainer = targetDocument.body.querySelector('[data-desktop-menu-label="Resources"]');
    const resourcesTrigger = resourcesContainer?.querySelector(".desktop-help-menu-trigger");
    const resourcesMenu = resourcesContainer?.querySelector(".desktop-help-menu-popover");
    expect(resourcesTrigger?.textContent).toBe("Resources");
    resourcesTrigger?.click();
    expect(appTrigger?.getAttribute("aria-expanded")).toBe("false");
    expect(resourcesTrigger?.getAttribute("aria-expanded")).toBe("true");
    expect(resourcesMenu?.querySelector('[data-desktop-menu-command="open-chat"]')?.querySelector(".desktop-help-menu-label")?.textContent).toBe("Chat");
    expect(resourcesMenu?.querySelector('[data-desktop-menu-command="open-workspace"]')).toBeNull();
    expect(resourcesMenu?.querySelector('[data-desktop-menu-command="open-files"]')?.querySelector(".desktop-help-menu-label")?.textContent).toBe("Files");
    expect(resourcesMenu?.querySelector('[data-desktop-menu-command="open-knowledge"]')?.querySelector(".desktop-help-menu-label")?.textContent).toBe("Knowledge");
    expect(resourcesMenu?.querySelector('[data-desktop-menu-command="open-cowork"]')?.querySelector(".desktop-help-menu-label")?.textContent).toBe("Cowork");
    expect(resourcesMenu?.querySelector('[data-desktop-menu-command="open-settings"]')).toBeNull();
    expect(resourcesMenu?.querySelector('[data-desktop-menu-command="open-docs"]')).toBeNull();
    expect(resourcesMenu?.querySelector('[data-desktop-menu-command="open-tinybot-repo"]')).toBeNull();

    targetDocument.dispatchEvent(new Event("click"));
    expect(resourcesTrigger?.getAttribute("aria-expanded")).toBe("false");
    expect(resourcesMenu?.hidden).toBe(true);

    const systemContainer = targetDocument.body.querySelector('[data-desktop-menu-label="System"]');
    const systemMenu = systemContainer?.querySelector(".desktop-help-menu-popover");
    expect(systemContainer?.querySelector(".desktop-help-menu-trigger")?.textContent).toBe("System");
    expect(systemMenu?.querySelector('[data-desktop-menu-command="open-settings"]')?.querySelector(".desktop-help-menu-label")?.textContent).toBe("Settings");
    expect(systemMenu?.querySelector('[data-desktop-menu-command="refresh-gateway-status"]')?.querySelector(".desktop-help-menu-label")?.textContent).toBe("Gateway Status");
    expect(systemMenu?.querySelector('[data-desktop-menu-command="open-docs"]')).toBeNull();

    const helpContainer = targetDocument.body.querySelector('[data-desktop-menu-label="Help"]');
    const helpTrigger = helpContainer?.querySelector(".desktop-help-menu-trigger");
    const helpMenu = helpContainer?.querySelector(".desktop-help-menu-popover");
    expect(helpTrigger?.textContent).toBe("Help");
    expect(helpTrigger?.getAttribute("aria-haspopup")).toBe("menu");
    expect(helpTrigger?.getAttribute("aria-expanded")).toBe("false");
    expect(helpMenu?.getAttribute("role")).toBe("menu");
    expect(helpMenu?.hidden).toBe(true);

    helpTrigger?.click();
    expect(helpTrigger?.getAttribute("aria-expanded")).toBe("true");
    expect(helpMenu?.hidden).toBe(false);
    const docs = helpMenu?.querySelector('[data-desktop-menu-command="open-docs"]');
    const shortcutHelp = helpMenu?.querySelector('[data-desktop-menu-command="open-shortcut-help"]');
    const pageHelp = helpMenu?.querySelector('[data-desktop-menu-command="open-page-help"]');
    const repo = helpMenu?.querySelector('[data-desktop-menu-command="open-tinybot-repo"]');
    expect(docs?.querySelector(".desktop-help-menu-label")?.textContent).toBe("Documentation");
    expect(shortcutHelp?.querySelector(".desktop-help-menu-label")?.textContent).toBe("Shortcut Help");
    expect(shortcutHelp?.querySelector(".desktop-help-menu-shortcut")?.textContent).toBe("Ctrl+/");
    expect(pageHelp?.querySelector(".desktop-help-menu-label")?.textContent).toBe("Page Help");
    expect(pageHelp?.querySelector(".desktop-help-menu-shortcut")?.textContent).toBe("Ctrl+Shift+/");
    expect(repo?.querySelector(".desktop-help-menu-label")?.textContent).toBe("Tinybot repo");
  });

  test("does not render the gateway status command in the compact app chrome", () => {
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

    expect(targetDocument.body.querySelector('[data-desktop-runtime-command="refresh-gateway-status"]')).toBeNull();
    expect(targetDocument.getElementById("desktop-runtime-status")).toBeNull();
    expect(targetDocument.dispatched).not.toContain("desktop-menu-command");
    expect(currentWindow.startDragging).not.toHaveBeenCalled();
  });

  test("does not mount a real Vue runtime status badge", () => {
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

    expect(document.getElementById("desktop-runtime-status")).toBeNull();
    expect(document.body.querySelector('[data-desktop-runtime-command="refresh-gateway-status"]')).toBeNull();
    expect(dispatched).toEqual([]);
  });

  test("uses native titlebar buttons for real window controls", () => {
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
    expect(controls?.getAttribute("data-desktop-vue-island")).toBeNull();
    expect(controls?.querySelector('[data-window-action="minimize"]')?.getAttribute("aria-label")).toBe("Minimize");
    expect(controls?.querySelector('[data-window-action="maximize"]')?.getAttribute("aria-label")).toBe("Maximize");
    expect(controls?.querySelector('[data-window-action="close"]')?.getAttribute("aria-label")).toBe("Close");
    expect(controls?.querySelector('[data-window-action="minimize"]')?.textContent).toBe("");
    expect(controls?.querySelector('[data-window-action="maximize"]')?.textContent).toBe("");
    expect(controls?.querySelector('[data-window-action="close"]')?.textContent).toBe("");

    controls?.querySelector<HTMLButtonElement>('[data-window-action="minimize"]')?.click();

    expect(currentWindow.minimize).toHaveBeenCalledTimes(1);
    expect(currentWindow.startDragging).not.toHaveBeenCalled();
  });

  test("uses a Vue island host for the real help menu", async () => {
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

    const helpMenu = document.body.querySelector<HTMLElement>('[data-desktop-menu-label="Help"]');
    const helpTrigger = helpMenu?.querySelector<HTMLButtonElement>(".desktop-help-menu-trigger");
    const shortcutHelp = helpMenu?.querySelector<HTMLButtonElement>('[data-desktop-menu-command="open-shortcut-help"]');
    expect(helpMenu?.getAttribute("data-desktop-vue-island")).toBe("desktop-help-menu");
    expect(helpTrigger?.getAttribute("aria-expanded")).toBe("false");

    helpTrigger?.click();
    await Promise.resolve();
    expect(helpTrigger?.getAttribute("aria-expanded")).toBe("true");

    shortcutHelp?.click();
    await Promise.resolve();
    expect(dispatched).toEqual(["open-shortcut-help"]);
    expect(helpTrigger?.getAttribute("aria-expanded")).toBe("false");
  });

  test("routes real app menu commands through the compact app menu", () => {
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

    const appMenu = document.body.querySelector<HTMLElement>('[data-desktop-menu-label="App"]');
    const resourcesMenu = document.body.querySelector<HTMLElement>('[data-desktop-menu-label="Resources"]');
    const systemMenu = document.body.querySelector<HTMLElement>('[data-desktop-menu-label="System"]');
    const theme = appMenu?.querySelector<HTMLElement>('[data-desktop-menu-command="toggle-theme"]');
    const cowork = resourcesMenu?.querySelector<HTMLElement>('[data-desktop-menu-command="open-cowork"]');
    const docs = document.body.querySelector<HTMLElement>('[data-desktop-menu-label="Help"]')?.querySelector<HTMLElement>('[data-desktop-menu-command="open-docs"]');
    const settings = systemMenu?.querySelector<HTMLElement>('[data-desktop-menu-command="open-settings"]');
    expect(document.body.querySelector(".desktop-app-menu .desktop-help-menu-trigger")?.textContent).toBe("App");
    expect(document.body.querySelector(".desktop-resources-menu .desktop-help-menu-trigger")?.textContent).toBe("Resources");
    expect(document.body.querySelector(".desktop-system-menu .desktop-help-menu-trigger")?.textContent).toBe("System");
    expect(theme?.closest(".desktop-app-menu")).not.toBeNull();
    expect(cowork?.closest(".desktop-resources-menu")).not.toBeNull();
    expect(docs?.closest(".desktop-help-menu")).not.toBeNull();
    expect(settings?.closest(".desktop-system-menu")).not.toBeNull();
    expect(settings?.textContent).toContain("Settings");

    settings?.click();

    expect(dispatched).toEqual(["open-settings"]);
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
    expect(styleText).toContain("width: 12px !important;");
    expect(styleText).toContain("height: 12px !important;");
    expect(styleText).toContain("border-radius: 999px;");
    expect(styleText).toContain("right: 18px;");
    expect(styleText).toContain("grid-template-columns: repeat(3, 12px);");
    expect(styleText).toContain("radial-gradient(circle at 6px 6px, #ff5f57 0 5px, transparent 6px)");
    expect(styleText).toContain(".desktop-window-button-close");
    expect(styleText).toContain("background: #ff5f57;");
    expect(styleText).toContain(".desktop-window-button-minimize");
    expect(styleText).toContain("background: #ffbd2e;");
    expect(styleText).toContain(".desktop-window-button-maximize");
    expect(styleText).toContain("background: #28c840;");
    expect(styleText).not.toContain(".desktop-runtime-status");
    expect(styleText).toContain("--bg: #faf9f5;");
    expect(styleText).toContain("--panel-strong: #efe9de;");
    expect(styleText).toContain("--primary: #cc785c;");
    expect(styleText).toContain("--success: #5db872;");
    expect(styleText).toContain("--border: #e6dfd8;");
    expect(styleText).toContain("min-height: 36px;");
    expect(styleText).toContain("padding: 5px 16px;");
    expect(styleText).toContain("font: 500 13px/20px var(--font-sans, system-ui, sans-serif);");
    expect(styleText).toContain("body.desktop-custom-frame .desktop-help-menu-item .n-button__content");
    expect(styleText).toContain("overflow: visible;");
    expect(styleText).toContain("line-height: 20px;");
    expect(styleText).toContain("justify-self: end;");
    const menuInteractionRule = styleText?.match(
      /body\.desktop-custom-frame \.desktop-application-menu-item:hover,[\s\S]*?body\.desktop-custom-frame \.desktop-application-menu-item:focus-visible \{[\s\S]*?\}/,
    )?.[0];
    expect(menuInteractionRule).toContain("background: #f2ede7;");
    expect(menuInteractionRule).toContain("outline: 0;");
    expect(menuInteractionRule).not.toContain("outline: 2px solid var(--primary, #cc785c);");
  });

  test("declares dark theme overrides for the custom frame", () => {
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
    expect(styleText).toContain('html[data-theme="dark"] body.desktop-custom-frame .desktop-window-frame');
    expect(styleText).toContain('html[data-theme="dark"] body.desktop-custom-frame .desktop-application-menu-item');
    expect(styleText).toContain('html[data-theme="dark"] body.desktop-custom-frame .desktop-help-menu-popover');
    expect(styleText).not.toContain('html[data-theme="dark"] body.desktop-custom-frame .desktop-window-button');
  });
});
