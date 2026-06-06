// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import type { DesktopSettingsPaneModel } from "../desktopSettingsProviders";
import type { DesktopSettingsActionEvent } from "../desktopWorkbenchShell";
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
      id: "agent",
      label: "Agent",
      fields: [
        {
          id: "model",
          label: "Model",
          value: "gpt-4.1-mini",
          state: "normal",
          control: "text",
          inputValue: "gpt-4.1-mini",
        },
      ],
    },
    {
      id: "provider",
      label: "Provider",
      fields: [
        {
          id: "selectedProvider",
          label: "Provider",
          value: "openai",
          state: "normal",
          control: "select",
          inputValue: "openai",
          options: [
            { value: "auto", label: "Auto" },
            { value: "openai", label: "OpenAI" },
            { value: "deepseek", label: "DeepSeek" },
          ],
        },
      ],
    },
  ],
  providerCatalog: [],
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

    const provider = host.querySelector<HTMLSelectElement>('[data-desktop-settings-control="selectedProvider"]');
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
    expect(actions).toEqual(["edit:selectedProvider:deepseek", "edit:model:gpt-4.1", "save"]);

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
