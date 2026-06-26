import { describe, expect, test } from "vitest";
import {
  buildDesktopSettingsSearchableIndex,
  canonicalizeDesktopSettingsPersistentPath,
  validateDesktopSettingsPaneSchemaCoverage,
} from "./desktopSettingsSchemaCoverage";
import {
  buildDesktopProviderCatalogItems,
  buildDesktopSettingsFormState,
  buildDesktopSettingsPaneModel,
} from "./desktopSettingsProviders";

describe("desktop settings schema coverage", () => {
  test("canonicalizes known legacy aliases used by settings persistence", () => {
    expect(canonicalizeDesktopSettingsPersistentPath("agents.defaults.max_tokens")).toBe("agents.defaults.maxTokens");
    expect(canonicalizeDesktopSettingsPersistentPath("tools.mcp_servers.docs.command")).toBe("tools.mcpServers.docs.command");
    expect(canonicalizeDesktopSettingsPersistentPath("gateway.heartbeat.interval_s")).toBe("gateway.heartbeat.intervalS");
  });

  test("all rendered persistent settings paths have dispositions", () => {
    const providerCatalog = buildDesktopProviderCatalogItems([
      { id: "deepseek", displayName: "DeepSeek", status: "ready" },
    ]);
    const state = buildDesktopSettingsFormState({
      agents: {
        defaults: {
          model: "deepseek-chat",
          provider: "deepseek",
          workspace: "D:/work",
          timezone: "UTC",
        },
      },
      providers: {
        deepseek: {
          api_key: "sk-live",
          api_base: "https://api.deepseek.com",
          models: ["deepseek-chat"],
        },
      },
      gateway: { host: "127.0.0.1", port: 18790 },
    }, providerCatalog);
    const pane = buildDesktopSettingsPaneModel(state, { providerCatalog });

    expect(validateDesktopSettingsPaneSchemaCoverage(pane)).toEqual([]);
  });

  test("flags duplicate editable owners for the same canonical path", () => {
    const providerCatalog = buildDesktopProviderCatalogItems([
      { id: "deepseek", displayName: "DeepSeek", status: "ready" },
    ]);
    const state = buildDesktopSettingsFormState({
      agents: { defaults: { model: "deepseek-chat", provider: "deepseek" } },
    }, providerCatalog);
    const pane = buildDesktopSettingsPaneModel(state, { providerCatalog });
    pane.groups.push({
      id: "logs-diagnostics",
      label: "Diagnostics",
      fields: [{
        id: "duplicateModel",
        label: "Duplicate model",
        persistentPath: "agents.defaults.model",
        sourceKind: "config",
        valueOrigin: "explicit",
        value: "deepseek-chat",
        state: "normal",
        control: "text",
        inputValue: "deepseek-chat",
        requirement: "optional",
        configurationMode: "freeform",
      }],
    });

    expect(validateDesktopSettingsPaneSchemaCoverage(pane)).toContainEqual({
      field: "logs-diagnostics.duplicateModel",
      owner: "general.model",
      persistentPath: "agents.defaults.model",
      code: "duplicate_editable_owner",
    });
  });

  test("searchable index includes rendered safe metadata only", () => {
    const providerCatalog = buildDesktopProviderCatalogItems([
      { id: "deepseek", displayName: "DeepSeek", status: "ready" },
    ]);
    const state = buildDesktopSettingsFormState({
      agents: { defaults: { model: "deepseek-chat", provider: "deepseek", workspace: "D:/work" } },
      providers: { deepseek: { api_key: "sk-live", api_base: "https://api.deepseek.com" } },
    }, providerCatalog);
    const pane = buildDesktopSettingsPaneModel(state, { providerCatalog });
    pane.groups.push({
      id: "memory-experience",
      label: "Memory",
      navigationMode: "hidden",
      fields: [{
        id: "hiddenEditable",
        label: "Hidden editable",
        persistentPath: "agents.defaults.model",
        sourceKind: "config",
        valueOrigin: "explicit",
        value: "hidden",
        state: "normal",
        control: "text",
        inputValue: "hidden",
        requirement: "optional",
        configurationMode: "freeform",
      }],
    });

    const index = buildDesktopSettingsSearchableIndex(pane);

    expect(index.some((row) => row.field === "files-workspace.workspace")).toBe(true);
    expect(index.some((row) => row.field === "provider-models.apiKey")).toBe(false);
    expect(index.some((row) => row.text.includes("sk-live"))).toBe(false);
    expect(index.some((row) => row.field === "memory-experience.hiddenEditable")).toBe(false);
  });
});
