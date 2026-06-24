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
  test("renders the provided initial settings section", async () => {
    const host = document.createElement("section");

    const mounted = mountSettingsPaneIsland(host, {
      pane,
      initialActiveGroupId: "provider-models",
    });
    await nextTick();

    expect(host.querySelector(".desktop-settings-breadcrumb")?.textContent).toContain("Settings / Provider & Models");
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
    expect(host.querySelector(".desktop-settings-breadcrumb")?.textContent).toContain("Settings / General");
    expect(host.querySelector(".desktop-settings-capability-map")).toBeNull();
    expect(host.querySelector(".desktop-settings-default-llm-card")?.textContent).toContain("Default LLM");
    expect(host.querySelector(".desktop-settings-provider-section")).toBeNull();
    expect(host.querySelector(".desktop-settings-status-card")).toBeNull();
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
    )).toEqual(["general"]);
    expect(host.querySelector('[data-desktop-settings-group="knowledge"]')).toBeNull();
    expect(host.querySelector('[data-desktop-settings-field="timezone"] .desktop-settings-field-meta')?.textContent).toContain("Required");
    expect(host.querySelector('[data-desktop-settings-field="timezone"] .desktop-settings-field-meta')?.textContent).toContain("Free text");
    expect(host.querySelector('[data-desktop-settings-group="general"] details.desktop-settings-advanced-fields summary')?.textContent).toContain("Advanced");
    expect(host.querySelector('[data-desktop-settings-field="temperature"]')?.closest("details")?.className).toContain("desktop-settings-advanced-fields");

    const navProvider = host.querySelector<HTMLAnchorElement>('[data-desktop-settings-nav="provider-models"]');
    navProvider?.click();
    await nextTick();
    expect(host.querySelector(".desktop-settings-breadcrumb")?.textContent).toContain("Settings / Provider & Models");
    expect(host.querySelector(".desktop-settings-default-llm-card")).toBeNull();
    expect(host.querySelector(".desktop-settings-provider-section")?.textContent).toContain("Providers");
    expect(host.querySelector('[data-desktop-settings-provider-card="openai"]')?.textContent).toContain("OpenAI");
    expect(host.querySelector('[data-desktop-settings-field="apiKey"] input')?.getAttribute("type")).toBe("password");
    expect(host.querySelector<HTMLInputElement>('[data-desktop-settings-control="apiKey"]')?.value).toBe("********");
    const providerSave = host.querySelector<HTMLButtonElement>('[data-desktop-settings-action="save"]');
    expect(providerSave).not.toBeNull();
    providerSave?.click();

    const navFiles = host.querySelector<HTMLAnchorElement>('[data-desktop-settings-nav="files-workspace"]');
    navFiles?.click();
    await nextTick();
    expect(host.querySelector(".desktop-settings-breadcrumb")?.textContent).toContain("Settings / Files & Workspace");
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

    host.querySelector<HTMLAnchorElement>('[data-desktop-settings-nav="general"]')?.click();
    await nextTick();
    const model = host.querySelector<HTMLSelectElement>('[data-desktop-settings-control="model"]');
    model!.value = "gpt-4.1-mini";
    model?.dispatchEvent(new Event("change", { bubbles: true }));
    host.querySelector<HTMLButtonElement>('[data-desktop-settings-action="save"]')?.click();

    host.querySelector<HTMLAnchorElement>('[data-desktop-settings-nav="provider-models"]')?.click();
    await nextTick();
    host.querySelector<HTMLButtonElement>('[data-desktop-settings-action="discoverModels"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-desktop-settings-provider-action="settings"]')?.click();
    const apiKey = host.querySelector<HTMLInputElement>('[data-desktop-settings-control="apiKey"]');
    apiKey!.value = "sk-replacement";
    apiKey?.dispatchEvent(new Event("input", { bubbles: true }));

    expect(actions).toEqual([
      "save",
      "edit:model:gpt-4.1-mini",
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

    expect(host.querySelector(".desktop-settings-default-llm-card")?.textContent).toContain("Model-owned provider label");
    expect(host.querySelector(".desktop-settings-default-llm-card")?.textContent).toContain("Model-owned default model label");
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
    expect(host.querySelector(".desktop-settings-breadcrumb")?.textContent).toContain("Settings / Files & Workspace");
    expect(document.activeElement).toBe(workspace);
    expect(host.querySelector('[data-desktop-settings-field="workspace"]')?.getAttribute("data-highlighted")).toBe("true");

    search!.value = "temperature";
    search?.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    host.querySelector<HTMLButtonElement>('[data-desktop-settings-search-result="general.temperature"]')?.click();
    await nextTick();
    expect(host.querySelector('[data-desktop-settings-group="general"] details.desktop-settings-advanced-fields')?.hasAttribute("open")).toBe(true);
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
});
