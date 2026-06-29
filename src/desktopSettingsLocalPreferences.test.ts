import { describe, expect, test } from "vitest";
import { buildDesktopSettingsFormState, createDesktopSettingsPatch } from "./desktopSettingsProviders";
import {
  applyDesktopSettingsLocalPreferences,
  clearDesktopSettingsLocalPreferences,
  loadDesktopSettingsLocalPreferences,
  saveDesktopSettingsLocalPreferences,
} from "./desktopSettingsLocalPreferences";

class MemoryStorage implements Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

describe("desktop settings local preferences", () => {
  test("persists provider editor selection outside the bot config patch", () => {
    const storage = new MemoryStorage();
    const config = {
      agents: { defaults: { provider: "openai", active_profile: "work", model: "gpt-4.1" } },
      providers: {
        profiles: {
          work: { provider: "openai", api_key: "sk-openai", models: ["gpt-4.1"] },
          deepseek: { provider: "deepseek", api_key: "sk-deepseek", models: ["deepseek-chat"] },
        },
      },
    };
    const providerCatalog = [
      { id: "openai", displayName: "OpenAI", status: "ready" },
      { id: "deepseek", displayName: "DeepSeek", status: "ready" },
    ];

    saveDesktopSettingsLocalPreferences({ providerEditorSelectedProvider: "deepseek" }, storage);
    const state = applyDesktopSettingsLocalPreferences(
      buildDesktopSettingsFormState(config, providerCatalog),
      loadDesktopSettingsLocalPreferences(storage),
    );

    expect(state.providerEditor.selectedProvider).toBe("deepseek");
    expect(state.providerEditor.profileId).toBe("deepseek");
    expect(createDesktopSettingsPatch(state, config, providerCatalog)).toEqual({});
  });

  test("ignores stale provider preferences and can clear stored settings UI state", () => {
    const storage = new MemoryStorage();
    saveDesktopSettingsLocalPreferences({ providerEditorSelectedProvider: "missing-provider" }, storage);
    const state = buildDesktopSettingsFormState({
      agents: { defaults: { provider: "openai", active_profile: "work", model: "gpt-4.1" } },
      providers: { profiles: { work: { provider: "openai" } } },
    }, [{ id: "openai", displayName: "OpenAI", status: "ready" }]);

    expect(applyDesktopSettingsLocalPreferences(state, loadDesktopSettingsLocalPreferences(storage)).providerEditor.selectedProvider).toBe("openai");

    clearDesktopSettingsLocalPreferences(storage);
    expect(loadDesktopSettingsLocalPreferences(storage)).toEqual({});
  });
});
