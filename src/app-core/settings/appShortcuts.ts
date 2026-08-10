export const SHORTCUTS_STORAGE_KEY = "tinybot.ui.shortcuts";

export const SHORTCUT_COMMAND_IDS = [
  "new-chat",
  "stop-generation",
  "toggle-theme",
  "toggle-sidebar",
  "open-settings",
  "open-docs",
] as const;

export type ShortcutCommandId = (typeof SHORTCUT_COMMAND_IDS)[number];
export type ShortcutBinding = string | null;
export type ShortcutPreferences = Record<ShortcutCommandId, ShortcutBinding>;

export const DEFAULT_SHORTCUT_PREFERENCES: ShortcutPreferences = {
  "new-chat": "Ctrl+N",
  "stop-generation": "Ctrl+.",
  "toggle-theme": "Ctrl+Shift+T",
  "toggle-sidebar": "Ctrl+B",
  "open-settings": "Ctrl+,",
  "open-docs": "F1",
};

type ShortcutStorage = Pick<Storage, "getItem" | "setItem">;
type ShortcutKeyboardEvent = Pick<
  KeyboardEvent,
  "altKey" | "code" | "ctrlKey" | "key" | "metaKey" | "shiftKey"
>;

export function loadShortcutPreferences(
  storage: ShortcutStorage = window.localStorage,
): ShortcutPreferences {
  const serialized = storage.getItem(SHORTCUTS_STORAGE_KEY);
  if (!serialized) {
    return { ...DEFAULT_SHORTCUT_PREFERENCES };
  }
  try {
    return normalizePreferences(JSON.parse(serialized));
  } catch (error) {
    console.warn("[tinybot-shortcuts] Ignoring an unreadable local shortcut preference.", error);
    return { ...DEFAULT_SHORTCUT_PREFERENCES };
  }
}

export function saveShortcutPreferences(
  preferences: ShortcutPreferences,
  storage: ShortcutStorage = window.localStorage,
): void {
  storage.setItem(SHORTCUTS_STORAGE_KEY, JSON.stringify(normalizePreferences(preferences)));
}

export function shortcutFromKeyboardEvent(event: ShortcutKeyboardEvent): string | null {
  if (isModifierKey(event.key)) {
    return null;
  }
  const key = normalizedEventKey(event);
  if (!key) {
    return null;
  }
  const hasCommandModifier = event.ctrlKey || event.metaKey || event.altKey;
  if (!hasCommandModifier && !/^F(?:[1-9]|1[0-2])$/.test(key)) {
    return null;
  }
  return [
    event.ctrlKey || event.metaKey ? "Ctrl" : null,
    event.altKey ? "Alt" : null,
    event.shiftKey ? "Shift" : null,
    key,
  ].filter(Boolean).join("+");
}

export function shortcutMatchesKeyboardEvent(
  shortcut: ShortcutBinding,
  event: ShortcutKeyboardEvent,
): boolean {
  return shortcut !== null && shortcutFromKeyboardEvent(event) === shortcut;
}

export function findShortcutCommand(
  preferences: ShortcutPreferences,
  event: ShortcutKeyboardEvent,
): ShortcutCommandId | null {
  return SHORTCUT_COMMAND_IDS.find((commandId) => shortcutMatchesKeyboardEvent(preferences[commandId], event)) ?? null;
}

export function findShortcutConflict(
  preferences: ShortcutPreferences,
  commandId: ShortcutCommandId,
  shortcut: string,
): ShortcutCommandId | null {
  return SHORTCUT_COMMAND_IDS.find((candidateId) => (
    candidateId !== commandId && preferences[candidateId] === shortcut
  )) ?? null;
}

export function isShortcutCommandId(value: string): value is ShortcutCommandId {
  return (SHORTCUT_COMMAND_IDS as readonly string[]).includes(value);
}

function normalizePreferences(input: unknown): ShortcutPreferences {
  const source = isRecord(input) ? input : {};
  return Object.fromEntries(SHORTCUT_COMMAND_IDS.map((commandId) => {
    const candidate = source[commandId];
    if (candidate === null) {
      return [commandId, null];
    }
    return [commandId, normalizeShortcut(candidate) ?? DEFAULT_SHORTCUT_PREFERENCES[commandId]];
  })) as ShortcutPreferences;
}

function normalizeShortcut(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const tokens = value.split("+");
  const key = tokens[tokens.length - 1];
  if (!key || !isSupportedKey(key)) {
    return null;
  }
  const modifiers = new Set(tokens.slice(0, -1));
  if ([...modifiers].some((modifier) => !["Ctrl", "Alt", "Shift"].includes(modifier))) {
    return null;
  }
  if (tokens.length - 1 !== modifiers.size) {
    return null;
  }
  if (!modifiers.has("Ctrl") && !modifiers.has("Alt") && !/^F(?:[1-9]|1[0-2])$/.test(key)) {
    return null;
  }
  return [
    modifiers.has("Ctrl") ? "Ctrl" : null,
    modifiers.has("Alt") ? "Alt" : null,
    modifiers.has("Shift") ? "Shift" : null,
    key,
  ].filter(Boolean).join("+");
}

function normalizedEventKey(event: ShortcutKeyboardEvent): string | null {
  const codeKey = keyFromCode(event.code);
  if (codeKey) {
    return codeKey;
  }
  if (event.key === " ") {
    return "Space";
  }
  if (event.key.length === 1) {
    return event.key.toUpperCase();
  }
  const aliases: Record<string, string> = {
    ArrowDown: "ArrowDown",
    ArrowLeft: "ArrowLeft",
    ArrowRight: "ArrowRight",
    ArrowUp: "ArrowUp",
    Backspace: "Backspace",
    Delete: "Delete",
    Enter: "Enter",
    Home: "Home",
    End: "End",
    PageDown: "PageDown",
    PageUp: "PageUp",
    Tab: "Tab",
  };
  return aliases[event.key] ?? (/^F(?:[1-9]|1[0-2])$/.test(event.key) ? event.key : null);
}

function keyFromCode(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F(?:[1-9]|1[0-2])$/.test(code)) return code;
  return {
    Backquote: "`",
    Backslash: "\\",
    BracketLeft: "[",
    BracketRight: "]",
    Comma: ",",
    Equal: "=",
    Minus: "-",
    Period: ".",
    Quote: "'",
    Semicolon: ";",
    Slash: "/",
    Space: "Space",
  }[code] ?? null;
}

function isSupportedKey(key: string): boolean {
  return key.length === 1 || [
    "ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp", "Backspace", "Delete", "End", "Enter",
    "Home", "PageDown", "PageUp", "Space", "Tab",
  ].includes(key) || /^F(?:[1-9]|1[0-2])$/.test(key);
}

function isModifierKey(key: string): boolean {
  return ["Alt", "AltGraph", "Control", "Meta", "Shift"].includes(key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
