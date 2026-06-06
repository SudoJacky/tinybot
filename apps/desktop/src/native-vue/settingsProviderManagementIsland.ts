import { createApp, defineComponent, h, ref, type App } from "vue";
import { NButton, NCard, NConfigProvider, NSpace, NTag } from "naive-ui";
import type { DesktopSettingsPaneModel } from "../desktopSettingsProviders";
import type { DesktopSettingsActionEvent } from "../desktopWorkbenchShell";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

interface ProviderCardModel {
  id: string;
  label: string;
  badge: string;
  statusLabel: string;
  statusTone: "default" | "error" | "success" | "warning";
  baseUrl: string;
  apiKey: string;
  models: string;
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
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => renderProviderManagement(options, searchQuery.value, (value) => {
          searchQuery.value = value;
        }),
      });
    },
  }));
}

function renderProviderManagement(
  options: SettingsProviderManagementIslandOptions,
  searchQuery: string,
  updateSearchQuery: (value: string) => void,
) {
  const cards = getProviderCards(options.pane);
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
          class: "desktop-settings-provider-icon-button",
          type: "default",
          size: "small",
          disabled: !options.pane.providerEditor.canDiscoverModels,
          "data-desktop-settings-action": "discoverModels",
          "aria-label": "Refresh provider models",
          onClick: () => options.onSettingsAction?.({ action: "discoverModels", pane: options.pane }),
        }, { default: () => "Refresh models" }),
        h(NButton, {
          class: "desktop-settings-provider-add",
          type: "primary",
          size: "small",
          "data-desktop-settings-action": "addProvider",
          onClick: () => {
            const providerId = options.promptProviderId?.()?.trim() ?? "";
            if (providerId) {
              selectProvider(options, providerId);
              options.onFocusSettingsControl?.("selectedProvider");
            }
          },
        }, { default: () => "+ Add provider" }),
      ]),
    ]),
    h("div", { class: "desktop-settings-provider-grid" }, cards.map((provider) => renderProviderCard(
      options,
      provider,
      shouldHideProviderCard(provider, searchQuery),
    ))),
  ];
}

function renderProviderCard(
  options: SettingsProviderManagementIslandOptions,
  provider: ProviderCardModel,
  hidden: boolean,
) {
  return h(NCard, {
    class: "desktop-settings-provider-card",
    "data-desktop-settings-provider-card": provider.id,
    hidden,
    size: "small",
    bordered: false,
  }, {
    default: () => [
      h("header", { class: "desktop-settings-provider-card-header" }, [
        h("div", { class: "desktop-settings-provider-title" }, [
          h("h3", provider.label),
          provider.badge ? h(NTag, {
            class: "desktop-settings-provider-badge",
            size: "small",
            round: true,
            type: "success",
          }, { default: () => provider.badge }) : null,
        ]),
        h(NTag, {
          class: "desktop-settings-provider-status",
          size: "small",
          round: true,
          type: provider.statusTone,
        }, { default: () => provider.statusLabel }),
      ]),
      h("div", { class: "desktop-settings-provider-details" }, [
        renderProviderDetail("Base URL", provider.baseUrl),
        renderProviderDetail("API Key", provider.apiKey),
        renderProviderDetail("Model", provider.models),
      ]),
      h(NSpace, { class: "desktop-settings-provider-card-actions", size: 8 }, {
        default: () => [
          h(NButton, {
            size: "small",
            "data-desktop-settings-provider-action": "models",
            onClick: () => handleProviderCardAction(options, provider.id, "model"),
          }, { default: () => "Models" }),
          h(NButton, {
            size: "small",
            "data-desktop-settings-provider-action": "settings",
            onClick: () => handleProviderCardAction(options, provider.id, "settings"),
          }, { default: () => "Settings" }),
        ],
      }),
    ],
  });
}

function renderProviderDetail(label: string, value: string) {
  return h("p", { class: "desktop-settings-provider-detail" }, [
    h("span", `${label}: `),
    h("strong", value),
  ]);
}

function shouldHideProviderCard(provider: ProviderCardModel, query: string): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return false;
  }
  return !`${provider.id} ${provider.label} ${provider.statusLabel} ${provider.baseUrl} ${provider.apiKey} ${provider.models}`.toLowerCase().includes(normalizedQuery);
}

function handleProviderCardAction(
  options: SettingsProviderManagementIslandOptions,
  providerId: string,
  target: "model" | "settings",
): void {
  if (providerId !== options.pane.providerEditor.selectedProvider) {
    selectProvider(options, providerId);
    options.onFocusSettingsControl?.("selectedProvider");
    return;
  }
  options.onFocusSettingsControl?.(target === "model" ? "model" : "apiBase");
}

function selectProvider(options: SettingsProviderManagementIslandOptions, providerId: string): void {
  options.onSettingsAction?.({
    action: "edit",
    pane: options.pane,
    fieldId: "selectedProvider",
    value: providerId,
  });
}

function getProviderCards(pane: DesktopSettingsPaneModel): ProviderCardModel[] {
  const selectedProvider = pane.providerEditor.selectedProvider || "provider";
  const catalog = pane.providerCatalog.length
    ? pane.providerCatalog
    : [{ id: selectedProvider, label: selectedProvider, status: "not_configured" }];
  return catalog.map((provider) => {
    const isSelected = provider.id === selectedProvider;
    const models = isSelected ? pane.providerEditor.models.join(", ") : "";
    return {
      id: provider.id,
      label: provider.label || provider.id,
      badge: isSelected ? "Current" : "",
      statusLabel: formatProviderStatus(provider.status),
      statusTone: providerStatusTone(provider.status),
      baseUrl: isSelected ? pane.providerEditor.apiBase || "Not configured" : "Not configured",
      apiKey: isSelected ? pane.providerEditor.apiKey.displayValue || "Not configured" : "Not configured",
      models: models || "No models",
    };
  });
}

function formatProviderStatus(status: string): string {
  return {
    ready: "Ready",
    needs_key: "Needs key",
    unavailable: "Unavailable",
    not_configured: "Not configured",
  }[status] ?? status;
}

function providerStatusTone(status: string): "default" | "error" | "success" | "warning" {
  if (status === "ready") {
    return "success";
  }
  if (status === "needs_key" || status === "not_configured") {
    return "warning";
  }
  if (status === "unavailable") {
    return "error";
  }
  return "default";
}
