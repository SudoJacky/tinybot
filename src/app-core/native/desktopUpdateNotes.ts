import type { DesktopUpdateSnapshot } from "./desktopNativeUpdate";

export const DESKTOP_UPDATE_NOTES_STORAGE_KEY = "tinybot.desktop.latestUpdateNotes";

export type DesktopUpdateNotes = {
  version: string;
  releaseNotes: string | null;
  displayNotes: string | null;
  publishedAt: string | null;
};

type DesktopUpdateNotesStorage = Pick<Storage, "getItem" | "setItem">;

type PersistedDesktopUpdateNotes = DesktopUpdateNotes & {
  schemaVersion: 1;
};

export function rememberLatestDesktopUpdateNotes(
  snapshot: DesktopUpdateSnapshot,
  storage: DesktopUpdateNotesStorage = window.localStorage,
): DesktopUpdateNotes | null {
  const notes = notesFromSnapshot(snapshot);
  if (!notes) {
    return null;
  }
  const persisted: PersistedDesktopUpdateNotes = { schemaVersion: 1, ...notes };
  storage.setItem(DESKTOP_UPDATE_NOTES_STORAGE_KEY, JSON.stringify(persisted));
  return notes;
}

export function loadLatestDesktopUpdateNotes(
  storage: DesktopUpdateNotesStorage = window.localStorage,
): DesktopUpdateNotes | null {
  const serialized = storage.getItem(DESKTOP_UPDATE_NOTES_STORAGE_KEY);
  if (!serialized) {
    return null;
  }

  const parsed: unknown = JSON.parse(serialized);
  if (!isRecord(parsed) || parsed.schemaVersion !== 1) {
    throw new Error("stored update notes use an unsupported schema");
  }

  const version = requiredText(parsed.version, "version");
  return {
    version,
    releaseNotes: optionalText(parsed.releaseNotes, "releaseNotes"),
    displayNotes: optionalText(parsed.displayNotes, "displayNotes"),
    publishedAt: optionalText(parsed.publishedAt, "publishedAt"),
  };
}

function notesFromSnapshot(snapshot: DesktopUpdateSnapshot): DesktopUpdateNotes | null {
  const version = snapshot.availableVersion?.trim();
  if (!version) {
    return null;
  }
  return {
    version,
    releaseNotes: normalizedText(snapshot.releaseNotes),
    displayNotes: normalizedText(snapshot.displayNotes),
    publishedAt: normalizedText(snapshot.publishedAt),
  };
}

function requiredText(value: unknown, field: string): string {
  const normalized = normalizedText(value);
  if (!normalized) {
    throw new Error(`stored update notes field ${field} must be a non-empty string`);
  }
  return normalized;
}

function optionalText(value: unknown, field: string): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`stored update notes field ${field} must be a string or null`);
  }
  return normalizedText(value);
}

function normalizedText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed || null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
