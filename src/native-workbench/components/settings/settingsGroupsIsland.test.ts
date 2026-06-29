// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import type { DesktopSettingsPaneModel } from "../../settings/desktopSettingsProviders";
import type { DesktopSettingsActionEvent } from "../../shell/desktopWorkbenchShell";
import { mountSettingsGroupsIsland } from "./settingsGroupsIsland";

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
          id: "model",
          label: "Model",
          value: "gpt-4.1",
          state: "normal",
          control: "text",
          inputValue: "gpt-4.1",
          requirement: "required",
          configurationMode: "freeform",
        },
        {
          id: "timezone",
          label: "Timezone",
          value: "Asia/Shanghai",
          persistentPath: "agents.defaults.timezone",
          sourceKind: "config",
          valueOrigin: "explicit",
          applyEffect: "immediate",
          state: "invalid",
          control: "text",
          inputValue: "Asia/Shanghai",
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
          options: [{ value: "openai", label: "OpenAI" }],
        },
        {
          id: "apiBase",
          label: "API base",
          value: "https://api.openai.com/v1",
          persistentPath: "providers.openai.api_base",
          sourceKind: "config",
          valueOrigin: "explicit",
          applyEffect: "immediate",
          state: "normal",
          control: "text",
          inputValue: "https://api.openai.com/v1",
          requirement: "optional",
          configurationMode: "url",
        },
      ],
    },
    {
      id: "knowledge",
      label: "Knowledge",
      fields: [
        {
          id: "enabled",
          label: "Enabled",
          value: "true",
          state: "normal",
          control: "checkbox",
          inputValue: "true",
          checked: true,
          requirement: "optional",
          configurationMode: "toggle",
        },
        {
          id: "retrievalMode",
          label: "Retrieval mode",
          value: "hybrid",
          state: "normal",
          control: "select",
          inputValue: "hybrid",
          requirement: "optional",
          configurationMode: "fixed",
          options: [
            { value: "hybrid", label: "Hybrid" },
            { value: "semantic", label: "Semantic" },
          ],
        },
      ],
    },
    {
      id: "tools-approvals",
      label: "Tools & Approvals",
      fields: [
        {
          id: "mcpServers",
          label: "MCP servers",
          value: "{}",
          state: "normal",
          control: "textarea",
          inputValue: "{}",
          requirement: "optional",
          configurationMode: "json",
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
    models: ["gpt-4.1"],
    canDiscoverModels: true,
  },
};

describe("settings groups Vue island", () => {
  test("renders settings groups and dispatches edits from native controls", () => {
    const host = document.createElement("div");
    const actions: string[] = [];

    const mounted = mountSettingsGroupsIsland(host, {
      pane,
      onSettingsAction: (event: DesktopSettingsActionEvent) => {
        if (event.action === "edit") {
          actions.push(`${event.fieldId}:${String(event.value)}`);
        }
      },
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("settings-groups");
    expect(host.className).toContain("desktop-settings-grid");
    expect(Array.from(host.querySelectorAll("[data-desktop-settings-group]")).map((group) => group.getAttribute("data-desktop-settings-group"))).toEqual([
      "general",
      "provider-models",
      "knowledge",
      "tools-approvals",
    ]);
    expect(host.textContent).toContain("Default model, profile, and timezone used by the desktop workbench.");
    expect(host.textContent).toContain("Retrieval behavior for workspace knowledge and RAG context.");
    expect(host.querySelector('[data-desktop-settings-control="model"]')).toBeNull();
    expect(host.querySelector('[data-desktop-settings-control="selectedProvider"]')).toBeNull();

    const timezoneField = host.querySelector('[data-desktop-settings-field="timezone"]');
    expect(timezoneField?.getAttribute("data-persistent-path")).toBe("agents.defaults.timezone");
    expect(timezoneField?.getAttribute("data-source-kind")).toBe("config");
    expect(timezoneField?.getAttribute("data-value-origin")).toBe("explicit");
    expect(timezoneField?.textContent).toContain("Explicit value");
    expect(timezoneField?.textContent).toContain("Immediate");

    const timezone = host.querySelector<HTMLInputElement>('[data-desktop-settings-control="timezone"]');
    expect(timezone?.tagName).toBe("INPUT");
    expect(timezone?.getAttribute("aria-invalid")).toBe("true");
    timezone!.value = "UTC";
    timezone?.dispatchEvent(new Event("input", { bubbles: true }));

    const enabled = host.querySelector<HTMLInputElement>('[data-desktop-settings-control="enabled"]');
    expect(enabled?.type).toBe("checkbox");
    enabled!.checked = false;
    enabled?.dispatchEvent(new Event("change", { bubbles: true }));

    const retrievalMode = host.querySelector<HTMLSelectElement>('[data-desktop-settings-control="retrievalMode"]');
    expect(Array.from(retrievalMode?.querySelectorAll("option") ?? []).map((option) => option.textContent)).toEqual([
      "Hybrid",
      "Semantic",
    ]);
    retrievalMode!.value = "semantic";
    retrievalMode?.dispatchEvent(new Event("change", { bubbles: true }));

    const mcpServers = host.querySelector<HTMLTextAreaElement>('[data-desktop-settings-control="mcpServers"]');
    expect(mcpServers?.tagName).toBe("TEXTAREA");
    mcpServers!.value = "{\"server\": true}";
    mcpServers?.dispatchEvent(new Event("input", { bubbles: true }));

    expect(actions).toEqual([
      "timezone:UTC",
      "enabled:false",
      "retrievalMode:semantic",
      "mcpServers:{\"server\": true}",
    ]);

    mounted.unmount();
    expect(host.textContent).toBe("");
  });
});
