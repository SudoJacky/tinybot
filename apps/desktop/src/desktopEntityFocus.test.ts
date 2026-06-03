import { describe, expect, test } from "vitest";
import {
  applyDesktopWorkbenchRouteState,
  focusDesktopEntity,
  moduleForDesktopWorkbenchPath,
} from "./desktopEntityFocus";

describe("desktop entity focus", () => {
  test("maps workbench routes into visible native modules", () => {
    expect(moduleForDesktopWorkbenchPath("/chat/chat-1")).toBe("chat");
    expect(moduleForDesktopWorkbenchPath("/workspace")).toBe("workspace");
    expect(moduleForDesktopWorkbenchPath("/knowledge/doc-1")).toBe("knowledge");
    expect(moduleForDesktopWorkbenchPath("/tools")).toBe("tools");
    expect(moduleForDesktopWorkbenchPath("/settings")).toBe("settings");
    expect(moduleForDesktopWorkbenchPath("/cowork/cowork-1")).toBe("cowork");
    expect(moduleForDesktopWorkbenchPath("/docs")).toBe("docs");
    expect(moduleForDesktopWorkbenchPath("/api/status")).toBe("gateway");
  });

  test("updates active module state and focuses mounted entity hooks", () => {
    const focused: string[] = [];
    const target = {
      focus: () => focused.push("docs/desktop.md"),
    };
    const targetDocument = {
      documentElement: { dataset: {} as Record<string, string> },
      querySelector: (selector: string) =>
        selector === '[data-desktop-entity-module="workspace"][data-desktop-entity-id="docs/desktop.md"]'
          ? target
          : selector === '[data-desktop-entity-module="approvals"][data-desktop-entity-id="form-1"]'
            ? { focus: () => focused.push("form-1") }
          : null,
    };

    expect(applyDesktopWorkbenchRouteState(targetDocument as unknown as Document, "/workspace")).toBe("workspace");
    expect(focusDesktopEntity(targetDocument as unknown as Document, {
      module: "workspace",
      entityId: "docs/desktop.md",
    })).toBe(true);

    expect(targetDocument.documentElement.dataset.desktopActiveWorkbenchModule).toBe("workspace");
    expect(targetDocument.documentElement.dataset.desktopPaletteFocusModule).toBe("workspace");
    expect(targetDocument.documentElement.dataset.desktopPaletteFocusEntity).toBe("docs/desktop.md");
    expect(targetDocument.documentElement.dataset.desktopPaletteFocused).toBe("true");
    expect(focusDesktopEntity(targetDocument as unknown as Document, {
      module: "approvals",
      entityId: "form-1",
    })).toBe(true);
    expect(focused).toEqual(["docs/desktop.md", "form-1"]);
  });

  test("syncs active route state into mounted workbench navigation controls", () => {
    const activityKnowledge = fakeElement({
      "data-desktop-module-target": "knowledge",
      href: "/knowledge",
    });
    const activityCowork = fakeElement({
      "data-desktop-module-target": "cowork",
      href: "/cowork",
      "data-active": "true",
      "aria-current": "page",
    });
    const sidebarKnowledge = fakeElement({
      "data-sidebar-href": "/knowledge",
    });
    const sidebarSettings = fakeElement({
      "data-sidebar-command": "open-settings",
    });
    const targetDocument = {
      documentElement: { dataset: {} as Record<string, string> },
      querySelectorAll: (selector: string) => {
        if (selector === "[data-desktop-module-target]") {
          return [activityKnowledge, activityCowork];
        }
        if (selector === "[data-sidebar-href], [data-sidebar-command]") {
          return [sidebarKnowledge, sidebarSettings];
        }
        return [];
      },
    };

    expect(applyDesktopWorkbenchRouteState(targetDocument as unknown as Document, "/knowledge")).toBe("knowledge");

    expect(targetDocument.documentElement.dataset.desktopActiveWorkbenchModule).toBe("knowledge");
    expect(activityKnowledge.getAttribute("data-active")).toBe("true");
    expect(activityKnowledge.getAttribute("aria-current")).toBe("page");
    expect(activityCowork.getAttribute("data-active")).toBeNull();
    expect(activityCowork.getAttribute("aria-current")).toBeNull();
    expect(sidebarKnowledge.getAttribute("data-active")).toBe("true");
    expect(sidebarKnowledge.getAttribute("aria-current")).toBe("page");
    expect(sidebarSettings.getAttribute("data-active")).toBeNull();

    expect(applyDesktopWorkbenchRouteState(targetDocument as unknown as Document, "/settings")).toBe("settings");

    expect(sidebarKnowledge.getAttribute("data-active")).toBeNull();
    expect(sidebarSettings.getAttribute("data-active")).toBe("true");
    expect(sidebarSettings.getAttribute("aria-current")).toBe("page");
  });
});

function fakeElement(initialAttributes: Record<string, string>) {
  const attributes = new Map(Object.entries(initialAttributes));
  return {
    setAttribute: (name: string, value: string) => attributes.set(name, value),
    getAttribute: (name: string) => attributes.get(name) ?? null,
    removeAttribute: (name: string) => {
      attributes.delete(name);
    },
  };
}
