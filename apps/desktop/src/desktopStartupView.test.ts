import { describe, expect, test, vi } from "vitest";
import { bindStartupRetry, setStartupState } from "./desktopStartupView";

class FakeElement {
  public textContent = "";
  public hidden = false;
  private listeners = new Map<string, () => void>();

  addEventListener(event: string, listener: () => void): void {
    this.listeners.set(event, listener);
  }

  click(): void {
    this.listeners.get("click")?.();
  }
}

class FakeDocument {
  private readonly elements = new Map<string, FakeElement>();

  constructor(ids: string[]) {
    for (const id of ids) {
      this.elements.set(`#${id}`, new FakeElement());
    }
  }

  querySelector(selector: string): FakeElement | null {
    return this.elements.get(selector) ?? null;
  }

  get(selector: string): FakeElement {
    const element = this.querySelector(selector);
    if (!element) {
      throw new Error(`Missing test element ${selector}`);
    }
    return element;
  }
}

describe("desktop startup view", () => {
  test("renders recoverable diagnostics and retry visibility", () => {
    const document = new FakeDocument([
      "desktop-startup-status",
      "desktop-startup-diagnostics",
      "desktop-startup-retry",
    ]);

    setStartupState(document as unknown as Document, "Tinybot gateway is not ready.", "Gateway offline", true);

    expect(document.get("#desktop-startup-status").textContent).toBe("Tinybot gateway is not ready.");
    expect(document.get("#desktop-startup-diagnostics").textContent).toBe("Gateway offline");
    expect(document.get("#desktop-startup-diagnostics").hidden).toBe(false);
    expect(document.get("#desktop-startup-retry").hidden).toBe(false);
  });

  test("hides diagnostics and retry for non-recoverable startup states", () => {
    const document = new FakeDocument([
      "desktop-startup-status",
      "desktop-startup-diagnostics",
      "desktop-startup-retry",
    ]);

    setStartupState(document as unknown as Document, "Starting local gateway...", null, false);

    expect(document.get("#desktop-startup-status").textContent).toBe("Starting local gateway...");
    expect(document.get("#desktop-startup-diagnostics").hidden).toBe(true);
    expect(document.get("#desktop-startup-retry").hidden).toBe(true);
  });

  test("binds retry button to the supplied boot callback", () => {
    const document = new FakeDocument(["desktop-startup-retry"]);
    const retry = vi.fn();

    bindStartupRetry(document as unknown as Document, retry);
    document.get("#desktop-startup-retry").click();

    expect(retry).toHaveBeenCalledTimes(1);
  });
});
