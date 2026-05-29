import { describe, expect, test, vi } from "vitest";
import { installDesktopWindowFrame } from "./desktopWindowFrame";

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

    targetDocument.body.querySelector('[data-window-action="minimize"]')?.click();
    targetDocument.body.querySelector('[data-window-action="maximize"]')?.click();
    targetDocument.body.querySelector('[data-window-action="close"]')?.click();
    frame?.dispatch("pointerdown");

    expect(currentWindow.minimize).toHaveBeenCalledTimes(1);
    expect(currentWindow.toggleMaximize).toHaveBeenCalledTimes(1);
    expect(currentWindow.close).toHaveBeenCalledTimes(1);
    expect(currentWindow.startDragging).toHaveBeenCalledTimes(1);
  });
});
