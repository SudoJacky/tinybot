// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import {
  DEFAULT_SHORTCUT_PREFERENCES,
  SHORTCUTS_STORAGE_KEY,
  findShortcutCommand,
  findShortcutConflict,
  loadShortcutPreferences,
  saveShortcutPreferences,
  shortcutFromKeyboardEvent,
} from "./appShortcuts";

describe("app shortcut preferences", () => {
  test("loads defaults and persists valid reassigned or cleared bindings", () => {
    const storage = createStorage();
    expect(loadShortcutPreferences(storage)).toEqual(DEFAULT_SHORTCUT_PREFERENCES);

    const preferences = { ...DEFAULT_SHORTCUT_PREFERENCES, "new-chat": "Ctrl+Shift+N", "open-docs": null };
    saveShortcutPreferences(preferences, storage);
    expect(loadShortcutPreferences(storage)).toEqual(preferences);
  });

  test("normalizes malformed stored bindings without losing valid unassigned commands", () => {
    const storage = createStorage({
      [SHORTCUTS_STORAGE_KEY]: JSON.stringify({ "new-chat": "N", "open-docs": null, "toggle-theme": "Ctrl+Ctrl+T" }),
    });
    const preferences = loadShortcutPreferences(storage);

    expect(preferences["new-chat"]).toBe("Ctrl+N");
    expect(preferences["open-docs"]).toBeNull();
    expect(preferences["toggle-theme"]).toBe("Ctrl+Shift+T");
  });

  test("canonicalizes keyboard events and requires a command modifier outside function keys", () => {
    expect(shortcutFromKeyboardEvent(keyEvent({ ctrlKey: true, shiftKey: true, code: "KeyT", key: "T" })))
      .toBe("Ctrl+Shift+T");
    expect(shortcutFromKeyboardEvent(keyEvent({ metaKey: true, code: "Comma", key: "," }))).toBe("Ctrl+,");
    expect(shortcutFromKeyboardEvent(keyEvent({ code: "F1", key: "F1" }))).toBe("F1");
    expect(shortcutFromKeyboardEvent(keyEvent({ code: "KeyN", key: "n" }))).toBeNull();
    expect(shortcutFromKeyboardEvent(keyEvent({ ctrlKey: true, key: "Control" }))).toBeNull();
  });

  test("finds matching commands and rejects conflicts in the global shortcut scope", () => {
    const preferences = { ...DEFAULT_SHORTCUT_PREFERENCES, "new-chat": "Ctrl+Shift+N" };

    expect(findShortcutCommand(preferences, keyEvent({ ctrlKey: true, shiftKey: true, code: "KeyN", key: "N" })))
      .toBe("new-chat");
    expect(findShortcutConflict(preferences, "open-docs", "Ctrl+B")).toBe("toggle-sidebar");
    expect(findShortcutConflict(preferences, "toggle-sidebar", "Ctrl+B")).toBeNull();
  });
});

function keyEvent(overrides: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    altKey: false,
    code: "",
    ctrlKey: false,
    key: "",
    metaKey: false,
    shiftKey: false,
    ...overrides,
  } as KeyboardEvent;
}

function createStorage(initial: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(initial));
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
}
