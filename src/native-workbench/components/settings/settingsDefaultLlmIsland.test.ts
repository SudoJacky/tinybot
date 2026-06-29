// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import type { DesktopSettingsPaneModel } from "../../settings/desktopSettingsProviders";
import type { DesktopSettingsActionEvent } from "../../shell/desktopWorkbenchShell";
import { mountSettingsDefaultLlmIsland } from "./settingsDefaultLlmIsland";

const pane: DesktopSettingsPaneModel = {
  dirty: true,
  validationErrors: [],
  save: {
    status: "idle",
    message: "Unsaved changes",
    canSave: true,
  },
  groups: [
    {
      id: "general",
      label: "General",
      fields: [
        {
          id: "provider",
          label: "Provider",
          value: "openai",
          state: "normal",
          control: "select",
          inputValue: "openai",
          requirement: "optional",
          configurationMode: "fixed",
          options: [
            { value: "auto", label: "Auto" },
            { value: "openai", label: "OpenAI" },
            { value: "deepseek", label: "DeepSeek" },
          ],
        },
        {
          id: "model",
          label: "Model",
          value: "gpt-4.1-mini",
          state: "normal",
          control: "text",
          inputValue: "gpt-4.1-mini",
          requirement: "required",
          configurationMode: "freeform",
        },
      ],
    },
    {
      id: "provider-models",
      label: "Provider & Models",
      fields: [
        {
          id: "selectedProvider",
          label: "Provider",
          value: "openai",
          state: "normal",
          control: "select",
          inputValue: "openai",
          requirement: "required",
          configurationMode: "fixed",
          options: [
            { value: "auto", label: "Auto" },
            { value: "openai", label: "OpenAI" },
            { value: "deepseek", label: "DeepSeek" },
          ],
        },
      ],
    },
  ],
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

describe("settings default LLM Vue island", () => {
  test("renders default LLM controls and dispatches settings actions", () => {
    const host = document.createElement("section");
    const actions: string[] = [];

    const mounted = mountSettingsDefaultLlmIsland(host, {
      pane,
      onSettingsAction: (event: DesktopSettingsActionEvent) => {
        if (event.action === "edit") {
          actions.push(`${event.action}:${event.fieldId}:${String(event.value)}`);
          return;
        }
        actions.push(event.action);
      },
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("settings-default-llm");
    expect(host.className).toContain("desktop-settings-default-llm-card");
    expect(host.getAttribute("aria-label")).toBe("Default LLM settings");
    expect(host.textContent).toContain("Default LLM");
    expect(host.textContent).toContain("Provider");
    expect(host.textContent).toContain("Model");
    expect(host.textContent).toContain("global default LLM model");

    const provider = host.querySelector<HTMLSelectElement>('[data-desktop-settings-control="provider"]');
    expect(provider?.tagName).toBe("SELECT");
    expect(Array.from(provider?.querySelectorAll("option") ?? []).map((option) => option.textContent)).toEqual([
      "Auto",
      "OpenAI",
      "DeepSeek",
    ]);
    provider!.value = "deepseek";
    provider?.dispatchEvent(new Event("change", { bubbles: true }));

    const model = host.querySelector<HTMLSelectElement>('[data-desktop-settings-control="model"]');
    expect(model?.tagName).toBe("SELECT");
    expect(Array.from(model?.querySelectorAll("option") ?? []).map((option) => option.value)).toEqual([
      "gpt-4.1-mini",
      "gpt-4.1",
    ]);
    model!.value = "gpt-4.1";
    model?.dispatchEvent(new Event("change", { bubbles: true }));

    host.querySelector<HTMLButtonElement>('[data-desktop-settings-action="save"]')?.click();
    expect(actions).toEqual(["edit:provider:deepseek", "edit:model:gpt-4.1", "save"]);

    mounted.unmount();
    expect(host.textContent).toBe("");
  });

  test("renders text model input when no model catalog is loaded", () => {
    const host = document.createElement("section");
    const actions: string[] = [];

    const mounted = mountSettingsDefaultLlmIsland(host, {
      pane: {
        ...pane,
        save: {
          status: "saved",
          message: "Saved",
          canSave: false,
        },
        dirty: false,
        providerEditor: {
          ...pane.providerEditor,
          models: [],
        },
        providerCatalog: pane.providerCatalog.map((provider) => ({ ...provider, models: [] })),
      },
      onSettingsAction: (event: DesktopSettingsActionEvent) => {
        if (event.action === "edit") {
          actions.push(`${event.fieldId}:${String(event.value)}`);
        }
      },
    });

    const model = host.querySelector<HTMLInputElement>('[data-desktop-settings-control="model"]');
    expect(model?.tagName).toBe("INPUT");
    model!.value = "custom-model";
    model?.dispatchEvent(new Event("input", { bubbles: true }));

    expect(host.querySelector<HTMLButtonElement>('[data-desktop-settings-action="save"]')?.disabled).toBe(true);
    expect(actions).toEqual(["model:custom-model"]);

    mounted.unmount();
  });
});
