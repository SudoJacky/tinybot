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
});
