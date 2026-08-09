import { describe, expect, test } from "vitest";
import {
  APP_LANGUAGE_STORAGE_KEY,
  appLanguageTag,
  loadAppLanguage,
  saveAppLanguage,
} from "./appLanguage";

describe("app language preference", () => {
  test("uses the existing Tinybot language key and normalizes legacy locale values", () => {
    const storage = createStorage({ [APP_LANGUAGE_STORAGE_KEY]: "zh-CN" });

    expect(loadAppLanguage(storage, "en-US")).toBe("zh");
  });

  test("detects Chinese from the system language when no preference exists", () => {
    expect(loadAppLanguage(createStorage(), "zh-SG")).toBe("zh");
    expect(loadAppLanguage(createStorage(), "en-GB")).toBe("en");
  });

  test("ignores an invalid stored value instead of exposing an unsupported locale", () => {
    const storage = createStorage({ [APP_LANGUAGE_STORAGE_KEY]: "fr" });

    expect(loadAppLanguage(storage, "en-US")).toBe("en");
  });

  test("persists a supported language and returns its document language tag", () => {
    const storage = createStorage();

    saveAppLanguage("zh", storage);

    expect(storage.getItem(APP_LANGUAGE_STORAGE_KEY)).toBe("zh");
    expect(appLanguageTag("zh")).toBe("zh-CN");
    expect(appLanguageTag("en")).toBe("en-US");
  });
});

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
