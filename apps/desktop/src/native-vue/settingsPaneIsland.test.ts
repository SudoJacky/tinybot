// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { nextTick } from "vue";
import {
  buildDesktopSettingsFormState,
  buildDesktopSettingsPaneModel,
} from "../desktopSettingsProviders";
import type { DesktopSettingsActionEvent } from "../desktopWorkbenchShell";
import { mountSettingsPaneIsland } from "./settingsPaneIsland";

const providerCatalog = [{ id: "openai", displayName: "OpenAI", status: "ready" }];

const savedState = buildDesktopSettingsFormState({
  agents: { defaults: { model: "gpt-4.1-mini", provider: "openai", active_profile: "work", timezone: "Asia/Shanghai" } },
  providers: {
    profiles: {
      work: {
        provider: "openai",
        api_key: "sk-live",
        api_base: "https://api.openai.com/v1",
        models: ["gpt-4.1-mini"],
      },
    },
  },
}, providerCatalog);

const draftState = buildDesktopSettingsFormState({
  agents: { defaults: { model: "gpt-4.1", provider: "openai", active_profile: "work", timezone: "Asia/Shanghai" } },
  providers: {
    profiles: {
      work: {
        provider: "openai",
        api_key: "sk-live",
        api_base: "https://api.openai.com/v1",
        models: ["gpt-4.1", "gpt-4.1-mini"],
      },
    },
  },
  knowledge: { enabled: true },
}, providerCatalog);

const pane = buildDesktopSettingsPaneModel(draftState, {
  lastSavedState: savedState,
  providerCatalog,
  saveStatus: "idle",
});

describe("settings pane Vue island", () => {
  test("renders redesigned General, Provider, and Knowledge task pages", async () => {
    const host = document.createElement("section");
    const actions: string[] = [];

    const mounted = mountSettingsPaneIsland(host, {
      pane,
      onSettingsAction: (event: DesktopSettingsActionEvent) => {
        if (event.action === "edit") {
          actions.push(`${event.action}:${event.fieldId}:${String(event.value)}`);
          return;
        }
        actions.push(event.action);
      },
    });
    await nextTick();

    expect(host.querySelector(".desktop-settings-breadcrumb h2")?.textContent).toBe("General");
    expect(host.querySelector(".desktop-settings-default-ai-section")?.textContent).toContain("Default AI");
    expect(host.querySelector(".desktop-settings-default-ai-section")?.textContent).toContain("OpenAI / gpt-4.1");
    expect(host.querySelector(".desktop-settings-profile-locale-section")?.textContent).toContain("Profile & locale");
    expect(host.querySelector(".desktop-settings-profile-locale-section")?.textContent).toContain("Timezone");
    expect(host.querySelector(".desktop-settings-response-defaults-section")?.textContent).toContain("Response defaults");
    expect(host.querySelector(".desktop-settings-response-defaults-section")?.textContent).toContain("tokens");
    expect(host.querySelector('[data-desktop-settings-group="general"]')).toBeNull();

    host.querySelector<HTMLAnchorElement>('[data-desktop-settings-nav="provider-models"]')?.click();
    await nextTick();

    expect(host.querySelector(".desktop-settings-breadcrumb h2")?.textContent).toBe("Provider & Models");
    expect(host.querySelector("[data-desktop-settings-provider-summary=\"total\"]")?.textContent).toContain("1 provider");
    expect(host.querySelector("[data-desktop-settings-provider-summary=\"ready\"]")?.textContent).toContain("1 ready");
    expect(host.querySelector("[data-desktop-settings-provider-summary=\"models\"]")?.textContent).toContain("2 models");
    expect(host.querySelector('[data-desktop-settings-provider-card="openai"]')?.getAttribute("data-selected")).toBe("true");
    expect(host.querySelector(".desktop-settings-provider-detail-panel")?.textContent).toContain("Edit OpenAI");
    expect(host.querySelector(".desktop-settings-provider-detail-panel")?.textContent).toContain("Connection");
    expect(host.querySelector(".desktop-settings-provider-detail-panel")?.textContent).toContain("Model catalog");
    expect(host.querySelector(".desktop-settings-provider-detail-panel [data-desktop-settings-control=\"apiKey\"]")?.getAttribute("type")).toBe("password");
    expect(host.querySelector('[data-desktop-settings-group="provider-models"]')).toBeNull();

    host.querySelector<HTMLAnchorElement>('[data-desktop-settings-nav="knowledge"]')?.click();
    await nextTick();

    expect(host.querySelector(".desktop-settings-breadcrumb h2")?.textContent).toBe("Knowledge");
    expect(host.querySelector("[data-desktop-settings-knowledge-enabled]")?.textContent).toContain("Knowledge enabled");
    expect(host.querySelector("[data-desktop-settings-knowledge-action=\"openDocuments\"]")?.textContent).toContain("Open documents");
    expect(Array.from(
      host.querySelectorAll("[data-desktop-settings-knowledge-stage]"),
      (node) => node.getAttribute("data-desktop-settings-knowledge-stage"),
    )).toEqual(["documents", "chunking", "embeddings", "retrieval", "rerank", "graph"]);
    expect(host.querySelector("[data-desktop-settings-retrieval-mode=\"hybrid\"]")?.getAttribute("aria-pressed")).toBe("true");
    host.querySelector<HTMLButtonElement>('[data-desktop-settings-quality-preset="deep"]')?.click();
    expect(actions).toContain("edit:rerankEnabled:true");
    expect(actions).toContain("edit:graphExtractionEnabled:true");
    expect(host.querySelector('[data-desktop-settings-group="knowledge"]')).toBeNull();

    mounted.unmount();
  });

  test("filters and selects provider cards while preserving selected detail state", async () => {
    const host = document.createElement("section");
    const actions: string[] = [];
    const multiProviderCatalog = [
      { id: "openai", displayName: "OpenAI", status: "ready", models: ["gpt-4.1", "gpt-4.1-mini"] },
      { id: "anthropic", displayName: "Anthropic", status: "not_configured", models: ["claude-3-5-sonnet"] },
    ];
    const state = buildDesktopSettingsFormState({
      agents: { defaults: { provider: "openai", model: "gpt-4.1", active_profile: "work" } },
      providers: {
        profiles: {
          work: {
            provider: "openai",
            api_key: "sk-live",
            api_base: "https://api.openai.com/v1",
            models: ["gpt-4.1", "gpt-4.1-mini"],
          },
        },
      },
    }, multiProviderCatalog);
    const multiPane = buildDesktopSettingsPaneModel(state, {
      lastSavedState: state,
      providerCatalog: multiProviderCatalog,
    });

    const mounted = mountSettingsPaneIsland(host, {
      pane: multiPane,
      initialActiveGroupId: "provider-models",
      onSettingsAction: (event: DesktopSettingsActionEvent) => {
        if (event.action === "edit") {
          actions.push(`${event.fieldId}:${String(event.value)}`);
        }
      },
    });
    await nextTick();

    expect(host.querySelector("[data-desktop-settings-provider-summary=\"total\"]")?.textContent).toContain("2 providers");
    expect(host.querySelector('[data-desktop-settings-provider-card="openai"]')?.getAttribute("data-selected")).toBe("true");
    expect(host.querySelector(".desktop-settings-provider-detail-panel")?.textContent).toContain("Edit OpenAI");

    const search = host.querySelector<HTMLInputElement>(".desktop-settings-provider-search");
    search!.value = "Anthropic";
    search?.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    expect(host.querySelector('[data-desktop-settings-provider-card="openai"]')).toBeNull();
    expect(host.querySelector('[data-desktop-settings-provider-card="anthropic"]')?.textContent).toContain("Anthropic");

    host.querySelector<HTMLButtonElement>('[data-desktop-settings-provider-card="anthropic"] [data-desktop-settings-provider-action="settings"]')?.click();
    expect(actions).toContain("selectedProvider:anthropic");
    expect(host.querySelector(".desktop-settings-provider-detail-panel")?.textContent).toContain("Edit OpenAI");

    mounted.unmount();
  });

  test("keeps Knowledge disabled fields visible and maps presets before manual overrides", async () => {
    const host = document.createElement("section");
    const actions: string[] = [];
    const disabledState = buildDesktopSettingsFormState({
      knowledge: {
        enabled: false,
        auto_retrieve: true,
        retrieval_mode: "dense",
        max_chunks: 4,
        rerank_enabled: true,
        graph_extraction_enabled: true,
      },
    }, providerCatalog);
    const disabledPane = buildDesktopSettingsPaneModel(disabledState, {
      lastSavedState: disabledState,
      providerCatalog,
    });

    const mounted = mountSettingsPaneIsland(host, {
      pane: disabledPane,
      initialActiveGroupId: "knowledge",
      onSettingsAction: (event: DesktopSettingsActionEvent) => {
        if (event.action === "edit") {
          actions.push(`${event.fieldId}:${String(event.value)}`);
        }
      },
    });
    await nextTick();

    expect(host.querySelector(".desktop-settings-knowledge-page")?.getAttribute("data-knowledge-disabled")).toBe("true");
    expect(host.querySelector("[data-desktop-settings-knowledge-stage=\"retrieval\"]")?.getAttribute("data-state")).toBe("disabled");
    expect(host.querySelector("[data-desktop-settings-knowledge-stage=\"rerank\"]")?.textContent).toContain("Enabled");
    expect(host.querySelector<HTMLInputElement>('[data-desktop-settings-control="maxChunks"]')?.disabled).toBe(true);

    host.querySelector<HTMLButtonElement>('[data-desktop-settings-quality-preset="fast"]')?.click();
    expect(actions).toEqual([
      "maxChunks:3",
      "retrievalMode:sparse",
      "rerankEnabled:false",
      "graphExtractionEnabled:false",
    ]);

    mounted.unmount();

    const enabledHost = document.createElement("section");
    const enabledActions: string[] = [];
    const enabledState = buildDesktopSettingsFormState({
      knowledge: {
        enabled: true,
        retrieval_mode: "sparse",
        max_chunks: 3,
      },
    }, providerCatalog);
    const enabledPane = buildDesktopSettingsPaneModel(enabledState, {
      lastSavedState: enabledState,
      providerCatalog,
    });
    const enabledMounted = mountSettingsPaneIsland(enabledHost, {
      pane: enabledPane,
      initialActiveGroupId: "knowledge",
      onSettingsAction: (event: DesktopSettingsActionEvent) => {
        if (event.action === "edit") {
          enabledActions.push(`${event.fieldId}:${String(event.value)}`);
        }
      },
    });
    await nextTick();

    enabledHost.querySelector<HTMLButtonElement>('[data-desktop-settings-quality-preset="deep"]')?.click();
    enabledHost.querySelector<HTMLButtonElement>('[data-desktop-settings-retrieval-mode="sparse"]')?.click();
    expect(enabledActions).toEqual([
      "maxChunks:8",
      "retrievalMode:hybrid",
      "rerankEnabled:true",
      "graphExtractionEnabled:true",
      "retrievalMode:sparse",
    ]);

    enabledMounted.unmount();
  });

  test("renders the provided initial settings section", async () => {
    const host = document.createElement("section");

    const mounted = mountSettingsPaneIsland(host, {
      pane,
      initialActiveGroupId: "provider-models",
    });
    await nextTick();

    expect(host.querySelector(".desktop-settings-breadcrumb h2")?.textContent).toBe("Provider & Models");
    expect(host.querySelector('[data-desktop-settings-nav="provider-models"]')?.getAttribute("data-active")).toBe("true");
    expect(host.querySelector(".desktop-settings-provider-section")).not.toBeNull();
    expect(host.querySelector(".desktop-settings-default-llm-card")).toBeNull();

    mounted.unmount();
  });

  test("renders settings shell and forwards settings actions", async () => {
    const host = document.createElement("section");
    const focused: string[] = [];
    const actions: string[] = [];

    const mounted = mountSettingsPaneIsland(host, {
      pane,
      onFocusSettingsControl: (fieldId) => focused.push(fieldId),
      onSettingsAction: (event: DesktopSettingsActionEvent) => {
        if (event.action === "edit") {
          actions.push(`${event.action}:${event.fieldId}:${String(event.value)}`);
          return;
        }
        if (event.action === "testProviderConnection") {
          actions.push(`${event.action}:${event.providerId}`);
          return;
        }
        actions.push(event.action);
      },
      promptProviderId: () => "openai",
    });

    expect(host.className).toBe("desktop-workbench-section desktop-settings-pane");
    expect(host.getAttribute("data-desktop-vue-island")).toBe("settings-pane");
    expect(host.getAttribute("data-desktop-module-surface")).toBe("settings");
    expect(host.getAttribute("data-settings-layout")).toBe("section-pages");
    expect(host.getAttribute("aria-label")).toBe("Settings and providers");

    expect(host.querySelector(".desktop-settings-sidebar")?.textContent).toContain("General");
    expect(host.querySelector(".desktop-settings-breadcrumb h2")?.textContent).toBe("General");
    expect(host.querySelector(".desktop-settings-capability-map")).toBeNull();
    expect(host.querySelector(".desktop-settings-default-ai-section")?.textContent).toContain("Default AI");
    expect(host.querySelector(".desktop-settings-provider-section")).toBeNull();
    expect(host.querySelector(".desktop-settings-resolved-route-card")?.textContent).toContain("Resolved route");
    expect(Array.from(
      host.querySelectorAll(".desktop-settings-nav-heading"),
      (node) => node.textContent,
    )).toEqual(["Core", "Application", "System"]);
    expect(Array.from(
      host.querySelectorAll("[data-desktop-settings-nav]"),
      (node) => node.getAttribute("data-desktop-settings-nav"),
    )).toEqual([
      "general",
      "provider-models",
      "knowledge",
      "tools-approvals",
      "files-workspace",
      "channels",
      "gateway-runtime",
      "logs-diagnostics",
    ]);
    expect(host.querySelector('[data-desktop-settings-nav="memory-experience"]')).toBeNull();
    expect(host.querySelector('[data-desktop-settings-nav="skills"]')).toBeNull();
    expect(host.querySelector('[data-desktop-settings-nav="automations"]')).toBeNull();
    expect(Array.from(
      host.querySelectorAll("[data-desktop-settings-preview]"),
      (node) => node.getAttribute("data-desktop-settings-preview"),
    )).toEqual(["memory-experience", "skills", "automations"]);
    expect(Array.from(
      host.querySelectorAll("[data-desktop-settings-group]"),
      (node) => node.getAttribute("data-desktop-settings-group"),
    )).toEqual([]);
    expect(host.querySelector('[data-desktop-settings-group="knowledge"]')).toBeNull();
    expect(host.querySelector('[data-desktop-settings-field="timezone"] .desktop-settings-field-meta')?.textContent).toContain("Required");
    expect(host.querySelector('[data-desktop-settings-field="timezone"] .desktop-settings-field-meta')?.textContent).toContain("Free text");
    expect(host.querySelector(".desktop-settings-response-defaults-section")?.textContent).toContain("Response defaults");
    expect(host.querySelector('[data-desktop-settings-field="temperature"]')?.closest(".desktop-settings-response-defaults-section")).not.toBeNull();

    const navProvider = host.querySelector<HTMLAnchorElement>('[data-desktop-settings-nav="provider-models"]');
    navProvider?.click();
    await nextTick();
    expect(host.querySelector(".desktop-settings-breadcrumb h2")?.textContent).toBe("Provider & Models");
    expect(host.querySelector(".desktop-settings-default-llm-card")).toBeNull();
    expect(host.querySelector(".desktop-settings-provider-section")?.textContent).toContain("Connected providers");
    expect(host.querySelector('[data-desktop-settings-provider-card="openai"]')?.textContent).toContain("OpenAI");
    expect(host.querySelector('[data-desktop-settings-provider-card="openai"]')?.textContent).toContain("2 models");
    expect(host.querySelector('[data-desktop-settings-provider-card="openai"]')?.textContent).toContain("Configured profile");
    expect(host.querySelector('[data-desktop-settings-field="apiKey"] input')?.getAttribute("type")).toBe("password");
    expect(host.querySelector<HTMLInputElement>('[data-desktop-settings-control="apiKey"]')?.value).toBe("********");
    expect(host.querySelector('[data-desktop-settings-field="apiKey"] .desktop-settings-field-meta')?.textContent).toContain("Sensitive");
    expect(host.querySelector<HTMLButtonElement>('[data-desktop-settings-action="discoverModels"]')?.getAttribute("aria-label")).toBe("Refresh models for openai");
    host.querySelector<HTMLButtonElement>('[data-desktop-settings-provider-action="testConnection"]')?.click();
    const providerSave = host.querySelector<HTMLButtonElement>('[data-desktop-settings-action="save"]');
    expect(providerSave).not.toBeNull();
    providerSave?.click();

    const navFiles = host.querySelector<HTMLAnchorElement>('[data-desktop-settings-nav="files-workspace"]');
    navFiles?.click();
    await nextTick();
    expect(host.querySelector(".desktop-settings-breadcrumb h2")?.textContent).toBe("Files & Workspace");
    expect(Array.from(
      host.querySelectorAll("[data-desktop-settings-group]"),
      (node) => node.getAttribute("data-desktop-settings-group"),
    )).toEqual(["files-workspace"]);
    expect(host.querySelector('[data-desktop-settings-field="workspace"] input')?.getAttribute("placeholder")).toBe("~/.tinybot/workspace");
    expect(host.querySelector('[data-desktop-settings-field="sessionFiles"] output')?.textContent).toContain("Session file");
    expect(host.querySelector('[data-desktop-settings-field="sessionFiles"] [data-desktop-settings-control="sessionFiles"]')).toBeNull();
    expect(host.querySelector('[data-desktop-settings-nav="general"]')?.getAttribute("data-active")).toBeNull();
    const activeNavFiles = host.querySelector<HTMLAnchorElement>('[data-desktop-settings-nav="files-workspace"]');
    expect(activeNavFiles?.getAttribute("data-active")).toBe("true");
    expect(activeNavFiles?.getAttribute("aria-current")).toBe("page");
    expect(host.querySelector('[data-desktop-settings-field="workspace"] .desktop-settings-field-meta')?.textContent).toContain("Reload required");

    host.querySelector<HTMLAnchorElement>('[data-desktop-settings-nav="gateway-runtime"]')?.click();
    await nextTick();
    expect(host.querySelector('[data-desktop-settings-field="port"] .desktop-settings-field-meta')?.textContent).toContain("TCP port");
    expect(host.querySelector('[data-desktop-settings-field="port"] .desktop-settings-field-meta')?.textContent).toContain("Restart required");

    host.querySelector<HTMLAnchorElement>('[data-desktop-settings-nav="general"]')?.click();
    await nextTick();
    expect(host.querySelector('[data-desktop-settings-field="temperature"] .desktop-settings-field-meta')?.textContent).toContain("Recommended 0.1");
    const model = host.querySelector<HTMLInputElement>('[data-desktop-settings-control="model"]');
    expect(model?.getAttribute("role")).toBe("combobox");
    expect(model?.getAttribute("list")).toBe("desktop-settings-model-options");
    expect(Array.from(
      host.querySelectorAll("#desktop-settings-model-options option"),
      (node) => node.getAttribute("value"),
    )).toEqual(["gpt-4.1", "gpt-4.1-mini"]);
    model!.value = "custom-model-id";
    model?.dispatchEvent(new Event("input", { bubbles: true }));
    host.querySelector<HTMLButtonElement>('[data-desktop-settings-action="save"]')?.click();

    host.querySelector<HTMLAnchorElement>('[data-desktop-settings-nav="provider-models"]')?.click();
    await nextTick();
    host.querySelector<HTMLButtonElement>('[data-desktop-settings-action="discoverModels"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-desktop-settings-provider-action="settings"]')?.click();
    const apiKey = host.querySelector<HTMLInputElement>('[data-desktop-settings-control="apiKey"]');
    apiKey!.value = "sk-replacement";
    apiKey?.dispatchEvent(new Event("input", { bubbles: true }));

    expect(actions).toEqual([
      "testProviderConnection:openai",
      "save",
      "edit:model:custom-model-id",
      "save",
      "discoverModels",
      "edit:apiKey:sk-replacement",
    ]);
    expect(focused).toEqual(["apiBase"]);

    mounted.unmount();
    expect(host.textContent).toBe("");
  });

  test("renders labels, descriptions, validation, dirty state, and save actions from the pane model", async () => {
    const host = document.createElement("section");
    const actions: string[] = [];
    const metadataPane = buildDesktopSettingsPaneModel(draftState, {
      lastSavedState: savedState,
      providerCatalog,
      saveStatus: "idle",
    });
    metadataPane.groups[0] = {
      ...metadataPane.groups[0],
      description: "Model-owned group description",
      fields: metadataPane.groups[0].fields.map((field) => {
        if (field.id === "model") {
          return { ...field, label: "Model-owned default model label" };
        }
        if (field.id === "provider") {
          return { ...field, label: "Model-owned provider label" };
        }
        if (field.id === "timezone") {
          return {
            ...field,
            description: "Model-owned timezone description",
            state: "invalid",
            validationField: "gatewayPort",
          } as typeof field;
        }
        return field;
      }),
    };
    metadataPane.validationErrors = [{ field: "gatewayPort", errorKey: "portRange" }];
    metadataPane.dirty = true;
    metadataPane.save = {
      ...metadataPane.save,
      message: "Model-owned dirty state",
      canSave: false,
    };

    const mounted = mountSettingsPaneIsland(host, {
      pane: metadataPane,
      onSettingsAction: (event: DesktopSettingsActionEvent) => {
        actions.push(event.action);
      },
    });
    await nextTick();

    expect(host.querySelector(".desktop-settings-default-ai-section")?.textContent).toContain("Model-owned provider label");
    expect(host.querySelector(".desktop-settings-default-ai-section")?.textContent).toContain("Model-owned default model label");
    expect(host.querySelector(".desktop-settings-header-description")?.textContent).toContain("Model-owned group description");
    expect(host.querySelector('[data-desktop-settings-field="timezone"] .desktop-settings-field-description')?.textContent).toContain("Model-owned timezone description");
    expect(host.querySelector('[data-desktop-settings-status="save"]')?.textContent).toContain("Model-owned dirty state");

    const save = host.querySelector<HTMLButtonElement>('[data-desktop-settings-action="save"]');
    expect(save?.disabled).toBe(true);
    save?.click();
    expect(actions).toEqual([]);

    const timezone = host.querySelector<HTMLInputElement>('[data-desktop-settings-control="timezone"]');
    expect(timezone?.getAttribute("aria-invalid")).toBe("true");
    expect(host.querySelector("#desktop-settings-timezone-error")?.textContent).toContain("Port must be between 1 and 65535.");

    mounted.unmount();
  });

  test("renders visible save failure and field validation errors accessibly", async () => {
    const host = document.createElement("section");
    const actions: string[] = [];
    const invalidState = buildDesktopSettingsFormState({
      agents: { defaults: { model: "", provider: "openai", active_profile: "work", timezone: "Shanghai" } },
      providers: {
        profiles: {
          work: {
            provider: "openai",
            api_key: "sk-live",
            api_base: "https://api.openai.com/v1",
            models: ["gpt-4.1-mini"],
          },
        },
      },
    }, providerCatalog);
    const invalidPane = buildDesktopSettingsPaneModel(invalidState, {
      lastSavedState: savedState,
      providerCatalog,
      saveStatus: "failed",
      saveError: "HTTP 400",
    });

    const mounted = mountSettingsPaneIsland(host, {
      pane: invalidPane,
      onSettingsAction: (event: DesktopSettingsActionEvent) => {
        actions.push(event.action);
      },
    });
    await nextTick();

    const status = host.querySelector('[data-desktop-settings-status="save"]');
    expect(status?.getAttribute("aria-live")).toBe("polite");
    expect(status?.textContent).toContain("HTTP 400");
    expect(host.querySelector('[data-desktop-settings-alert="save"]')?.textContent).toContain("HTTP 400");
    host.querySelector<HTMLButtonElement>('[data-desktop-settings-action="retryLoad"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-desktop-settings-action="copyDiagnostics"]')?.click();
    expect(actions).toEqual(["retryLoad", "copyDiagnostics"]);

    const timezone = host.querySelector<HTMLInputElement>('[data-desktop-settings-control="timezone"]');
    const describedBy = timezone?.getAttribute("aria-describedby");
    expect(timezone?.getAttribute("aria-invalid")).toBe("true");
    expect(describedBy).toContain("desktop-settings-timezone-error");
    expect(host.querySelector("#desktop-settings-timezone-error")?.textContent).toContain("Invalid timezone");

    mounted.unmount();
  });

  test("does not label failed clean settings as saved", async () => {
    const host = document.createElement("section");
    const failedPane = buildDesktopSettingsPaneModel(savedState, {
      lastSavedState: savedState,
      providerCatalog,
      saveStatus: "failed",
      saveError: "Failed to load settings: offline",
    });

    const mounted = mountSettingsPaneIsland(host, {
      pane: failedPane,
    });
    await nextTick();

    expect(host.querySelector<HTMLButtonElement>('[data-desktop-settings-action="save"]')?.textContent).toBe("Save failed");
    expect(host.querySelector('[data-desktop-settings-alert="save"]')?.textContent).toContain("Failed to load settings: offline");

    mounted.unmount();
  });

  test("renders native save warnings and gateway fallback status", async () => {
    const host = document.createElement("section");
    const actions: string[] = [];
    const fallbackPane = buildDesktopSettingsPaneModel(savedState, {
      lastSavedState: savedState,
      providerCatalog,
      saveStatus: "saved",
      saveDetails: {
        transport: "gateway-fallback",
        updatedFields: ["agents.defaults.model"],
        applied: ["agents.defaults.model"],
        restartRequired: [],
        reloadRequired: [],
        warnings: ["Native patch failed; gateway fallback applied."],
      },
    });

    const mounted = mountSettingsPaneIsland(host, {
      pane: fallbackPane,
      onSettingsAction: (event: DesktopSettingsActionEvent) => {
        actions.push(event.action);
      },
    });
    await nextTick();

    const status = host.querySelector('[data-desktop-settings-status="save"]');
    expect(status?.getAttribute("aria-live")).toBe("polite");
    expect(status?.textContent).toContain("Settings saved through gateway fallback");
    expect(host.querySelector("[data-desktop-settings-save-details]")?.textContent).toContain("Saved through gateway fallback");
    expect(host.querySelector("[data-desktop-settings-save-details]")?.textContent).toContain("Native patch failed; gateway fallback applied.");
    expect(Array.from(
      host.querySelectorAll("[data-desktop-settings-save-detail]"),
      (node) => node.textContent,
    )).toEqual([
      "Saved through gateway fallback",
      "Native patch failed; gateway fallback applied.",
      "Copy diagnostics",
    ]);
    host.querySelector<HTMLButtonElement>('[data-desktop-settings-action="copyDiagnostics"]')?.click();
    expect(actions).toEqual(["copyDiagnostics"]);

    mounted.unmount();
  });

  test("renders restart and reload required actions", async () => {
    const host = document.createElement("section");
    const actions: string[] = [];
    const pendingPane = buildDesktopSettingsPaneModel(savedState, {
      lastSavedState: savedState,
      providerCatalog,
      saveStatus: "saved",
      saveDetails: {
        transport: "native",
        updatedFields: ["gateway.port", "agents.defaults.workspace"],
        applied: ["gatewayRuntimeChanged", "workspaceChanged"],
        restartRequired: ["gatewayRestartRequired"],
        reloadRequired: ["workspaceReloadRequired"],
        warnings: [],
      },
    });

    const mounted = mountSettingsPaneIsland(host, {
      pane: pendingPane,
      onSettingsAction: (event: DesktopSettingsActionEvent) => {
        actions.push(event.action);
      },
    });
    await nextTick();

    const status = host.querySelector('[data-desktop-settings-status="save"]');
    expect(status?.textContent).toContain("Gateway restart required");
    expect(status?.textContent).toContain("Workspace reload required");
    host.querySelector<HTMLButtonElement>('[data-desktop-settings-action="restartGateway"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-desktop-settings-action="reloadWorkspace"]')?.click();

    expect(actions).toEqual(["restartGateway", "reloadWorkspace"]);

    mounted.unmount();
  });

  test("searches shared settings metadata and activates non-sensitive results", async () => {
    const host = document.createElement("section");
    const actions: string[] = [];
    document.body.replaceChildren(host);

    const mounted = mountSettingsPaneIsland(host, {
      pane,
      onSettingsAction: (event: DesktopSettingsActionEvent) => {
        actions.push(event.action);
      },
    });
    await nextTick();

    const search = host.querySelector<HTMLInputElement>('[data-desktop-settings-search="query"]');
    search!.value = "workspace";
    search?.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();

    expect(Array.from(
      host.querySelectorAll("[data-desktop-settings-search-result]"),
      (node) => node.getAttribute("data-desktop-settings-search-result"),
    )).toContain("files-workspace.workspace");
    const workspaceResult = host.querySelector<HTMLButtonElement>('[data-desktop-settings-search-result="files-workspace.workspace"]');
    expect(workspaceResult?.textContent).toContain("Workspace");
    expect(workspaceResult?.textContent).toContain("Files & Workspace");
    workspaceResult?.click();
    await nextTick();

    const workspace = host.querySelector<HTMLInputElement>('[data-desktop-settings-control="workspace"]');
    expect(host.querySelector(".desktop-settings-breadcrumb h2")?.textContent).toBe("Files & Workspace");
    expect(document.activeElement).toBe(workspace);
    expect(host.querySelector('[data-desktop-settings-field="workspace"]')?.getAttribute("data-highlighted")).toBe("true");

    search!.value = "temperature";
    search?.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    host.querySelector<HTMLButtonElement>('[data-desktop-settings-search-result="general.temperature"]')?.click();
    await nextTick();
    expect(host.querySelector(".desktop-settings-response-defaults-section")?.textContent).toContain("Temperature");
    expect(document.activeElement).toBe(host.querySelector('[data-desktop-settings-control="temperature"]'));

    search!.value = "sk-live";
    search?.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    expect(host.querySelector("[data-desktop-settings-search-result]")).toBeNull();
    expect(host.querySelector('[data-desktop-settings-search-empty="true"]')?.textContent).toContain("No settings found");
    expect(host.textContent).not.toContain("sk-live");

    expect(host.querySelector('[data-desktop-settings-dirty-summary]')?.textContent).toContain("Unsaved changes");
    host.querySelector<HTMLButtonElement>('[data-desktop-settings-action="reset"]')?.click();
    expect(actions).toEqual(["reset"]);

    mounted.unmount();
    host.remove();
  });

  test("shows Auto model suggestions from enabled provider catalog instead of the provider editor", async () => {
    const host = document.createElement("section");
    const autoState = buildDesktopSettingsFormState({
      agents: { defaults: { model: "openai-fast", provider: "auto", active_profile: "deepseek", timezone: "UTC" } },
      providers: {
        profiles: {
          openai: {
            provider: "openai",
            api_key: "sk-openai",
            models: ["openai-fast"],
          },
          deepseek: {
            provider: "deepseek",
            api_key: "sk-deepseek",
            models: ["deepseek-chat"],
          },
        },
      },
    }, [
      { id: "openai", displayName: "OpenAI", status: "ready" },
      { id: "deepseek", displayName: "DeepSeek", status: "ready" },
    ]);
    const autoPane = buildDesktopSettingsPaneModel(autoState, {
      providerCatalog: [
        { id: "openai", displayName: "OpenAI", status: "ready" },
        { id: "deepseek", displayName: "DeepSeek", status: "ready" },
      ],
    });

    const mounted = mountSettingsPaneIsland(host, {
      pane: autoPane,
    });
    await nextTick();

    expect(host.querySelector('[data-desktop-settings-control="provider"]')?.textContent).toContain("Auto");
    expect(Array.from(
      host.querySelectorAll("#desktop-settings-model-options option"),
      (node) => node.getAttribute("value"),
    )).toEqual(["openai-fast", "deepseek-chat"]);
    expect(host.querySelector("[data-desktop-settings-auto-resolution]")?.textContent).toContain("Auto resolves to OpenAI / openai-fast");

    mounted.unmount();
  });

  test("uses a guided provider setup flow instead of prompt creation", async () => {
    const host = document.createElement("section");
    const actions: string[] = [];
    const mounted = mountSettingsPaneIsland(host, {
      pane,
      initialActiveGroupId: "provider-models",
      promptProviderId: () => {
        throw new Error("prompt should not be used");
      },
      onSettingsAction: (event: DesktopSettingsActionEvent) => {
        if (event.action === "edit") {
          actions.push(`${event.action}:${event.fieldId}:${String(event.value)}`);
        }
      },
    });
    await nextTick();

    host.querySelector<HTMLButtonElement>('[data-desktop-settings-action="addProvider"]')?.click();
    await nextTick();
    const providerId = host.querySelector<HTMLInputElement>('[data-desktop-settings-control="newProviderId"]');
    expect(providerId?.getAttribute("aria-describedby")).toBe("desktop-settings-provider-setup-guidance");
    expect(host.querySelector("[data-desktop-settings-provider-setup]")?.textContent).toContain("Add provider");
    expect(host.querySelector("#desktop-settings-provider-setup-guidance")?.textContent).toContain("API key");

    providerId!.value = "openai";
    providerId?.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    expect(host.querySelector("[data-desktop-settings-provider-setup-error]")?.textContent).toContain("already exists");

    providerId!.value = "localai";
    providerId?.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    host.querySelector<HTMLButtonElement>('[data-desktop-settings-provider-setup-action="create"]')?.click();

    expect(actions).toEqual(["edit:selectedProvider:localai"]);

    mounted.unmount();
  });

  test("renders provider secret replacement and clear controls", async () => {
    const host = document.createElement("section");
    const actions: string[] = [];
    document.body.replaceChildren(host);
    const mounted = mountSettingsPaneIsland(host, {
      pane,
      initialActiveGroupId: "provider-models",
      onSettingsAction: (event: DesktopSettingsActionEvent) => {
        if (event.action === "edit") {
          actions.push(`${event.action}:${event.fieldId}:${String(event.value)}`);
        }
      },
    });
    await nextTick();

    const apiKey = host.querySelector<HTMLInputElement>('[data-desktop-settings-control="apiKey"]');
    expect(host.querySelector("[data-desktop-settings-secret-policy]")?.textContent).toContain("Reveal is disabled");
    host.querySelector<HTMLButtonElement>('[data-desktop-settings-secret-action="replace"]')?.click();
    expect(document.activeElement).toBe(apiKey);
    host.querySelector<HTMLButtonElement>('[data-desktop-settings-secret-action="clear"]')?.click();
    expect(actions).toEqual(["edit:apiKey:"]);

    mounted.unmount();
    host.remove();
  });

  test("renders MCP servers as a structured list with advanced JSON editing", async () => {
    const host = document.createElement("section");
    const mcpState = buildDesktopSettingsFormState({
      agents: { defaults: { model: "gpt-4.1" } },
      tools: {
        mcp_servers: {
          docs: { command: "docs-mcp", args: ["serve"] },
          web: { url: "http://127.0.0.1:3000/mcp" },
        },
      },
    });
    const mcpPane = buildDesktopSettingsPaneModel(mcpState);

    const mounted = mountSettingsPaneIsland(host, {
      pane: mcpPane,
      initialActiveGroupId: "tools-approvals",
    });
    await nextTick();

    expect(host.querySelector('[data-desktop-settings-mcp-server="docs"]')?.textContent).toContain("docs-mcp");
    expect(host.querySelector('[data-desktop-settings-mcp-server="docs"]')?.textContent).toContain("command");
    expect(host.querySelector('[data-desktop-settings-mcp-server="web"]')?.textContent).toContain("http://127.0.0.1:3000/mcp");
    expect(host.querySelector('[data-desktop-settings-field="mcpServers"]')?.closest("details")?.className).toContain("desktop-settings-advanced-fields");
    expect(host.querySelector<HTMLTextAreaElement>('[data-desktop-settings-control="mcpServers"]')?.value).toContain("docs-mcp");

    mounted.unmount();
  });

  test("renders Files and Storage workspace actions", async () => {
    const host = document.createElement("section");
    const actions: string[] = [];
    const mounted = mountSettingsPaneIsland(host, {
      pane,
      initialActiveGroupId: "files-workspace",
      onSettingsAction: (event: DesktopSettingsActionEvent) => {
        actions.push(event.action);
      },
    });
    await nextTick();

    expect(host.querySelector("[data-desktop-settings-workspace-permission]")?.textContent).toContain("Permission");
    host.querySelector<HTMLButtonElement>('[data-desktop-settings-file-action="chooseWorkspace"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-desktop-settings-file-action="openWorkspace"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-desktop-settings-file-action="openSessionFiles"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-desktop-settings-file-action="openKnowledgeDocuments"]')?.click();

    expect(actions).toEqual([
      "chooseWorkspace",
      "openWorkspace",
      "openSessionFiles",
      "openKnowledgeDocuments",
    ]);

    mounted.unmount();
  });

  test("clarifies Channels scope, retry semantics, and setup routes", async () => {
    const host = document.createElement("section");
    const actions: string[] = [];
    const mounted = mountSettingsPaneIsland(host, {
      pane,
      initialActiveGroupId: "channels",
      onSettingsAction: (event: DesktopSettingsActionEvent) => {
        actions.push(event.action);
      },
    });
    await nextTick();

    expect(host.querySelector("[data-desktop-settings-channels-scope]")?.textContent).toContain("Global defaults");
    expect(host.querySelector("[data-desktop-settings-channels-retry]")?.textContent).toContain("Max retries are additional attempts");
    expect(host.querySelector("[data-desktop-settings-channels-empty]")?.textContent).toContain("No integration-specific overrides");
    host.querySelector<HTMLButtonElement>('[data-desktop-settings-channel-action="setupIntegrations"]')?.click();

    expect(actions).toEqual(["setupChannelIntegrations"]);

    mounted.unmount();
  });

  test("renders Runtime intent controls, endpoint transition, port status, and heartbeat dependency", async () => {
    const host = document.createElement("section");
    const savedRuntimeState = buildDesktopSettingsFormState({
      gateway: {
        host: "127.0.0.1",
        port: 18790,
        heartbeat: { enabled: true, interval_s: 1800 },
      },
    }, providerCatalog);
    const pendingRuntimeState = buildDesktopSettingsFormState({
      gateway: {
        host: "0.0.0.0",
        port: 18888,
        heartbeat: { enabled: false, interval_s: 1800 },
      },
    }, providerCatalog);
    const runtimePane = buildDesktopSettingsPaneModel(pendingRuntimeState, {
      lastSavedState: savedRuntimeState,
      saveStatus: "saved",
      saveDetails: {
        transport: "native",
        updatedFields: ["gateway.host", "gateway.port", "gateway.heartbeat.enabled"],
        applied: ["gatewayRuntimeChanged"],
        restartRequired: ["gatewayRestartRequired"],
        reloadRequired: [],
        warnings: [],
      },
    });

    const mounted = mountSettingsPaneIsland(host, {
      pane: runtimePane,
      initialActiveGroupId: "gateway-runtime",
    });
    await nextTick();

    expect(Array.from(
      host.querySelectorAll("[data-desktop-settings-runtime-intent]"),
      (node) => node.textContent,
    )).toEqual(["Local only", "Local network", "Advanced custom"]);
    expect(host.querySelector('[data-desktop-settings-runtime-intent="local-network"]')?.getAttribute("data-active")).toBe("true");
    expect(host.querySelector("[data-desktop-settings-runtime-current-endpoint]")?.textContent).toContain("127.0.0.1:18790");
    expect(host.querySelector("[data-desktop-settings-runtime-pending-endpoint]")?.textContent).toContain("0.0.0.0:18888");
    expect(host.querySelector("[data-desktop-settings-runtime-port-status]")?.textContent).toContain("Port 18888");
    expect(host.querySelector("[data-desktop-settings-runtime-heartbeat-dependency]")?.textContent).toContain("Heartbeat interval is disabled");
    expect(host.querySelector<HTMLInputElement>('[data-desktop-settings-control="heartbeatIntervalS"]')?.disabled).toBe(true);

    mounted.unmount();
  });

  test("turns Diagnostics into an action page with runtime metadata", async () => {
    const host = document.createElement("section");
    const actions: string[] = [];
    const mounted = mountSettingsPaneIsland(host, {
      pane,
      initialActiveGroupId: "logs-diagnostics",
      onSettingsAction: (event: DesktopSettingsActionEvent) => {
        actions.push(event.action);
      },
    });
    await nextTick();

    expect(host.querySelector("[data-desktop-settings-diagnostics-runtime-summary]")?.textContent).toContain("Runtime summary");
    expect(host.querySelector("[data-desktop-settings-diagnostics-gateway-ownership]")?.textContent).toContain("Gateway ownership");
    expect(host.querySelector("[data-desktop-settings-diagnostics-version]")?.textContent).toContain("Version");
    expect(host.querySelector("[data-desktop-settings-diagnostics-config-path]")?.textContent).toContain("Active config path");
    expect(host.querySelector("[data-desktop-settings-diagnostics-config-error]")?.textContent).toContain("Last config error");
    expect(Array.from(
      host.querySelectorAll("[data-desktop-settings-diagnostics-action]"),
      (node) => node.textContent,
    )).toEqual(["Open logs", "Copy runtime summary", "Export redacted diagnostics", "Clear logs", "Reset local UI"]);

    host.querySelector<HTMLButtonElement>('[data-desktop-settings-diagnostics-action="openLogs"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-desktop-settings-diagnostics-action="copyRuntimeSummary"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-desktop-settings-diagnostics-action="exportDiagnosticsBundle"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-desktop-settings-diagnostics-action="clearLogs"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-desktop-settings-diagnostics-action="resetLocalUiState"]')?.click();
    const logLevel = host.querySelector<HTMLSelectElement>("[data-desktop-settings-diagnostics-log-level]");
    expect(logLevel?.value).toBe("info");
    logLevel!.value = "debug";
    logLevel?.dispatchEvent(new Event("change"));

    expect(actions).toEqual([
      "openDiagnosticsLogs",
      "copyDiagnostics",
      "exportDiagnosticsBundle",
      "clearDiagnosticsLogs",
      "resetLocalUiState",
      "setDiagnosticsLogLevel",
    ]);

    mounted.unmount();
  });
});
