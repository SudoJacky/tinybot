import { createApp, defineComponent, h, ref, type App, type Ref } from "vue";
import { NButton, NCard, NConfigProvider, NSpace, NTag } from "naive-ui";
import type {
  DesktopSettingsPaneField,
  DesktopSettingsPaneGroup,
  DesktopSettingsPaneModel,
} from "../desktopSettingsProviders";
import type { DesktopSettingsActionEvent } from "../desktopWorkbenchShell";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export interface SettingsPaneIslandOptions {
  pane: DesktopSettingsPaneModel;
  initialActiveGroupId?: DesktopSettingsPaneGroup["id"];
  onSettingsAction?: (event: DesktopSettingsActionEvent) => void;
  promptProviderId?: () => string | null;
  onFocusSettingsControl?: (fieldId: string) => void;
}

export interface MountedSettingsPaneIsland {
  update: (options: SettingsPaneIslandOptions) => void;
  unmount: () => void;
}

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
}

const mountedSettingsPanes = new WeakMap<HTMLElement, MountedSettingsPaneIsland>();

export function mountOrUpdateSettingsPaneIsland(
  host: HTMLElement,
  options: SettingsPaneIslandOptions,
): MountedSettingsPaneIsland {
  const mounted = mountedSettingsPanes.get(host);
  if (mounted) {
    mounted.update(options);
    return mounted;
  }
  return mountSettingsPaneIsland(host, options);
}

export function mountSettingsPaneIsland(
  host: HTMLElement,
  options: SettingsPaneIslandOptions,
): MountedSettingsPaneIsland {
  const mounted = mountedSettingsPanes.get(host);
  if (mounted) {
    mounted.update(options);
    return mounted;
  }
  applySettingsPaneHost(host);
  const state = ref(options) as Ref<SettingsPaneIslandOptions>;
  const app = createSettingsPaneApp(state);
  app.mount(host);
  const nextMounted = {
    update: (nextOptions: SettingsPaneIslandOptions) => {
      applySettingsPaneHost(host);
      state.value = nextOptions;
    },
    unmount: () => {
      mountedSettingsPanes.delete(host);
      app.unmount();
      host.replaceChildren();
    },
  };
  mountedSettingsPanes.set(host, nextMounted);
  return nextMounted;
}

function applySettingsPaneHost(host: HTMLElement): void {
  host.setAttribute("data-desktop-vue-island", "settings-pane");
  host.className = "desktop-workbench-section desktop-settings-pane";
  host.setAttribute("data-desktop-module-surface", "settings");
  host.setAttribute("data-settings-layout", "section-pages");
  host.setAttribute("aria-label", "Settings and providers");
}

function createSettingsPaneApp(state: Ref<SettingsPaneIslandOptions>): App {
  return createApp(defineComponent({
    name: "SettingsPaneIsland",
    setup() {
      const providerSearch = ref("");
      const activeGroupId = ref(getActiveSettingsGroup(state.value.pane, state.value.initialActiveGroupId)?.id ?? "general");
      const setActiveGroupId = (groupId: DesktopSettingsPaneGroup["id"]) => {
        activeGroupId.value = groupId;
      };
      const currentActiveGroupId = (options: SettingsPaneIslandOptions) => {
        const activeGroup = getActiveSettingsGroup(options.pane, activeGroupId.value);
        if (activeGroup) {
          activeGroupId.value = activeGroup.id;
          return activeGroup.id;
        }
        activeGroupId.value = "general";
        return activeGroupId.value;
      };
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => {
          const options = state.value;
          const selectedGroupId = currentActiveGroupId(options);
          return [
            renderSidebar(options.pane, selectedGroupId, setActiveGroupId),
            h("div", { class: "desktop-settings-content" }, [
              renderHeader(options, selectedGroupId),
              renderSaveAlert(options),
              renderActiveSettingsSection(options, selectedGroupId, providerSearch.value, (value) => {
                providerSearch.value = value;
              }),
            ]),
          ];
        },
      });
    },
  }));
}

function renderHeader(
  options: SettingsPaneIslandOptions,
  activeGroupId: DesktopSettingsPaneGroup["id"],
) {
  const pane = options.pane;
  const activeGroup = getActiveSettingsGroup(pane, activeGroupId);
  return h("header", { class: "desktop-settings-header" }, [
    h("div", { class: "desktop-settings-breadcrumb" }, [
      h("h2", `Settings / ${activeGroup?.label ?? "General"}`),
      activeGroup ? h("p", { class: "desktop-settings-header-description" }, getSettingsGroupDescription(activeGroup.id)) : null,
    ]),
    h("div", { class: "desktop-settings-save-region" }, [
      renderSaveStatus(options),
      renderSaveButton(options),
    ]),
  ]);
}

function renderSaveStatus(options: SettingsPaneIslandOptions) {
  const pane = options.pane;
  const saveDetails = renderSaveDetails(options);
  return h("div", {
    class: "desktop-settings-save-status",
    "data-desktop-settings-status": "save",
    "aria-live": "polite",
  }, [
    h("p", pane.save.message),
    saveDetails,
  ]);
}

function renderSaveDetails(options: SettingsPaneIslandOptions) {
  const pane = options.pane;
  const details: Array<{
    text: string;
    action?: "restartGateway" | "reloadWorkspace";
    label?: string;
  }> = [];
  if (pane.save.restartRequired?.length) {
    details.push({
      text: "Gateway restart required",
      action: "restartGateway",
      label: "Restart gateway now",
    });
  }
  if (pane.save.reloadRequired?.length) {
    details.push({
      text: "Workspace reload required",
      action: "reloadWorkspace",
      label: "Reload workspace",
    });
  }
  if (pane.save.transport === "gateway-fallback") {
    details.push({ text: "Saved through gateway fallback" });
  }
  details.push(...(pane.save.warnings ?? []).map((warning) => ({ text: warning })));
  if (details.length === 0) {
    return null;
  }
  return h("ul", {
    class: "desktop-settings-save-details",
    "data-desktop-settings-save-details": "",
  }, details.map((detail) => {
    const action = detail.action;
    return h("li", {
      "data-desktop-settings-save-detail": "",
    }, [
      h("span", detail.text),
      action ? h("button", {
        type: "button",
        "data-desktop-settings-action": action,
        onClick: () => options.onSettingsAction?.({ action, pane }),
      }, detail.label) : null,
    ]);
  }));
}

function renderSaveAlert(options: SettingsPaneIslandOptions) {
  const pane = options.pane;
  if (pane.save.status !== "failed") {
    return null;
  }
  return h("div", {
    class: "desktop-settings-error-banner",
    role: "alert",
    "data-desktop-settings-alert": "save",
  }, [
    h("strong", "Settings need attention"),
    h("p", pane.save.message),
    h("div", { class: "desktop-settings-error-actions" }, [
      h("button", {
        type: "button",
        "data-desktop-settings-action": "retryLoad",
        onClick: () => options.onSettingsAction?.({ action: "retryLoad", pane }),
      }, "Retry"),
      h("button", {
        type: "button",
        "data-desktop-settings-action": "copyDiagnostics",
        onClick: () => options.onSettingsAction?.({ action: "copyDiagnostics", pane }),
      }, "Copy diagnostics"),
    ]),
  ]);
}

function renderSidebar(
  pane: DesktopSettingsPaneModel,
  activeGroupId: DesktopSettingsPaneGroup["id"],
  setActiveGroupId: (groupId: DesktopSettingsPaneGroup["id"]) => void,
) {
  return h("aside", {
    class: "desktop-settings-sidebar",
    "aria-label": "Settings navigation",
  }, [
    h("input", {
      class: "desktop-settings-search",
      type: "search",
      placeholder: "Search settings...",
      "aria-label": "Search settings",
    }),
    h("nav", {
      class: "desktop-settings-nav",
      "aria-label": "Settings sections",
    }, renderNavigation(pane.groups, activeGroupId, setActiveGroupId)),
  ]);
}

function renderNavigation(
  groups: DesktopSettingsPaneGroup[],
  activeGroupId: DesktopSettingsPaneGroup["id"],
  setActiveGroupId: (groupId: DesktopSettingsPaneGroup["id"]) => void,
) {
  const nodes = [
    h("p", { class: "desktop-settings-nav-heading" }, "Personal"),
  ];
  groups.forEach((group, index) => {
    if (index === 3) {
      nodes.push(h("p", { class: "desktop-settings-nav-heading" }, "System"));
    }
    nodes.push(h("a", {
      class: "desktop-settings-nav-item",
      href: "#",
      "data-desktop-settings-nav": group.id,
      "data-active": group.id === activeGroupId ? "true" : undefined,
      "aria-current": group.id === activeGroupId ? "page" : undefined,
      onClick: (event: Event) => selectSettingsGroup(event, group.id, setActiveGroupId),
    }, getSettingsNavLabel(group.id)));
  });
  return nodes;
}

function renderActiveSettingsSection(
  options: SettingsPaneIslandOptions,
  activeGroupId: DesktopSettingsPaneGroup["id"],
  providerSearch: string,
  setProviderSearch: (value: string) => void,
) {
  const group = getActiveSettingsGroup(options.pane, activeGroupId);
  const groupNode = group ? renderSettingsGroup(options, group) : null;
  if (activeGroupId === "general") {
    return [
      renderDefaultLlmCard(options),
      groupNode ? renderSingleSettingsGroup(groupNode) : null,
    ];
  }
  if (activeGroupId === "provider-models") {
    return [
      renderProviderManagement(options, providerSearch, setProviderSearch),
      groupNode ? renderSingleSettingsGroup(groupNode) : null,
    ];
  }
  return groupNode ? renderSingleSettingsGroup(groupNode) : null;
}

function renderDefaultLlmCard(options: SettingsPaneIslandOptions) {
  const provider = findPaneField(options.pane, "general", "provider");
  const model = findPaneField(options.pane, "general", "model");
  return h("section", {
    class: "desktop-settings-default-llm-card",
    "aria-label": "Default LLM settings",
  }, [
    h(NCard, { size: "small", bordered: false }, {
      default: () => [
        h("div", { class: "desktop-settings-card-heading" }, [
          h("h2", "Default LLM"),
        ]),
        h("div", { class: "desktop-settings-default-llm-form" }, [
          provider ? renderInlineField(options, provider, "Provider") : null,
          model ? renderInlineField(options, model, "Model") : null,
        ]),
        h("p", { class: "desktop-settings-default-llm-copy" }, "Configure the global default LLM model. Individual agents can still choose a different model."),
      ],
    }),
  ]);
}

function renderProviderManagement(
  options: SettingsPaneIslandOptions,
  searchQuery: string,
  updateSearchQuery: (value: string) => void,
) {
  const cards = getProviderCards(options.pane).filter((provider) => !shouldHideProviderCard(provider, searchQuery));
  return h("section", {
    class: "desktop-settings-provider-section",
    "aria-label": "Provider management",
  }, [
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
              emitEdit(options, "selectedProvider", providerId);
              options.onFocusSettingsControl?.("selectedProvider");
            }
          },
        }, { default: () => "+ Add provider" }),
      ]),
    ]),
    h("div", { class: "desktop-settings-provider-grid" }, cards.map((provider) => renderProviderCard(options, provider))),
  ]);
}

function renderProviderCard(
  options: SettingsPaneIslandOptions,
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
        h("button", {
          class: "desktop-settings-provider-switch",
          type: "button",
          role: "switch",
          "aria-checked": provider.connected ? "true" : "false",
          "aria-label": `${provider.connected ? "Disable" : "Enable"} ${provider.label}`,
          "data-desktop-settings-provider-action": "toggle",
          "data-state": provider.connected ? "on" : "off",
          onClick: () => toggleProvider(options, provider),
        }),
      ]),
      h("div", { class: "desktop-settings-provider-details" }, [
        renderProviderDetail("Base URL", provider.baseUrl),
        renderProviderDetail("API Key", provider.apiKey),
        renderProviderDetail("Model", provider.models),
      ]),
      h("button", {
        class: "desktop-settings-provider-advanced",
        type: "button",
        "data-desktop-settings-provider-action": "settings",
        onClick: () => handleProviderCardAction(options, provider.id, "settings"),
      }, [
        h("span", "Advanced settings"),
        h("span", { "aria-hidden": "true" }, "v"),
      ]),
      h(NSpace, { class: "desktop-settings-provider-card-actions", size: 8 }, {
        default: () => [
          h(NButton, {
            size: "small",
            "data-desktop-settings-provider-action": "models",
            onClick: () => handleProviderCardAction(options, provider.id, "models"),
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

function renderSingleSettingsGroup(groupNode: ReturnType<typeof renderSettingsGroup>) {
  return h("div", { class: "desktop-settings-grid" }, [groupNode]);
}

function renderSettingsGroup(options: SettingsPaneIslandOptions, group: DesktopSettingsPaneGroup) {
  const fields = getSettingsGroupDisplayFields(group);
  if (!fields.length) {
    return null;
  }
  const primaryFields = fields.filter((field) => !field.advanced);
  const advancedFields = fields.filter((field) => field.advanced);
  return h(NCard, {
    class: "desktop-settings-group",
    id: `desktop-settings-group-${group.id}`,
    "data-desktop-settings-group": group.id,
    size: "small",
    bordered: false,
  }, {
    default: () => [
      h("h2", group.label),
      h("p", { class: "desktop-settings-group-description" }, getSettingsGroupDescription(group.id)),
      ...primaryFields.map((field) => renderSettingsField(options, group, field)),
      advancedFields.length ? h("details", { class: "desktop-settings-advanced-fields" }, [
        h("summary", "Advanced"),
        ...advancedFields.map((field) => renderSettingsField(options, group, field)),
      ]) : null,
    ],
  });
}

function renderSettingsField(
  options: SettingsPaneIslandOptions,
  group: DesktopSettingsPaneGroup,
  field: DesktopSettingsPaneField,
) {
  return h("div", {
    class: "desktop-settings-field",
    "data-desktop-settings-field": field.id,
    "data-state": field.state,
  }, [
    h("div", { class: "desktop-settings-field-copy" }, [
      h("label", { for: `desktop-settings-${field.id}` }, `${field.label}: `),
      h("span", { class: "desktop-settings-field-description" }, getSettingsFieldDescription(group.id, field.id, field.value)),
      renderSettingsFieldMeta(field),
    ]),
    renderSettingsControl(options, field),
    renderSettingsFieldError(options.pane, field),
  ]);
}

function renderInlineField(
  options: SettingsPaneIslandOptions,
  field: DesktopSettingsPaneField,
  label: string,
) {
  return h("label", { class: "desktop-settings-inline-field" }, [
    h("span", label),
    field.id === "model" && getDefaultLlmModelOptions(options.pane).length > 0
      ? renderModelSelect(options, field)
      : renderSettingsControl(options, field),
  ]);
}

function renderModelSelect(options: SettingsPaneIslandOptions, field: DesktopSettingsPaneField) {
  const optionValues = field.options?.map((option) => option.value) ?? getDefaultLlmModelOptions(options.pane);
  const values = Array.from(new Set([field.inputValue, ...optionValues].filter(Boolean)));
  if (!values.length) {
    values.push("");
  }
  return h("select", {
    id: `desktop-settings-${field.id}`,
    "data-desktop-settings-control": field.id,
    "data-state": field.state,
    "aria-invalid": field.state === "invalid" ? "true" : undefined,
    "aria-describedby": getSettingsFieldErrorId(options.pane, field),
    value: field.inputValue,
    onChange: (event: Event) => emitEdit(options, field.id, String((event.target as HTMLSelectElement | null)?.value ?? "")),
  }, values.map((value) => h("option", {
    value,
    selected: value === field.inputValue ? "true" : undefined,
  }, value || "No model selected")));
}

function renderSettingsControl(options: SettingsPaneIslandOptions, field: DesktopSettingsPaneField) {
  if (field.control === "readonly") {
    return h("output", {
      id: `desktop-settings-${field.id}`,
      class: "desktop-settings-readonly-value",
    }, field.value || "Not configured");
  }
  const commonAttrs = {
    id: `desktop-settings-${field.id}`,
    "data-desktop-settings-control": field.id,
    "data-state": field.state,
    "aria-invalid": field.state === "invalid" ? "true" : undefined,
    "aria-describedby": getSettingsFieldErrorId(options.pane, field),
    placeholder: field.placeholder,
    min: field.min,
    max: field.max,
    step: field.step,
  };
  if (field.control === "checkbox") {
    return h("input", {
      ...commonAttrs,
      type: "checkbox",
      checked: Boolean(field.checked),
      onChange: (event: Event) => emitEdit(options, field.id, Boolean((event.target as HTMLInputElement | null)?.checked)),
    });
  }
  if (field.control === "select") {
    const values = field.options?.length ? field.options : [{ value: field.inputValue, label: field.inputValue }];
    return h("select", {
      ...commonAttrs,
      value: field.inputValue,
      onChange: (event: Event) => emitEdit(options, field.id, String((event.target as HTMLSelectElement | null)?.value ?? "")),
    }, values.map((option) => h("option", {
      value: option.value,
      selected: option.value === field.inputValue ? "true" : undefined,
    }, option.label)));
  }
  if (field.control === "textarea") {
    return h("textarea", {
      ...commonAttrs,
      value: field.inputValue,
      onInput: (event: Event) => emitEdit(options, field.id, String((event.target as HTMLTextAreaElement | null)?.value ?? "")),
    });
  }
  return h("input", {
    ...commonAttrs,
    type: field.control === "number" ? "number" : field.control === "password" ? "password" : "text",
    value: field.inputValue,
    onInput: (event: Event) => emitEdit(options, field.id, String((event.target as HTMLInputElement | null)?.value ?? "")),
  });
}

function renderSettingsFieldError(pane: DesktopSettingsPaneModel, field: DesktopSettingsPaneField) {
  const message = getSettingsFieldErrorMessage(pane, field);
  if (!message) {
    return null;
  }
  return h("p", {
    id: `desktop-settings-${field.id}-error`,
    class: "desktop-settings-field-error",
    "data-desktop-settings-error": field.id,
  }, message);
}

function getSettingsFieldErrorId(pane: DesktopSettingsPaneModel, field: DesktopSettingsPaneField): string | undefined {
  return getSettingsFieldErrorMessage(pane, field) ? `desktop-settings-${field.id}-error` : undefined;
}

function getSettingsFieldErrorMessage(pane: DesktopSettingsPaneModel, field: DesktopSettingsPaneField): string {
  const validationField = settingsValidationFieldForControl(field.id);
  const error = pane.validationErrors.find((validationError) => validationError.field === validationField);
  if (!error) {
    return "";
  }
  return {
    modelEmpty: "Model is required.",
    timezoneError: "Invalid timezone.",
    portRange: "Port must be between 1 and 65535.",
    jsonObjectError: "Must be a JSON object.",
    urlError: "Must be a valid URL.",
  }[error.errorKey] ?? "Invalid setting.";
}

function settingsValidationFieldForControl(fieldId: string): string {
  return {
    port: "gatewayPort",
    apiBase: "providerApiBase",
  }[fieldId] ?? fieldId;
}

function renderSettingsFieldMeta(field: DesktopSettingsPaneField) {
  return h("span", { class: "desktop-settings-field-meta" }, [
    h("span", { class: "desktop-settings-field-chip", "data-kind": field.requirement }, requirementLabel(field.requirement)),
    h("span", { class: "desktop-settings-field-chip", "data-kind": field.configurationMode }, configurationModeLabel(field.configurationMode)),
  ]);
}

function renderSaveButton(options: SettingsPaneIslandOptions) {
  return h("button", {
    class: "desktop-settings-save-status-button",
    type: "button",
    "data-desktop-settings-action": "save",
    disabled: !options.pane.save.canSave,
    onClick: () => options.onSettingsAction?.({ action: "save", pane: options.pane }),
  }, saveLabel(options.pane));
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

function getDefaultLlmModelOptions(pane: DesktopSettingsPaneModel): string[] {
  const defaultProvider = findPaneField(pane, "general", "provider")?.inputValue;
  if (!defaultProvider || defaultProvider === "auto") {
    return pane.providerEditor.models;
  }
  return pane.providerCatalog.find((provider) => provider.id === defaultProvider)?.models ?? [];
}

function handleProviderCardAction(
  options: SettingsPaneIslandOptions,
  providerId: string,
  target: "models" | "settings",
): void {
  if (providerId !== options.pane.providerEditor.selectedProvider) {
    emitEdit(options, "selectedProvider", providerId);
    options.onFocusSettingsControl?.(target === "models" ? "models" : "apiBase");
    return;
  }
  options.onFocusSettingsControl?.(target === "models" ? "models" : "apiBase");
}

function emitEdit(options: SettingsPaneIslandOptions, fieldId: string, value: string | boolean): void {
  options.onSettingsAction?.({
    action: "edit",
    pane: options.pane,
    fieldId,
    value,
  });
}

function findPaneField(
  pane: DesktopSettingsPaneModel,
  groupId: DesktopSettingsPaneGroup["id"],
  fieldId: string,
): DesktopSettingsPaneField | null {
  return pane.groups.find((group) => group.id === groupId)?.fields.find((field) => field.id === fieldId) ?? null;
}

function getSettingsGroupDisplayFields(group: DesktopSettingsPaneGroup): DesktopSettingsPaneField[] {
  if (group.id === "general") {
    return group.fields.filter((field) => !["model", "provider"].includes(field.id));
  }
  if (group.id === "provider-models") {
    return group.fields.filter((field) => !["selectedProvider"].includes(field.id));
  }
  return group.fields;
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
    };
  });
}

function toggleProvider(options: SettingsPaneIslandOptions, provider: ProviderCardModel): void {
  emitEdit(options, `providerEnabled:${provider.id}`, !provider.connected);
}

function selectSettingsGroup(
  event: Event,
  groupId: DesktopSettingsPaneGroup["id"],
  setActiveGroupId?: (groupId: DesktopSettingsPaneGroup["id"]) => void,
): void {
  event.preventDefault();
  setActiveGroupId?.(groupId);
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

function shouldHideProviderCard(provider: ProviderCardModel, query: string): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return false;
  }
  return !`${provider.id} ${provider.label} ${provider.statusLabel} ${provider.baseUrl} ${provider.apiKey} ${provider.models}`.toLowerCase().includes(normalizedQuery);
}

function getActiveSettingsGroup(
  pane: DesktopSettingsPaneModel,
  activeGroupId?: DesktopSettingsPaneGroup["id"] | null,
): DesktopSettingsPaneGroup | null {
  return pane.groups.find((group) => group.id === activeGroupId) ?? pane.groups[0] ?? null;
}

function saveLabel(pane: DesktopSettingsPaneModel): string {
  if (pane.save.status === "saving") {
    return "Saving...";
  }
  if (pane.save.status === "failed") {
    return "Save failed";
  }
  if (pane.save.status === "saved" || !pane.dirty) {
    return "Saved";
  }
  return "Save settings";
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

function getSettingsNavLabel(groupId: DesktopSettingsPaneGroup["id"]): string {
  return {
    general: "General",
    "provider-models": "Provider & Models",
    knowledge: "Knowledge",
    "tools-approvals": "Tools & Approvals",
    "files-workspace": "Files & Workspace",
    "memory-experience": "Memory & Experience",
    skills: "Skills",
    channels: "Channels",
    automations: "Automations",
    "gateway-runtime": "Gateway & Runtime",
    "logs-diagnostics": "Logs & Diagnostics",
  }[groupId];
}

function getSettingsGroupDescription(groupId: DesktopSettingsPaneGroup["id"]): string {
  return {
    general: "Default model, profile, and timezone used by the desktop workbench.",
    "provider-models": "Provider profile, endpoint, and model catalog for chat and agent runs.",
    knowledge: "Retrieval behavior for workspace knowledge and RAG context.",
    "tools-approvals": "Browser, command execution, approval policy, and MCP server access.",
    "files-workspace": "Session files, Knowledge documents, and editable workspace file boundaries.",
    "memory-experience": "Memory and experience controls for contextual continuity.",
    skills: "Skill availability and loading policy.",
    channels: "Streaming and retry behavior for desktop channels.",
    automations: "Automation and scheduling capabilities planned after core stability.",
    "gateway-runtime": "Local gateway connection, heartbeat, and runtime controls.",
    "logs-diagnostics": "Runtime logs, diagnostics export, and local state recovery.",
  }[groupId];
}

function getSettingsFieldDescription(
  groupId: DesktopSettingsPaneGroup["id"],
  fieldId: string,
  value: string,
): string {
  const descriptions: Record<string, string> = {
    "general.model": "Model used for default chat and agent responses.",
    "general.provider": "Provider routing for the selected model.",
    "general.activeProfile": "Named provider profile with credentials and endpoint settings.",
    "general.timezone": "Timezone used for timestamps, reminders, and scheduled work.",
    "provider-models.selectedProvider": "Provider catalog entry edited by this profile.",
    "provider-models.profileId": "Stable profile name saved in desktop configuration.",
    "provider-models.apiBase": "OpenAI-compatible endpoint for this provider.",
    "provider-models.models": "One model id per line; refresh can discover supported models.",
    "knowledge.enabled": "Enable retrieval from indexed workspace knowledge.",
    "knowledge.retrievalMode": "Retrieval strategy used when knowledge context is requested.",
    "knowledge.maxChunks": "Maximum number of chunks injected into context.",
    "knowledge.rerankApiBase": "Endpoint used when reranking is enabled.",
    "tools-approvals.webEnable": "Allow browser and web search tools.",
    "tools-approvals.execEnable": "Allow local command execution from agent workflows.",
    "tools-approvals.mcpServers": "JSON object of MCP server definitions.",
    "gateway-runtime.host": "Host interface where the desktop gateway listens.",
    "gateway-runtime.port": "Port used by the local gateway endpoint.",
    "gateway-runtime.heartbeat": "Keep the desktop gateway connection fresh.",
    "channels.sendProgress": "Stream progress events into the desktop session.",
    "channels.sendToolHints": "Show tool status hints during agent work.",
    "channels.sendMaxRetries": "Retry count for channel delivery failures.",
  };
  return descriptions[`${groupId}.${fieldId}`] ?? `Current value: ${value || "Not configured"}.`;
}

function requirementLabel(requirement: DesktopSettingsPaneField["requirement"]): string {
  return {
    required: "Required",
    optional: "Optional",
    readonly: "Read only",
  }[requirement];
}

function configurationModeLabel(mode: DesktopSettingsPaneField["configurationMode"]): string {
  return {
    fixed: "Fixed options",
    freeform: "Free text",
    json: "JSON object",
    list: "List",
    numeric: "Number",
    readonly: "Status",
    secret: "Secret",
    toggle: "Toggle",
    url: "URL",
  }[mode];
}
