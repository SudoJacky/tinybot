// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { nextTick } from "vue";
import type { DesktopSettingsPaneModel } from "../desktopSettingsProviders";
import type { DesktopSettingsActionEvent } from "../desktopWorkbenchShell";
import { mountSettingsProviderManagementIsland } from "./settingsProviderManagementIsland";

const pane: DesktopSettingsPaneModel = {
  dirty: false,
  validationErrors: [],
  save: {
    status: "saved",
    message: "Saved",
    canSave: false,
  },
  groups: [],
  providerCatalog: [
    { id: "openai", label: "OpenAI", status: "ready" },
    { id: "deepseek", label: "DeepSeek", status: "ready" },
    { id: "ollama", label: "Ollama", status: "not_configured" },
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

describe("settings provider management Vue island", () => {
  test("renders provider management cards and filters providers", async () => {
    const host = document.createElement("section");

    const mounted = mountSettingsProviderManagementIsland(host, { pane });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("settings-provider-management");
    expect(host.className).toContain("desktop-settings-provider-section");
    expect(host.getAttribute("aria-label")).toBe("Provider management");
    expect(host.textContent).toContain("Providers");
    expect(host.querySelector<HTMLInputElement>(".desktop-settings-provider-search")?.getAttribute("placeholder")).toBe("Search providers...");
    expect(host.querySelector('[data-desktop-settings-action="discoverModels"]')?.textContent).toBe("Refresh models");
    expect(host.querySelector('[data-desktop-settings-action="addProvider"]')?.textContent).toBe("+ Add provider");

    const cards = Array.from(host.querySelectorAll<HTMLElement>(".desktop-settings-provider-card"));
    expect(cards.map((card) => card.getAttribute("data-desktop-settings-provider-card"))).toEqual([
      "openai",
      "deepseek",
      "ollama",
    ]);
    expect(cards[0]?.textContent).toContain("OpenAI");
    expect(cards[0]?.textContent).toContain("Current");
    expect(cards[0]?.textContent).toContain("Base URL: https://api.openai.com/v1");
    expect(cards[0]?.textContent).toContain("API Key: sk-...123");
    expect(cards[0]?.textContent).toContain("Model: gpt-4.1, gpt-4.1-mini");
    expect(cards[2]?.textContent).toContain("Not configured");

    const search = host.querySelector<HTMLInputElement>(".desktop-settings-provider-search");
    search!.value = "deep";
    search?.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();

    expect(cards.map((card) => card.hidden)).toEqual([true, false, true]);

    mounted.unmount();
    expect(host.textContent).toBe("");
  });

  test("dispatches refresh, add, and provider-card selection actions", () => {
    const host = document.createElement("section");
    const actions: string[] = [];

    const mounted = mountSettingsProviderManagementIsland(host, {
      pane,
      promptProviderId: () => "custom-openai",
      onSettingsAction: (event: DesktopSettingsActionEvent) => {
        if (event.action === "edit") {
          actions.push(`${event.action}:${event.fieldId}:${String(event.value)}`);
          return;
        }
        actions.push(event.action);
      },
    });

    host.querySelector<HTMLButtonElement>('[data-desktop-settings-action="discoverModels"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-desktop-settings-action="addProvider"]')?.click();
    host.querySelector<HTMLElement>('[data-desktop-settings-provider-card="deepseek"]')
      ?.querySelector<HTMLButtonElement>('[data-desktop-settings-provider-action="settings"]')
      ?.click();

    expect(actions).toEqual([
      "discoverModels",
      "edit:selectedProvider:custom-openai",
      "edit:selectedProvider:deepseek",
    ]);

    mounted.unmount();
  });

  test("disables model refresh when provider discovery is unavailable", () => {
    const host = document.createElement("section");

    const mounted = mountSettingsProviderManagementIsland(host, {
      pane: {
        ...pane,
        providerEditor: {
          ...pane.providerEditor,
          canDiscoverModels: false,
        },
      },
    });

    expect(host.querySelector<HTMLButtonElement>('[data-desktop-settings-action="discoverModels"]')?.disabled).toBe(true);

    mounted.unmount();
  });
});
