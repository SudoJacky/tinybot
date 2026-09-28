import { vi } from "vitest";
import { buildDesktopConfigSettingsValues } from "../../app-core/settings/desktopConfigSettings";
import { buildProviderModelsSettings } from "../../app-core/settings/providerModelsSettings";
import type { SettingsStore } from "../services";

/** Supply the required read contract; each test must explicitly arrange writes. */
export function settingsStoreFixture() {
  return {
    loadDesktopConfigSettings: vi.fn(async () => ({ currentConfig: {}, values: buildDesktopConfigSettingsValues({}) })),
    saveDesktopConfigSettings: vi.fn(async () => { throw new Error("Unexpected config save in test"); }),
    loadProviderSettings: vi.fn(async () => buildProviderModelsSettings({})),
    saveProviderSettings: vi.fn(async () => { throw new Error("Unexpected provider save in test"); }),
  } satisfies SettingsStore;
}
