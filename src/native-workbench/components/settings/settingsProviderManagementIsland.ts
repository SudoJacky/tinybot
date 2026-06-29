import { createApp, defineComponent, h, ref, type App } from "vue";
import { NButton, NCard, NConfigProvider, NTag } from "naive-ui";
import type { DesktopSettingsPaneModel } from "../../settings/desktopSettingsProviders";
import type { DesktopSettingsActionEvent } from "../../shell/desktopWorkbenchShell";
import { desktopNaiveThemeOverrides } from "../shell/desktopNaiveTheme";

interface ProviderCardModel {
  id: string;
  label: string;
  badge: string;
  initials: string;
  connected: boolean;
  statusLabel: string;
  statusTone: "default" | "error" | "success" | "warning";
  baseUrl: string;
  apiKey: string;
  models: string;
  modelCountLabel: string;
  sourceLabel: string;
}

interface ProviderSetupState {
  open: boolean;
  profileName: string;
  providerType: string;
  credentialSource: string;
  endpoint: string;
  models: string;
  useDefault: boolean;
  setOpen: (value: boolean) => void;
  setProfileName: (value: string) => void;
  setProviderType: (value: string) => void;
  setCredentialSource: (value: string) => void;
  setEndpoint: (value: string) => void;
  setModels: (value: string) => void;
  setUseDefault: (value: boolean) => void;
  reset: () => void;
}

export interface SettingsProviderManagementIslandOptions {
  pane: DesktopSettingsPaneModel;
  onSettingsAction?: (event: DesktopSettingsActionEvent) => void;
  promptProviderId?: () => string | null;
  onFocusSettingsControl?: (fieldId: string) => void;
}

export interface MountedSettingsProviderManagementIsland {
  unmount: () => void;
}

export function mountSettingsProviderManagementIsland(
  host: HTMLElement,
  options: SettingsProviderManagementIslandOptions,
): MountedSettingsProviderManagementIsland {
  host.setAttribute("data-desktop-vue-island", "settings-provider-management");
  host.className = "desktop-settings-provider-section";
  host.setAttribute("aria-label", "Provider management");
  const app = createSettingsProviderManagementApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createSettingsProviderManagementApp(options: SettingsProviderManagementIslandOptions): App {
  return createApp(defineComponent({
    name: "SettingsProviderManagementIsland",
    setup() {
      const searchQuery = ref("");
      const setupOpen = ref(false);
      const setupProfileName = ref("");
      const setupProviderType = ref("openai");
      const setupCredentialSource = ref("env");
      const setupEndpoint = ref("");
      const setupModels = ref("");
      const setupUseDefault = ref(false);
      const setupState = (): ProviderSetupState => ({
        open: setupOpen.value,
        profileName: setupProfileName.value,
        providerType: setupProviderType.value,
        credentialSource: setupCredentialSource.value,
        endpoint: setupEndpoint.value,
        models: setupModels.value,
        useDefault: setupUseDefault.value,
        setOpen: (value) => {
          setupOpen.value = value;
        },
        setProfileName: (value) => {
          setupProfileName.value = value;
        },
        setProviderType: (value) => {
          setupProviderType.value = value;
        },
        setCredentialSource: (value) => {
          setupCredentialSource.value = value;
        },
        setEndpoint: (value) => {
          setupEndpoint.value = value;
        },
        setModels: (value) => {
          setupModels.value = value;
        },
        setUseDefault: (value) => {
          setupUseDefault.value = value;
        },
        reset: () => {
          setupOpen.value = false;
          setupProfileName.value = "";
          setupProviderType.value = "openai";
          setupCredentialSource.value = "env";
          setupEndpoint.value = "";
          setupModels.value = "";
          setupUseDefault.value = false;
        },
      });
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => renderProviderManagement(options, searchQuery.value, (value) => {
          searchQuery.value = value;
        }, setupState()),
      });
    },
  }));
}

function renderProviderManagement(
  options: SettingsProviderManagementIslandOptions,
  searchQuery: string,
  updateSearchQuery: (value: string) => void,
  providerSetup: ProviderSetupState,
) {
  const cards = getProviderCards(options.pane).filter((provider) => !shouldHideProviderCard(provider, searchQuery));
  const selected = getProviderCards(options.pane).find((provider) => provider.id === options.pane.providerEditor.selectedProvider)
    ?? getProviderCards(options.pane)[0];
  return [
    h("header", { class: "desktop-settings-provider-header" }, [
      h("h2", "Providers"),
      h("div", { class: "desktop-settings-provider-tools" }, [
        h("input", {
          class: "desktop-settings-provider-search",
          type: "search",
          value: searchQuery,
          placeholder: "Search providers...",
          "aria-label": "Search providers",
          onInput: (event: Event) => updateSearchQuery(String((event.target as HTMLInputElement | null)?.value ?? "")),
        }),
        h(NButton, {
          class: "desktop-settings-provider-add",
          type: "primary",
          size: "small",
          "data-desktop-settings-action": "addProvider",
          onClick: () => {
            providerSetup.setOpen(true);
          },
        }, { default: () => "+ Add provider" }),
      ]),
    ]),
    providerSetup.open ? renderProviderSetup(options, providerSetup) : null,
    h("div", { class: "desktop-settings-provider-grid" }, cards.map((provider) => renderProviderCard(options, provider))),
    selected ? renderProviderDetailPanel(options, selected) : null,
  ];
}

function renderProviderCard(
  options: SettingsProviderManagementIslandOptions,
  provider: ProviderCardModel,
) {
  return h(NCard, {
    class: "desktop-settings-provider-card",
    "data-desktop-settings-provider-card": provider.id,
    size: "small",
    bordered: false,
  }, {
    default: () => [
      h("header", { class: "desktop-settings-provider-card-header" }, [
        h("div", { class: "desktop-settings-provider-identity" }, [
          h("span", {
            class: "desktop-settings-provider-mark",
            "aria-hidden": "true",
            "data-provider-id": provider.id,
          }, provider.initials),
          h("div", { class: "desktop-settings-provider-title" }, [
            h("h3", provider.label),
            h("div", { class: "desktop-settings-provider-status-row" }, [
              provider.badge ? h(NTag, {
                class: "desktop-settings-provider-badge",
                size: "small",
                round: true,
                type: "success",
              }, { default: () => provider.badge }) : null,
              h(NTag, {
                class: "desktop-settings-provider-status",
                size: "small",
                round: true,
                type: provider.statusTone,
              }, { default: () => provider.statusLabel }),
            ]),
          ]),
        ]),
        h(NButton, {
          size: "small",
          secondary: true,
          "data-desktop-settings-provider-action": "select",
          "aria-label": `Select ${provider.label}`,
          onClick: () => selectProvider(options, provider.id),
        }, { default: () => provider.badge ? "Selected" : "Select" }),
      ]),
      h("div", { class: "desktop-settings-provider-details" }, [
        renderProviderDetail("Endpoint", provider.baseUrl),
        renderProviderDetail("API Key", provider.apiKey),
        renderProviderDetail("Models", provider.modelCountLabel),
        renderProviderDetail("Source", provider.sourceLabel),
      ]),
    ],
  });
}

function renderProviderDetail(label: string, value: string) {
  return h("label", { class: "desktop-settings-provider-detail" }, [
    h("span", `${label}: `),
    h("input", {
      readonly: true,
      tabindex: -1,
      value,
      "aria-label": `${label}: ${value}`,
    }),
    h("span", { class: "desktop-settings-provider-detail-text" }, `${label}: ${value}`),
  ]);
}

function shouldHideProviderCard(provider: ProviderCardModel, query: string): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return false;
  }
  return !`${provider.id} ${provider.label} ${provider.statusLabel} ${provider.baseUrl} ${provider.apiKey} ${provider.models}`.toLowerCase().includes(normalizedQuery);
}

function renderProviderDetailPanel(
  options: SettingsProviderManagementIslandOptions,
  provider: ProviderCardModel,
) {
  return h("aside", {
    class: "desktop-settings-provider-detail-panel",
    "data-desktop-settings-provider-detail": provider.id,
  }, [
    h("header", [
      h("h3", `${provider.label} details`),
      h("p", "Provider actions"),
    ]),
    h("div", { class: "desktop-settings-provider-detail-actions" }, [
      h(NButton, {
        size: "small",
        disabled: !options.pane.providerEditor.canDiscoverModels,
        "data-desktop-settings-provider-command": "discoverModels",
        onClick: () => requestProviderModelDiscovery(options, provider.id),
      }, { default: () => "Discover models" }),
      h(NButton, {
        size: "small",
        "data-desktop-settings-provider-command": "testConnection",
        onClick: () => options.onSettingsAction?.({
          action: "testProviderConnection",
          pane: options.pane,
          providerId: provider.id,
        }),
      }, { default: () => "Test connection" }),
      h(NButton, {
        size: "small",
        "data-desktop-settings-provider-command": "useAsDefault",
        onClick: () => emitEdit(options, "provider", provider.id),
      }, { default: () => "Use as default" }),
      h(NButton, {
        size: "small",
        disabled: true,
        title: "Provider rename is not available yet.",
        "data-desktop-settings-provider-command": "rename",
      }, { default: () => "Rename" }),
      h(NButton, {
        size: "small",
        disabled: true,
        title: "Provider duplication is not available yet.",
        "data-desktop-settings-provider-command": "duplicate",
      }, { default: () => "Duplicate" }),
      h(NButton, {
        size: "small",
        disabled: true,
        title: "Provider deletion is not available yet.",
        "data-desktop-settings-provider-command": "delete",
      }, { default: () => "Delete" }),
    ]),
  ]);
}

function renderProviderSetup(
  options: SettingsProviderManagementIslandOptions,
  providerSetup: ProviderSetupState,
) {
  const providerType = providerSetup.providerType.trim();
  const profileName = providerSetup.profileName.trim() || providerType;
  const duplicate = providerType
    ? options.pane.providerCatalog.some((provider) => provider.id.toLowerCase() === providerType.toLowerCase())
    : false;
  const canCreate = Boolean(providerType) && !duplicate;
  return h("div", {
    class: "desktop-settings-provider-setup",
    "data-desktop-settings-provider-setup": "",
  }, [
    h("h3", "Add provider"),
    h("label", { class: "desktop-settings-inline-field" }, [
      h("span", "Profile name"),
      h("input", {
        "data-desktop-settings-control": "newProviderProfileName",
        value: providerSetup.profileName,
        placeholder: "work-openai",
        onInput: (event: Event) => providerSetup.setProfileName(String((event.target as HTMLInputElement | null)?.value ?? "")),
      }),
    ]),
    h("label", { class: "desktop-settings-inline-field" }, [
      h("span", "Provider type"),
      h("select", {
        "data-desktop-settings-control": "newProviderType",
        value: providerSetup.providerType,
        onChange: (event: Event) => providerSetup.setProviderType(String((event.target as HTMLSelectElement | null)?.value ?? "")),
      }, ["openai", "deepseek", "anthropic", "ollama", "localai"].map((provider) => h("option", { value: provider }, provider))),
    ]),
    h("label", { class: "desktop-settings-inline-field" }, [
      h("span", "Credential source"),
      h("select", {
        "data-desktop-settings-control": "newProviderCredentialSource",
        value: providerSetup.credentialSource,
        onChange: (event: Event) => providerSetup.setCredentialSource(String((event.target as HTMLSelectElement | null)?.value ?? "")),
      }, [
        h("option", { value: "env" }, "Environment variable"),
        h("option", { value: "manual" }, "Saved API key"),
        h("option", { value: "none" }, "No credential"),
      ]),
    ]),
    h("label", { class: "desktop-settings-inline-field" }, [
      h("span", "Endpoint"),
      h("input", {
        "data-desktop-settings-control": "newProviderEndpoint",
        value: providerSetup.endpoint,
        placeholder: "https://api.example.com/v1",
        onInput: (event: Event) => providerSetup.setEndpoint(String((event.target as HTMLInputElement | null)?.value ?? "")),
      }),
    ]),
    h("label", { class: "desktop-settings-inline-field" }, [
      h("span", "Models"),
      h("textarea", {
        "data-desktop-settings-control": "newProviderModels",
        value: providerSetup.models,
        placeholder: "one-model-id-per-line",
        onInput: (event: Event) => providerSetup.setModels(String((event.target as HTMLTextAreaElement | null)?.value ?? "")),
      }),
    ]),
    h("label", { class: "desktop-settings-inline-field" }, [
      h("input", {
        type: "checkbox",
        "data-desktop-settings-control": "newProviderUseDefault",
        checked: providerSetup.useDefault,
        onChange: (event: Event) => providerSetup.setUseDefault((event.target as HTMLInputElement | null)?.checked === true),
      }),
      h("span", "Use as default route"),
    ]),
    duplicate ? h("p", {
      class: "desktop-settings-provider-setup-error",
      "data-desktop-settings-provider-setup-error": "",
      role: "alert",
    }, "Provider already exists.") : null,
    h("div", { class: "desktop-settings-provider-setup-actions" }, [
      h("button", {
        type: "button",
        "data-desktop-settings-provider-setup-action": "create",
        disabled: !canCreate,
        onClick: () => {
          if (!canCreate) {
            return;
          }
          emitEdit(options, "selectedProvider", providerType);
          emitEdit(options, "profileId", profileName);
          emitEdit(options, "apiBase", providerSetup.endpoint.trim());
          emitEdit(options, "models", providerSetup.models.trim());
          if (providerSetup.useDefault) {
            emitEdit(options, "provider", providerType);
          }
          options.onFocusSettingsControl?.("apiBase");
          providerSetup.reset();
        },
      }, "Create provider"),
      h("button", {
        type: "button",
        "data-desktop-settings-provider-setup-action": "cancel",
        onClick: () => providerSetup.reset(),
      }, "Cancel"),
    ]),
  ]);
}

function selectProvider(options: SettingsProviderManagementIslandOptions, providerId: string): void {
  emitEdit(options, "selectedProvider", providerId);
}

function requestProviderModelDiscovery(options: SettingsProviderManagementIslandOptions, providerId: string): void {
  options.onSettingsAction?.({
    action: "discoverModels",
    pane: options.pane,
    providerId,
  });
}

function getProviderCards(pane: DesktopSettingsPaneModel): ProviderCardModel[] {
  const selectedProvider = pane.providerEditor.selectedProvider || "provider";
  const catalog = pane.providerCatalog.length
    ? pane.providerCatalog
    : [{
      id: selectedProvider,
      label: selectedProvider,
      profileId: selectedProvider,
      status: "not_configured",
      enabled: false,
      baseUrl: null,
      apiKey: { value: "", displayValue: "", masked: false, empty: true },
      models: [],
      canDiscoverModels: true,
    }];
  return catalog.map((provider) => {
    const isSelected = provider.id === selectedProvider;
    const providerModels = provider.models ?? (isSelected ? pane.providerEditor.models : []);
    const models = providerModels.join(", ");
    const apiKey = provider.apiKey ?? (isSelected ? pane.providerEditor.apiKey : { displayValue: "" });
    return {
      id: provider.id,
      label: provider.label || provider.id,
      badge: isSelected ? "Current" : "",
      initials: providerInitials(provider.label || provider.id),
      connected: provider.enabled ?? (provider.status === "ready" || provider.status === "available"),
      statusLabel: formatProviderStatus(provider.enabled === false ? "disabled" : provider.status),
      statusTone: providerStatusTone(provider.enabled === false ? "disabled" : provider.status),
      baseUrl: provider.baseUrl || (isSelected ? pane.providerEditor.apiBase : "") || "Not configured",
      apiKey: apiKey.displayValue || "Not configured",
      models: models || "No models",
      modelCountLabel: `${providerModels.length} ${providerModels.length === 1 ? "model" : "models"}`,
      sourceLabel: provider.profileId ? "Configured profile" : "Catalog",
    };
  });
}

function emitEdit(options: SettingsProviderManagementIslandOptions, fieldId: string, value: string | boolean): void {
  options.onSettingsAction?.({
    action: "edit",
    pane: options.pane,
    fieldId,
    value,
  });
}

function providerInitials(label: string): string {
  const words = label.trim().split(/\s+/).filter(Boolean);
  if (!words.length) {
    return "AI";
  }
  if (words.length === 1) {
    return words[0].slice(0, 2).toUpperCase();
  }
  return words.slice(0, 2).map((word) => word[0]).join("").toUpperCase();
}

function formatProviderStatus(status: string): string {
  return {
    ready: "Ready",
    available: "Ready",
    disabled: "Disabled",
    no_models: "No models",
    needs_key: "Needs key",
    unavailable: "Unavailable",
    not_configured: "Not configured",
  }[status] ?? status;
}

function providerStatusTone(status: string): "default" | "error" | "success" | "warning" {
  if (status === "ready" || status === "available") {
    return "success";
  }
  if (status === "needs_key" || status === "not_configured" || status === "no_models") {
    return "warning";
  }
  if (status === "unavailable") {
    return "error";
  }
  return "default";
}
