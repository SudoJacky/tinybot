// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { nextTick } from "vue";
import type { DesktopSettingsPaneModel } from "../../settings/desktopSettingsProviders";
import type { DesktopSettingsActionEvent } from "../../shell/desktopWorkbenchShell";
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
    {
      id: "openai",
      label: "OpenAI",
      profileId: "work",
      status: "ready",
      enabled: true,
      baseUrl: "https://api.openai.com/v1",
      apiKey: {
        value: "",
        displayValue: "sk-...123",
        masked: true,
        empty: false,
      },
      models: ["gpt-4.1", "gpt-4.1-mini"],
      canDiscoverModels: true,
    },
    {
      id: "deepseek",
      label: "DeepSeek",
      profileId: "deepseek",
      status: "ready",
      enabled: true,
      baseUrl: "https://api.deepseek.com",
      apiKey: {
        value: "",
        displayValue: "sk-...deep",
        masked: true,
        empty: false,
      },
      models: ["deepseek-chat"],
      canDiscoverModels: true,
    },
    {
      id: "ollama",
      label: "Ollama",
      profileId: "ollama",
      status: "not_configured",
      enabled: false,
      baseUrl: null,
      apiKey: {
        value: "",
        displayValue: "",
        masked: false,
        empty: true,
      },
      models: [],
      canDiscoverModels: true,
    },
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
    expect(host.querySelector('[data-desktop-settings-action="addProvider"]')?.textContent).toBe("+ Add provider");

    const cards = Array.from(host.querySelectorAll<HTMLElement>(".desktop-settings-provider-card"));
    expect(cards.map((card) => card.getAttribute("data-desktop-settings-provider-card"))).toEqual([
      "openai",
      "deepseek",
      "ollama",
    ]);
    expect(cards[0]?.textContent).toContain("OpenAI");
    expect(cards[0]?.textContent).toContain("Current");
    expect(cards[0]?.textContent).toContain("Endpoint: https://api.openai.com/v1");
    expect(cards[0]?.textContent).toContain("API Key: sk-...123");
    expect(cards[0]?.textContent).toContain("Models: 2 models");
    expect(cards[0]?.querySelector('[data-desktop-settings-provider-action="models"]')).toBeNull();
    expect(cards[0]?.querySelector('[data-desktop-settings-provider-action="settings"]')).toBeNull();
    expect(cards[0]?.querySelector('[data-desktop-settings-provider-action="toggle"]')).toBeNull();
    expect(cards[0]?.textContent).not.toContain("Advanced settings");
    expect(cards[1]?.textContent).toContain("Endpoint: https://api.deepseek.com");
    expect(cards[1]?.textContent).toContain("Models: 1 model");
    expect(cards[2]?.textContent).toContain("Not configured");
    expect(host.querySelector('[data-desktop-settings-provider-detail="openai"]')?.textContent).toContain("Provider actions");
    expect(Array.from(
      host.querySelectorAll("[data-desktop-settings-provider-command]"),
      (node) => node.getAttribute("data-desktop-settings-provider-command"),
    )).toEqual(["discoverModels", "testConnection", "useAsDefault", "rename", "duplicate", "delete"]);

    const search = host.querySelector<HTMLInputElement>(".desktop-settings-provider-search");
    search!.value = "deep";
    search?.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();

    expect(Array.from(host.querySelectorAll<HTMLElement>(".desktop-settings-provider-card")).map((card) => card.getAttribute("data-desktop-settings-provider-card"))).toEqual([
      "deepseek",
    ]);

    mounted.unmount();
    expect(host.textContent).toBe("");
  });

  test("dispatches detail commands and uses a durable provider setup flow", async () => {
    const host = document.createElement("section");
    const actions: string[] = [];
    let prompted = false;

    const mounted = mountSettingsProviderManagementIsland(host, {
      pane,
      promptProviderId: () => {
        prompted = true;
        return "custom-openai";
      },
      onSettingsAction: (event: DesktopSettingsActionEvent) => {
        if (event.action === "edit") {
          actions.push(`${event.action}:${event.fieldId}:${String(event.value)}`);
          return;
        }
        actions.push(event.action);
      },
    });

    host.querySelector<HTMLButtonElement>('[data-desktop-settings-action="addProvider"]')?.click();
    await nextTick();
    expect(prompted).toBe(false);
    expect(host.querySelector("[data-desktop-settings-provider-setup]")?.textContent).toContain("Add provider");
    host.querySelector<HTMLInputElement>('[data-desktop-settings-control="newProviderProfileName"]')!.value = "local profile";
    host.querySelector<HTMLInputElement>('[data-desktop-settings-control="newProviderProfileName"]')?.dispatchEvent(new Event("input", { bubbles: true }));
    host.querySelector<HTMLSelectElement>('[data-desktop-settings-control="newProviderType"]')!.value = "localai";
    host.querySelector<HTMLSelectElement>('[data-desktop-settings-control="newProviderType"]')?.dispatchEvent(new Event("change", { bubbles: true }));
    host.querySelector<HTMLInputElement>('[data-desktop-settings-control="newProviderEndpoint"]')!.value = "http://127.0.0.1:8080/v1";
    host.querySelector<HTMLInputElement>('[data-desktop-settings-control="newProviderEndpoint"]')?.dispatchEvent(new Event("input", { bubbles: true }));
    host.querySelector<HTMLTextAreaElement>('[data-desktop-settings-control="newProviderModels"]')!.value = "local-model";
    host.querySelector<HTMLTextAreaElement>('[data-desktop-settings-control="newProviderModels"]')?.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    host.querySelector<HTMLButtonElement>('[data-desktop-settings-provider-setup-action="create"]')?.click();

    host.querySelector<HTMLElement>('[data-desktop-settings-provider-card="deepseek"]')
      ?.querySelector<HTMLButtonElement>('[data-desktop-settings-provider-action="select"]')
      ?.click();
    host.querySelector<HTMLButtonElement>('[data-desktop-settings-provider-command="discoverModels"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-desktop-settings-provider-command="testConnection"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-desktop-settings-provider-command="useAsDefault"]')?.click();

    expect(actions).toEqual(expect.arrayContaining([
      "edit:selectedProvider:localai",
      "edit:profileId:local profile",
      "edit:apiBase:http://127.0.0.1:8080/v1",
      "edit:models:local-model",
      "edit:selectedProvider:deepseek",
      "discoverModels",
      "testProviderConnection",
      "edit:provider:openai",
    ]));

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

    expect(host.querySelector<HTMLButtonElement>('[data-desktop-settings-provider-command="discoverModels"]')?.disabled).toBe(true);

    mounted.unmount();
  });
});
