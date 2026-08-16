// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import type { DesktopUpdateSnapshot } from "./desktopNativeUpdate";
import {
  DESKTOP_UPDATE_NOTES_STORAGE_KEY,
  loadLatestDesktopUpdateNotes,
  rememberLatestDesktopUpdateNotes,
} from "./desktopUpdateNotes";

describe("desktopUpdateNotes", () => {
  it("persists the latest available version and its custom notes", () => {
    const storage = createStorage();
    const remembered = rememberLatestDesktopUpdateNotes(availableSnapshot(), storage);

    expect(remembered).toEqual({
      version: "0.4.0",
      releaseNotes: "## Highlights\n\n- Faster sessions",
      displayNotes: "Save active work before installing.",
      publishedAt: "2026-08-16T12:00:00Z",
    });
    expect(loadLatestDesktopUpdateNotes(storage)).toEqual(remembered);
  });

  it("does not overwrite remembered notes with an up-to-date snapshot", () => {
    const storage = createStorage();
    rememberLatestDesktopUpdateNotes(availableSnapshot(), storage);

    const result = rememberLatestDesktopUpdateNotes({
      ...availableSnapshot(),
      availableVersion: null,
      releaseNotes: null,
      displayNotes: null,
      phase: "up_to_date",
    }, storage);

    expect(result).toBeNull();
    expect(loadLatestDesktopUpdateNotes(storage)?.version).toBe("0.4.0");
  });

  it("reports malformed persisted notes instead of hiding them", () => {
    const storage = createStorage({
      [DESKTOP_UPDATE_NOTES_STORAGE_KEY]: JSON.stringify({ schemaVersion: 1, version: "" }),
    });

    expect(() => loadLatestDesktopUpdateNotes(storage)).toThrow(
      "stored update notes field version must be a non-empty string",
    );
  });
});

function availableSnapshot(): DesktopUpdateSnapshot {
  return {
    currentVersion: "0.3.1",
    availableVersion: "0.4.0",
    releaseNotes: "## Highlights\n\n- Faster sessions",
    displayNotes: "Save active work before installing.",
    publishedAt: "2026-08-16T12:00:00Z",
    phase: "available",
    progressPercent: null,
    error: null,
  };
}

function createStorage(initial: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(initial));
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}
