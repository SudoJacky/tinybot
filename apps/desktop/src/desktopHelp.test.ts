import { describe, expect, test } from "vitest";
import {
  buildDesktopPageHelpText,
  buildDesktopShortcutHelpText,
  DESKTOP_HELP_TOUR_TARGETS,
  DESKTOP_SHORTCUT_HELP_ITEMS,
  resolveDesktopVisibleHelpTargets,
} from "./desktopHelp";

class FakeHelpElement {
  constructor(private readonly visible: boolean) {}

  getBoundingClientRect(): DOMRect {
    return {
      width: this.visible ? 120 : 0,
      height: this.visible ? 40 : 0,
      left: 0,
      top: 0,
      right: this.visible ? 120 : 0,
      bottom: this.visible ? 40 : 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    };
  }
}

class FakeHelpDocument {
  constructor(private readonly visibleSelectors: Set<string>) {}

  querySelector(selector: string): Element | null {
    if (!DESKTOP_HELP_TOUR_TARGETS.some((target) => target.selector === selector)) {
      return null;
    }
    return new FakeHelpElement(this.visibleSelectors.has(selector)) as unknown as Element;
  }
}

describe("desktop help", () => {
  test("describes current desktop shortcuts and their availability", () => {
    expect(DESKTOP_SHORTCUT_HELP_ITEMS.map((item) => item.key)).toEqual([
      "Ctrl+N",
      "Ctrl+.",
      "Ctrl+F",
      "Ctrl+,",
      "F1",
      "Ctrl+Shift+P",
      "Ctrl+B",
      "Ctrl+Shift+G",
      "Ctrl+/",
      "Ctrl+Shift+/",
    ]);
    expect(buildDesktopShortcutHelpText()).toContain(
      "Ctrl+Shift+P: Command palette - Search commands, sessions, files, knowledge, tools, skills, and Cowork sessions. (Always available)",
    );
    expect(buildDesktopShortcutHelpText()).toContain(
      "Ctrl+/: Shortcut help - Show current desktop shortcuts in the inspector pane. (Desktop workbench mode)",
    );
  });

  test("resolves visible workbench help-tour targets without forcing page scroll", () => {
    const visibleTargets = resolveDesktopVisibleHelpTargets(new FakeHelpDocument(new Set([
      "[data-workbench-region=\"activity\"]",
      "[data-workbench-region=\"main\"]",
      ".desktop-help-pane",
    ])) as unknown as Document);

    expect(visibleTargets.filter((target) => target.visible).map((target) => target.id)).toEqual([
      "activity",
      "main",
      "help",
    ]);
    expect(buildDesktopPageHelpText(visibleTargets)).toEqual([
      "Step 1: Activity rail - Switch between Chat, Files, Knowledge, and Cowork without opening browser-style pages.",
      "Step 2: Primary work area - Use the central pane for active chat, files, settings, tools, knowledge, or Cowork workflows.",
      "Step 3: Help - Open bundled docs, shortcut help, page help, or this desktop tour.",
    ]);
  });
});
