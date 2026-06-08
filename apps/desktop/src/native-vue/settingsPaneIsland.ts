import { createApp, defineComponent, h, ref, type App } from "vue";
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
  onSettingsAction?: (event: DesktopSettingsActionEvent) => void;
  promptProviderId?: () => string | null;
  onFocusSettingsControl?: (fieldId: string) => void;
}

export interface MountedSettingsPaneIsland {
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

export function mountSettingsPaneIsland(
  host: HTMLElement,
  options: SettingsPaneIslandOptions,
): MountedSettingsPaneIsland {
  host.setAttribute("data-desktop-vue-island", "settings-pane");
  host.className = "desktop-workbench-section desktop-settings-pane";
  host.setAttribute("data-desktop-module-surface", "settings");
  host.setAttribute("data-settings-layout", "capability-center");
  host.setAttribute("aria-label", "Settings and providers");

  const app = createSettingsPaneApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createSettingsPaneApp(options: SettingsPaneIslandOptions): App {
  return createApp(defineComponent({
    name: "SettingsPaneIsland",
    setup() {
      const providerSearch = ref("");
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => [
          renderSidebar(options.pane),
          h("div", { class: "desktop-settings-content" }, [
            renderHeader(),
            renderCapabilityMap(options.pane),
            renderDefaultLlmCard(options),
            renderProviderManagement(options, providerSearch.value, (value) => {
              providerSearch.value = value;
            }),
            renderStatusCard(options.pane),
            renderSettingsGroups(options),
          ]),
        ],
      });
    },
  }));
}

function renderHeader() {
  return h("header", { class: "desktop-settings-header" }, [
    h("div", { class: "desktop-settings-breadcrumb" }, [
      h("h2", "Settings / Capability Center"),
    ]),
  ]);
}

function renderCapabilityMap(pane: DesktopSettingsPaneModel) {
  return h("section", {
    class: "desktop-settings-capability-map",
    "data-desktop-settings-center": "capability-boundaries",
    "aria-label": "Capability boundaries",
  }, capabilityCards(pane).map((card) => h("a", {
    class: "desktop-settings-capability-card",
    href: `#desktop-settings-group-${card.id}`,
    "data-desktop-settings-capability": card.id,
  }, [
    h("span", { class: "desktop-settings-capability-label" }, card.label),
    h("strong", { class: "desktop-settings-capability-status" }, card.status),
    h("span", { class: "desktop-settings-capability-detail" }, card.detail),
  ])));
}

function renderSidebar(pane: DesktopSettingsPaneModel) {
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
    }, renderNavigation(pane.groups)),
  ]);
}

function renderNavigation(groups: DesktopSettingsPaneGroup[]) {
  const nodes = [
    h("p", { class: "desktop-settings-nav-heading" }, "Personal"),
  ];
  groups.forEach((group, index) => {
    if (index === 3) {
      nodes.push(h("p", { class: "desktop-settings-nav-heading" }, "System"));
    }
    nodes.push(h("a", {
      class: "desktop-settings-nav-item",
      href: `#desktop-settings-group-${group.id}`,
      "data-desktop-settings-nav": group.id,
      "data-active": index === 0 ? "true" : undefined,
      "aria-current": index === 0 ? "page" : undefined,
    }, getSettingsNavLabel(group.id)));
  });
  return nodes;
}

function renderDefaultLlmCard(options: SettingsPaneIslandOptions) {
  const provider = findPaneField(options.pane, "provider-models", "selectedProvider");
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
          renderSaveButton(options),
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
  const cards = getProviderCards(options.pane);
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
    h("div", { class: "desktop-settings-provider-grid" }, cards.map((provider) => renderProviderCard(
      options,
      provider,
      shouldHideProviderCard(provider, searchQuery),
    ))),
  ]);
}

function renderProviderCard(
  options: SettingsPaneIslandOptions,
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
        h("span", {
          class: "desktop-settings-provider-switch",
          role: "switch",
          "aria-checked": provider.connected ? "true" : "false",
          "data-state": provider.connected ? "on" : "off",
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

function renderSettingsGroups(options: SettingsPaneIslandOptions) {
  return h("div", { class: "desktop-settings-grid" }, options.pane.groups
    .map((group) => renderSettingsGroup(options, group))
    .filter(Boolean));
}

function renderSettingsGroup(options: SettingsPaneIslandOptions, group: DesktopSettingsPaneGroup) {
  const fields = getSettingsGroupDisplayFields(group);
  if (!fields.length) {
    return null;
  }
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
      ...fields.map((field) => renderSettingsField(options, group, field)),
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
    ]),
    renderSettingsControl(options, field),
  ]);
}

function renderStatusCard(pane: DesktopSettingsPaneModel) {
  return h("section", {
    class: "desktop-settings-status-card",
    "aria-label": "Settings status",
  }, [
    h(NCard, { size: "small", bordered: false }, {
      default: () => h("div", { class: "desktop-settings-summary" }, statusRows(pane).map((row) => h("p", {
        class: "desktop-settings-status-item",
      }, [
        h("span", `${row.label}: `),
        h("strong", row.value),
        row.tone ? h(NSpace, { size: 4, inline: true }, {
          default: () => h(NTag, { size: "small", round: true, type: row.tone }, { default: () => row.value }),
        }) : null,
      ]))),
    }),
  ]);
}

function renderInlineField(
  options: SettingsPaneIslandOptions,
  field: DesktopSettingsPaneField,
  label: string,
) {
  return h("label", { class: "desktop-settings-inline-field" }, [
    h("span", label),
    field.id === "model" && options.pane.providerEditor.models.length > 0
      ? renderModelSelect(options, field)
      : renderSettingsControl(options, field),
  ]);
}

function renderModelSelect(options: SettingsPaneIslandOptions, field: DesktopSettingsPaneField) {
  const values = Array.from(new Set([field.inputValue, ...options.pane.providerEditor.models].filter(Boolean)));
  if (!values.length) {
    values.push("");
  }
  return h("select", {
    id: `desktop-settings-${field.id}`,
    "data-desktop-settings-control": field.id,
    "data-state": field.state,
    "aria-invalid": field.state === "invalid" ? "true" : undefined,
    value: field.inputValue,
    onChange: (event: Event) => emitEdit(options, field.id, String((event.target as HTMLSelectElement | null)?.value ?? "")),
  }, values.map((value) => h("option", {
    value,
    selected: value === field.inputValue ? "true" : undefined,
  }, value || "No model selected")));
}

function renderSettingsControl(options: SettingsPaneIslandOptions, field: DesktopSettingsPaneField) {
  const commonAttrs = {
    id: `desktop-settings-${field.id}`,
    "data-desktop-settings-control": field.id,
    "data-state": field.state,
    "aria-invalid": field.state === "invalid" ? "true" : undefined,
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
    type: field.control === "number" ? "number" : "text",
    value: field.inputValue,
    onInput: (event: Event) => emitEdit(options, field.id, String((event.target as HTMLInputElement | null)?.value ?? "")),
  });
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

function handleProviderCardAction(
  options: SettingsPaneIslandOptions,
  providerId: string,
  target: "model" | "settings",
): void {
  if (providerId !== options.pane.providerEditor.selectedProvider) {
    emitEdit(options, "selectedProvider", providerId);
    options.onFocusSettingsControl?.("selectedProvider");
    return;
  }
  options.onFocusSettingsControl?.(target === "model" ? "model" : "apiBase");
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
    : [{ id: selectedProvider, label: selectedProvider, status: "not_configured" }];
  return catalog.map((provider) => {
    const isSelected = provider.id === selectedProvider;
    const models = isSelected ? pane.providerEditor.models.join(", ") : "";
    return {
      id: provider.id,
      label: provider.label || provider.id,
      badge: isSelected ? "Current" : "",
      initials: providerInitials(provider.label || provider.id),
      connected: provider.status === "ready",
      statusLabel: formatProviderStatus(provider.status),
      statusTone: providerStatusTone(provider.status),
      baseUrl: isSelected ? pane.providerEditor.apiBase || "Not configured" : "Not configured",
      apiKey: isSelected ? pane.providerEditor.apiKey.displayValue || "Not configured" : "Not configured",
      models: models || "No models",
    };
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

function shouldHideProviderCard(provider: ProviderCardModel, query: string): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return false;
  }
  return !`${provider.id} ${provider.label} ${provider.statusLabel} ${provider.baseUrl} ${provider.apiKey} ${provider.models}`.toLowerCase().includes(normalizedQuery);
}

function statusRows(pane: DesktopSettingsPaneModel): Array<{ label: string; value: string; tone?: "default" | "error" | "success" | "warning" }> {
  return [
    { label: "Save", value: pane.save.message, tone: saveTone(pane.save.status) },
    {
      label: "Validation",
      value: pane.validationErrors.length ? pane.validationErrors.map((error) => error.field).join(", ") : "ready",
      tone: pane.validationErrors.length ? "error" : "success",
    },
    { label: "Provider profile", value: pane.providerEditor.profileId || "default" },
    { label: "API key", value: pane.providerEditor.apiKey.displayValue || "Not configured" },
    {
      label: "Catalog",
      value: pane.providerCatalog.map((provider) => `${provider.label} (${provider.status})`).join(", ") || "No providers loaded",
    },
    { label: "Models", value: pane.providerEditor.models.join(", ") || "No models loaded" },
  ];
}

function capabilityCards(pane: DesktopSettingsPaneModel): Array<{
  id: DesktopSettingsPaneGroup["id"];
  label: string;
  status: string;
  detail: string;
}> {
  const selectedProvider = pane.providerEditor.selectedProvider;
  const providerLabel = pane.providerCatalog.find((provider) => provider.id === selectedProvider)?.label || selectedProvider || "Auto";
  const knowledgeEnabled = checkedSettingsField(pane, "knowledge", "enabled");
  const webEnabled = checkedSettingsField(pane, "tools-approvals", "webEnable");
  const shellEnabled = checkedSettingsField(pane, "tools-approvals", "execEnable");
  const gatewayHost = settingsFieldValue(pane, "gateway-runtime", "host") || "localhost";
  const gatewayPort = settingsFieldValue(pane, "gateway-runtime", "port") || "auto";
  return [
    {
      id: "provider-models",
      label: "Provider & Models",
      status: providerLabel,
      detail: pane.providerEditor.models.length ? pane.providerEditor.models.slice(0, 2).join(", ") : "Model catalog not loaded",
    },
    {
      id: "knowledge",
      label: "Knowledge",
      status: knowledgeEnabled ? "Knowledge On" : "Knowledge Off",
      detail: `${settingsFieldValue(pane, "knowledge", "retrievalMode") || "hybrid"} retrieval / top ${settingsFieldValue(pane, "knowledge", "maxChunks") || "auto"}`,
    },
    {
      id: "tools-approvals",
      label: "Tools & Approvals",
      status: `Web ${webEnabled ? "On" : "Off"} / Shell ${shellEnabled ? "On" : "Off"}`,
      detail: settingsFieldValue(pane, "tools-approvals", "mcpServers") === "Configured" ? "MCP configured" : "MCP allowlist empty",
    },
    {
      id: "files-workspace",
      label: "Files & Workspace",
      status: "Three scopes",
      detail: "Session files / Knowledge documents / Workspace files",
    },
    {
      id: "gateway-runtime",
      label: "Gateway & Runtime",
      status: `Gateway ${gatewayHost}:${gatewayPort}`,
      detail: checkedSettingsField(pane, "gateway-runtime", "heartbeat") ? "Heartbeat enabled" : "Heartbeat disabled",
    },
    {
      id: "logs-diagnostics",
      label: "Logs & Diagnostics",
      status: pane.validationErrors.length ? `${pane.validationErrors.length} issues` : "Ready",
      detail: pane.validationErrors.length ? pane.validationErrors.map((error) => error.field).join(", ") : "Diagnostics export and runtime logs",
    },
  ];
}

function settingsFieldValue(
  pane: DesktopSettingsPaneModel,
  groupId: DesktopSettingsPaneGroup["id"],
  fieldId: string,
): string {
  return findPaneField(pane, groupId, fieldId)?.value ?? "";
}

function checkedSettingsField(
  pane: DesktopSettingsPaneModel,
  groupId: DesktopSettingsPaneGroup["id"],
  fieldId: string,
): boolean {
  return findPaneField(pane, groupId, fieldId)?.checked === true;
}

function saveLabel(pane: DesktopSettingsPaneModel): string {
  if (pane.save.status === "saving") {
    return "Saving...";
  }
  if (pane.save.status === "saved" || !pane.dirty) {
    return "Saved";
  }
  return "Save settings";
}

function saveTone(status: DesktopSettingsPaneModel["save"]["status"]): "default" | "error" | "success" | "warning" {
  if (status === "saved") {
    return "success";
  }
  if (status === "failed") {
    return "error";
  }
  if (status === "saving") {
    return "warning";
  }
  return "default";
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
