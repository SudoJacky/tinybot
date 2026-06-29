// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import type { DesktopSettingsPaneModel } from "../../settings/desktopSettingsProviders";
import { mountSettingsStatusIsland } from "./settingsStatusIsland";

const pane: DesktopSettingsPaneModel = {
  dirty: false,
  validationErrors: [{ field: "model", errorKey: "modelEmpty" }],
  save: {
    status: "saved",
    message: "Settings saved",
    canSave: false,
  },
  groups: [],
  providerCatalog: [
    { id: "openai", label: "OpenAI", status: "ready" },
    { id: "local", label: "Local", status: "offline" },
  ],
  providerEditor: {
    selectedProvider: "openai",
    profileId: "work",
    apiKey: {
      value: "",
      displayValue: "sk-...123",
      masked: true,
      empty: false,
    },
    apiBase: "https://api.openai.com/v1",
    models: ["gpt-4.1", "gpt-4.1-mini"],
    canDiscoverModels: true,
  },
};

describe("settings status Vue island", () => {
  test("renders settings status rows with existing desktop copy", () => {
    const host = document.createElement("section");

    const mounted = mountSettingsStatusIsland(host, { pane });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("settings-status");
    expect(host.className).toContain("desktop-settings-status-card");
    expect(host.getAttribute("aria-label")).toBe("Settings status");
    expect(host.textContent).toContain("Save: Settings saved");
    expect(host.textContent).toContain("Validation: model");
    expect(host.textContent).toContain("Provider profile: work");
    expect(host.textContent).toContain("API key: sk-...123");
    expect(host.textContent).toContain("Catalog: OpenAI (ready), Local (offline)");
    expect(host.textContent).toContain("Models: gpt-4.1, gpt-4.1-mini");

    mounted.unmount();
    expect(host.textContent).toBe("");
  });

  test("renders empty fallback copy", () => {
    const host = document.createElement("section");

    const mounted = mountSettingsStatusIsland(host, {
      pane: {
        ...pane,
        validationErrors: [],
        providerCatalog: [],
        providerEditor: {
          ...pane.providerEditor,
          profileId: "",
          apiKey: {
            value: "",
            displayValue: "",
            masked: false,
            empty: true,
          },
          models: [],
        },
      },
    });

    expect(host.textContent).toContain("Validation: ready");
    expect(host.textContent).toContain("Provider profile: default");
    expect(host.textContent).toContain("API key: Not configured");
    expect(host.textContent).toContain("Catalog: No providers loaded");
    expect(host.textContent).toContain("Models: No models loaded");

    mounted.unmount();
  });
});
