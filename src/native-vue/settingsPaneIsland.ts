import { createApp, defineComponent, h, nextTick, onBeforeUnmount, onMounted, ref, type App, type Ref } from "vue";
import { NButton, NCard, NConfigProvider, NTag } from "naive-ui";
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
  mode?: "full" | "content" | "sidebar";
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
  modelCountLabel: string;
  sourceLabel: string;
}

interface SettingsSearchResult {
  key: string;
  groupId: DesktopSettingsPaneGroup["id"];
  groupLabel: string;
  fieldId: string;
  fieldLabel: string;
  description: string;
  advanced: boolean;
}

interface ProviderSetupState {
  open: boolean;
  providerId: string;
  profileName: string;
  credentialSource: string;
  endpoint: string;
  models: string;
  useDefault: boolean;
  setOpen: (value: boolean) => void;
  setProviderId: (value: string) => void;
  setProfileName: (value: string) => void;
  setCredentialSource: (value: string) => void;
  setEndpoint: (value: string) => void;
  setModels: (value: string) => void;
  setUseDefault: (value: boolean) => void;
  reset: () => void;
}

const mountedSettingsPanes = new WeakMap<HTMLElement, MountedSettingsPaneIsland>();
const SETTINGS_GROUP_SELECT_EVENT = "desktop-settings-select-group";

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
  applySettingsPaneHost(host, options.mode);
  const state = ref(options) as Ref<SettingsPaneIslandOptions>;
  const app = createSettingsPaneApp(state, host);
  app.mount(host);
  const nextMounted = {
    update: (nextOptions: SettingsPaneIslandOptions) => {
      applySettingsPaneHost(host, nextOptions.mode);
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

function applySettingsPaneHost(host: HTMLElement, mode: SettingsPaneIslandOptions["mode"] = "full"): void {
  if (mode === "sidebar") {
    host.setAttribute("data-desktop-vue-island", "settings-sidebar");
    host.className = "desktop-settings-sidebar";
    host.removeAttribute("data-desktop-module-surface");
    host.removeAttribute("data-settings-layout");
    host.setAttribute("aria-label", "Settings navigation");
    return;
  }
  host.setAttribute("data-desktop-vue-island", "settings-pane");
  host.className = "desktop-workbench-section desktop-settings-pane";
  host.setAttribute("data-desktop-module-surface", "settings");
  host.setAttribute("data-settings-layout", "section-pages");
  host.setAttribute("aria-label", "Settings and providers");
}

function createSettingsPaneApp(state: Ref<SettingsPaneIslandOptions>, host: HTMLElement): App {
  return createApp(defineComponent({
    name: "SettingsPaneIsland",
    setup() {
      const providerSearch = ref("");
      const providerSetupOpen = ref(false);
      const newProviderId = ref("");
      const newProviderProfileName = ref("");
      const newProviderCredentialSource = ref("env");
      const newProviderEndpoint = ref("");
      const newProviderModels = ref("");
      const newProviderUseDefault = ref(false);
      const settingsSearch = ref("");
      const highlightedFieldId = ref("");
      const activeGroupId = ref(getActiveSettingsGroup(state.value.pane, state.value.initialActiveGroupId)?.id ?? "general");
      const dispatchActiveGroupId = (groupId: DesktopSettingsPaneGroup["id"], fieldId = "") => {
        const EventCtor = host.ownerDocument.defaultView?.CustomEvent ?? CustomEvent;
        host.ownerDocument.dispatchEvent(new EventCtor(SETTINGS_GROUP_SELECT_EVENT, {
          detail: { groupId, fieldId },
        }));
      };
      const setActiveGroupId = (groupId: DesktopSettingsPaneGroup["id"]) => {
        activeGroupId.value = groupId;
        dispatchActiveGroupId(groupId);
      };
      const activateSearchResult = (result: SettingsSearchResult) => {
        activeGroupId.value = result.groupId;
        highlightedFieldId.value = result.fieldId;
        dispatchActiveGroupId(result.groupId, result.fieldId);
        void nextTick(() => {
          const control = host.querySelector<HTMLElement>(`#desktop-settings-${result.fieldId}`);
          control?.focus();
          if (!control || host.ownerDocument.activeElement !== control) {
            host.querySelector<HTMLElement>(`[data-desktop-settings-field="${result.fieldId}"]`)?.focus();
          }
          window.setTimeout(() => {
            if (highlightedFieldId.value === result.fieldId) {
              highlightedFieldId.value = "";
            }
          }, 1400);
        });
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
      const onExternalGroupSelected = (event: Event) => {
        const detail = (event as CustomEvent<{ groupId?: DesktopSettingsPaneGroup["id"]; fieldId?: string }>).detail;
        const groupId = detail?.groupId;
        if (!groupId || !getActiveSettingsGroup(state.value.pane, groupId)) {
          return;
        }
        activeGroupId.value = groupId;
        if (detail.fieldId) {
          highlightedFieldId.value = detail.fieldId;
          void nextTick(() => {
            const control = host.ownerDocument.querySelector<HTMLElement>(`#desktop-settings-${detail.fieldId}`);
            control?.focus();
            if (!control || host.ownerDocument.activeElement !== control) {
              host.ownerDocument.querySelector<HTMLElement>(`[data-desktop-settings-field="${detail.fieldId}"]`)?.focus();
            }
          });
        }
      };
      const onDocumentClick = (event: Event) => {
        const ElementCtor = host.ownerDocument.defaultView?.Element ?? Element;
        const target = event.target;
        if (target instanceof ElementCtor && target.closest(".desktop-settings-local-nav")) {
          return;
        }
        closeSettingsLocalNavigationMenus(host.ownerDocument);
      };
      onMounted(() => {
        host.ownerDocument.addEventListener(SETTINGS_GROUP_SELECT_EVENT, onExternalGroupSelected);
        host.ownerDocument.addEventListener("click", onDocumentClick);
      });
      onBeforeUnmount(() => {
        host.ownerDocument.removeEventListener(SETTINGS_GROUP_SELECT_EVENT, onExternalGroupSelected);
        host.ownerDocument.removeEventListener("click", onDocumentClick);
      });
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => {
          const options = state.value;
          const mode = options.mode ?? "full";
          const selectedGroupId = currentActiveGroupId(options);
          const sidebar = renderSidebar(
              options,
              selectedGroupId,
              settingsSearch.value,
              (value) => {
                settingsSearch.value = value;
              },
              activateSearchResult,
              setActiveGroupId,
            );
          const content = h("div", { class: "desktop-settings-content" }, [
              mode === "content" ? renderLocalNavigationFallback(options.pane, selectedGroupId, setActiveGroupId, host.ownerDocument) : null,
              renderHeader(options, selectedGroupId),
              renderSaveAlert(options),
              renderActiveSettingsSection(
                options,
                selectedGroupId,
                highlightedFieldId.value,
                providerSearch.value,
                (value) => {
                providerSearch.value = value;
                },
                {
                  open: providerSetupOpen.value,
                  providerId: newProviderId.value,
                  profileName: newProviderProfileName.value,
                  credentialSource: newProviderCredentialSource.value,
                  endpoint: newProviderEndpoint.value,
                  models: newProviderModels.value,
                  useDefault: newProviderUseDefault.value,
                  setOpen: (value) => {
                    providerSetupOpen.value = value;
                  },
                  setProviderId: (value) => {
                    newProviderId.value = value;
                  },
                  setProfileName: (value) => {
                    newProviderProfileName.value = value;
                  },
                  setCredentialSource: (value) => {
                    newProviderCredentialSource.value = value;
                  },
                  setEndpoint: (value) => {
                    newProviderEndpoint.value = value;
                  },
                  setModels: (value) => {
                    newProviderModels.value = value;
                  },
                  setUseDefault: (value) => {
                    newProviderUseDefault.value = value;
                  },
                  reset: () => {
                    providerSetupOpen.value = false;
                    newProviderId.value = "";
                    newProviderProfileName.value = "";
                    newProviderCredentialSource.value = "env";
                    newProviderEndpoint.value = "";
                    newProviderModels.value = "";
                    newProviderUseDefault.value = false;
                  },
                },
              ),
            ]);
          if (mode === "sidebar") {
            return sidebar;
          }
          if (mode === "content") {
            return content;
          }
          return [sidebar, content];
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
  const saveRegion = renderSaveRegion(options);
  return h("header", { class: "desktop-settings-header" }, [
    h("div", { class: "desktop-settings-breadcrumb" }, [
      h("h2", activeGroup?.label ?? "General"),
      activeGroup ? h("p", { class: "desktop-settings-header-description" }, getSettingsGroupDescription(activeGroup)) : null,
    ]),
    saveRegion,
  ]);
}

function renderSaveRegion(options: SettingsPaneIslandOptions) {
  const saveStatus = renderSaveStatus(options);
  const saveButton = renderSaveButton(options);
  if (!saveStatus && !saveButton) {
    return null;
  }
  return h("div", { class: "desktop-settings-save-region" }, [
    saveStatus,
    saveButton,
  ]);
}

function renderSaveStatus(options: SettingsPaneIslandOptions) {
  const pane = options.pane;
  const saveDetails = renderSaveDetails(options);
  if (!saveDetails && !pane.dirty && pane.save.status !== "saving" && pane.save.status !== "failed") {
    return null;
  }
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
    action?: "restartGateway" | "reloadWorkspace" | "copyDiagnostics";
    label?: string;
    buttonOnly?: boolean;
  }> = [];
  if (pane.save.updatedFields?.length) {
    const revision = pane.save.persistedRevision ? ` at ${pane.save.persistedRevision}` : "";
    details.push({ text: `Persisted${revision}: ${pane.save.updatedFields.join(", ")}` });
  }
  if (pane.save.applied?.length) {
    details.push({ text: `Runtime applied: ${pane.save.applied.join(", ")}` });
  } else if (pane.save.updatedFields?.length) {
    details.push({ text: "Runtime applied: none acknowledged" });
  }
  if (pane.save.restartRequired?.length) {
    details.push({
      text: `Gateway restart required: ${pane.save.restartRequired.join(", ")}`,
      action: "restartGateway",
      label: "Restart gateway now",
    });
  }
  if (pane.save.reloadRequired?.length) {
    details.push({
      text: `Workspace reload required: ${pane.save.reloadRequired.join(", ")}`,
      action: "reloadWorkspace",
      label: "Reload workspace",
    });
  }
  if (pane.save.transport === "gateway-fallback") {
    details.push({ text: "Persisted through gateway fallback" });
  }
  details.push(...(pane.save.warnings ?? []).map((warning) => ({ text: warning })));
  if (pane.save.transport === "gateway-fallback" || pane.save.warnings?.length) {
    details.push({
      text: "",
      action: "copyDiagnostics",
      label: "Copy diagnostics",
      buttonOnly: true,
    });
  }
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
      detail.buttonOnly ? null : h("span", detail.text),
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
  options: SettingsPaneIslandOptions,
  activeGroupId: DesktopSettingsPaneGroup["id"],
  searchQuery: string,
  updateSearchQuery: (value: string) => void,
  activateSearchResult: (result: SettingsSearchResult) => void,
  setActiveGroupId: (groupId: DesktopSettingsPaneGroup["id"]) => void,
) {
  const pane = options.pane;
  return h("aside", {
    class: "desktop-settings-sidebar",
    "aria-label": "Settings navigation",
  }, [
    h("input", {
      class: "desktop-settings-search",
      type: "search",
      value: searchQuery,
      placeholder: "Search settings...",
      "aria-label": "Search settings",
      "data-desktop-settings-search": "query",
      onInput: (event: Event) => updateSearchQuery(String((event.target as HTMLInputElement | null)?.value ?? "")),
    }),
    renderSettingsSearchResults(pane, searchQuery, activateSearchResult),
    renderDirtySummary(options),
    h("nav", {
      class: "desktop-settings-nav",
      "aria-label": "Settings sections",
    }, renderNavigation(pane.groups, activeGroupId, setActiveGroupId)),
    renderPreviewSettingsGroups(pane.groups),
  ]);
}

function renderSettingsSearchResults(
  pane: DesktopSettingsPaneModel,
  searchQuery: string,
  activateSearchResult: (result: SettingsSearchResult) => void,
) {
  const query = searchQuery.trim();
  if (!query) {
    return null;
  }
  const results = getSettingsSearchResults(pane, query);
  if (!results.length) {
    return h("div", {
      class: "desktop-settings-search-empty",
      "data-desktop-settings-search-empty": "true",
      role: "status",
    }, "No settings found");
  }
  return h("div", {
    class: "desktop-settings-search-results",
    "aria-label": "Settings search results",
  }, results.map((result) => h("button", {
    type: "button",
    class: "desktop-settings-search-result",
    "data-desktop-settings-search-result": result.key,
    onClick: () => activateSearchResult(result),
  }, [
    h("span", result.fieldLabel),
    h("small", result.groupLabel),
  ])));
}

function renderDirtySummary(options: SettingsPaneIslandOptions) {
  const pane = options.pane;
  if (!pane.dirty) {
    return null;
  }
  return h("div", {
    class: "desktop-settings-dirty-summary",
    "data-desktop-settings-dirty-summary": "",
  }, [
    h("span", pane.save.message || "Unsaved changes"),
    h("button", {
      type: "button",
      "data-desktop-settings-action": "reset",
      onClick: () => options.onSettingsAction?.({ action: "reset", pane }),
    }, "Reset"),
  ]);
}

function renderLocalNavigationFallback(
  pane: DesktopSettingsPaneModel,
  activeGroupId: DesktopSettingsPaneGroup["id"],
  setActiveGroupId: (groupId: DesktopSettingsPaneGroup["id"]) => void,
  targetDocument: Document,
) {
  const activeGroup = getActiveSettingsGroup(pane, activeGroupId);
  return h("nav", {
    class: "desktop-settings-local-nav",
    "aria-label": "Settings navigation fallback",
  }, [
    h("details", { class: "desktop-settings-local-nav-menu" }, [
      h("summary", { class: "desktop-settings-local-nav-current" }, activeGroup?.label ?? "Settings"),
      h("div", { class: "desktop-settings-local-nav-list" }, renderNavigation(pane.groups, activeGroupId, setActiveGroupId)),
    ]),
    h("button", {
      type: "button",
      class: "desktop-settings-local-nav-restore",
      "data-desktop-settings-action": "showSidebarNav",
      onClick: () => showDesktopSettingsSidebarNavigation(targetDocument),
    }, "Show settings nav"),
  ]);
}

function showDesktopSettingsSidebarNavigation(targetDocument: Document): void {
  targetDocument.getElementById("desktop-workbench-shell")?.setAttribute("data-sidebar-visible", "true");
  targetDocument.querySelector<HTMLElement>('[data-workbench-region="sidebar"]')?.setAttribute("data-visible", "true");
}

function renderNavigation(
  groups: DesktopSettingsPaneGroup[],
  activeGroupId: DesktopSettingsPaneGroup["id"],
  setActiveGroupId: (groupId: DesktopSettingsPaneGroup["id"]) => void,
) {
  const nodes: ReturnType<typeof h>[] = [];
  for (const area of ["core", "application", "system"] as const) {
    const areaGroups = getNavigableSettingsGroups(groups).filter((group) => (group.navigationArea ?? "core") === area);
    if (!areaGroups.length) {
      continue;
    }
    nodes.push(h("p", { class: "desktop-settings-nav-heading" }, navigationAreaLabel(area)));
    nodes.push(...areaGroups.map((group) => h("a", {
        class: "desktop-settings-nav-item",
        href: "#",
        "data-desktop-settings-nav": group.id,
        "data-active": group.id === activeGroupId ? "true" : undefined,
        "aria-current": group.id === activeGroupId ? "page" : undefined,
        onClick: (event: Event) => selectSettingsGroup(event, group.id, setActiveGroupId),
      }, group.label)));
  }
  return nodes;
}

function renderPreviewSettingsGroups(groups: DesktopSettingsPaneGroup[]) {
  const previewGroups = getPreviewSettingsGroups(groups);
  if (!previewGroups.length) {
    return null;
  }
  return h("div", {
    class: "desktop-settings-preview-list",
    "aria-label": "Settings previews",
  }, previewGroups.map((group) => h("div", {
    class: "desktop-settings-preview-item",
    "data-desktop-settings-preview": group.id,
  }, [
    h("span", group.label),
    h("small", "Preview"),
  ])));
}

function renderActiveSettingsSection(
  options: SettingsPaneIslandOptions,
  activeGroupId: DesktopSettingsPaneGroup["id"],
  highlightedFieldId: string,
  providerSearch: string,
  setProviderSearch: (value: string) => void,
  providerSetup: ProviderSetupState,
) {
  const group = getActiveSettingsGroup(options.pane, activeGroupId);
  if (activeGroupId === "general") {
    return group ? renderGeneralSettingsPage(options, group, highlightedFieldId) : null;
  }
  if (activeGroupId === "provider-models") {
    return group ? renderProviderModelsPage(options, group, highlightedFieldId, providerSearch, setProviderSearch, providerSetup) : null;
  }
  if (activeGroupId === "knowledge") {
    return group ? renderKnowledgeSettingsPage(options, group, highlightedFieldId) : null;
  }
  const groupNode = group ? renderSettingsGroup(options, group, highlightedFieldId) : null;
  return groupNode ? renderSingleSettingsGroup(groupNode) : null;
}

function renderGeneralSettingsPage(
  options: SettingsPaneIslandOptions,
  group: DesktopSettingsPaneGroup,
  highlightedFieldId: string,
) {
  const field = (fieldId: string) => findPaneField(options.pane, "general", fieldId);
  const provider = field("provider");
  const model = field("model");
  const timezone = field("timezone");
  const temperature = field("temperature");
  const maxTokens = field("maxTokens");
  const contextWindowTokens = field("contextWindowTokens");
  const reasoningEffort = field("reasoningEffort");
  const maxToolIterations = field("maxToolIterations");
  return h("div", {
    class: "desktop-settings-task-page desktop-settings-general-page",
    "data-desktop-settings-task-page": "general",
  }, [
    h("section", {
      class: "desktop-settings-task-card desktop-settings-default-ai-section",
      "data-desktop-settings-page-section": "default-ai",
    }, [
      renderSectionHeading("Default AI", "Choose the provider and model used when a task has no explicit override.", "Auto routing"),
      h("div", { class: "desktop-settings-default-ai-layout" }, [
        h("div", { class: "desktop-settings-field-pair" }, [
          provider ? renderInlineField(options, provider) : null,
          model ? renderInlineField(options, model) : null,
        ]),
        renderResolvedRouteCard(options),
      ]),
      h("p", { class: "desktop-settings-supporting-copy" }, "Agents can still override this default per task."),
    ]),
    h("section", {
      class: "desktop-settings-task-card desktop-settings-profile-locale-section",
      "data-desktop-settings-page-section": "profile-locale",
    }, [
      renderSectionHeading("Locale", "Time settings used throughout the desktop app."),
      h("div", { class: "desktop-settings-field-pair" }, [
        timezone ? renderSettingsField(options, group, timezone, highlightedFieldId) : null,
      ]),
    ]),
    h("section", {
      class: "desktop-settings-task-card desktop-settings-response-defaults-section",
      "data-desktop-settings-page-section": "response-defaults",
    }, [
      renderSectionHeading("Response defaults", "Balanced defaults for quality, speed, and context usage."),
      h("div", { class: "desktop-settings-response-grid" }, [
        temperature ? renderSettingsField(options, group, temperature, highlightedFieldId) : null,
        maxTokens ? renderSettingsField(options, group, maxTokens, highlightedFieldId) : null,
        contextWindowTokens ? renderSettingsField(options, group, contextWindowTokens, highlightedFieldId) : null,
        reasoningEffort ? renderSettingsField(options, group, reasoningEffort, highlightedFieldId) : null,
        maxToolIterations ? renderSettingsField(options, group, maxToolIterations, highlightedFieldId) : null,
        h("aside", {
          class: "desktop-settings-status-card desktop-settings-recommendation-card",
          "data-desktop-settings-response-baseline": "",
        }, [
          h("strong", "Recommended baseline"),
          h("span", "Good for everyday desktop work."),
        ]),
      ]),
      h("details", { class: "desktop-settings-advanced-fields desktop-settings-response-advanced" }, [
        h("summary", "Advanced defaults"),
        h("p", "These values use the same saved settings fields and remain fully editable above."),
      ]),
    ]),
  ]);
}

function renderResolvedRouteCard(options: SettingsPaneIslandOptions) {
  const routing = options.pane.defaultRouting;
  const provider = routing?.providerLabel || findPaneField(options.pane, "general", "provider")?.inputValue || "Auto";
  const model = routing?.model || findPaneField(options.pane, "general", "model")?.inputValue || "Not configured";
  const modelCount = getDefaultLlmModelOptions(options.pane).length;
  return h("aside", {
    class: "desktop-settings-status-card desktop-settings-resolved-route-card",
    "data-desktop-settings-auto-resolution": "",
  }, [
    h("span", { class: "desktop-settings-eyebrow" }, "Resolved route"),
    h("strong", `${provider} / ${model}`),
    h("span", { class: "desktop-settings-status-line" }, routing?.message || `${modelCount} ${modelCount === 1 ? "model" : "models"} available`),
  ]);
}

function renderSectionHeading(title: string, description: string, badge?: string) {
  return h("header", { class: "desktop-settings-section-heading" }, [
    h("div", [
      h("h2", title),
      h("p", description),
    ]),
    badge ? h("span", { class: "desktop-settings-section-badge" }, badge) : null,
  ]);
}

function renderKnowledgeSettingsPage(
  options: SettingsPaneIslandOptions,
  group: DesktopSettingsPaneGroup,
  highlightedFieldId: string,
) {
  const field = (fieldId: string) => findPaneField(options.pane, "knowledge", fieldId);
  const enabled = field("enabled");
  const autoRetrieve = field("autoRetrieve");
  const retrievalMode = field("retrievalMode");
  const maxChunks = field("maxChunks");
  const chunkSize = field("chunkSize");
  const chunkOverlap = field("chunkOverlap");
  const rerankEnabled = field("rerankEnabled");
  const rerankTopN = field("rerankTopN");
  const rerankModel = field("rerankModel");
  const rerankApiBase = field("rerankApiBase");
  const graphExtractionEnabled = field("graphExtractionEnabled");
  const graphExtractionModel = field("graphExtractionModel");
  const graphExtractionMaxTokens = field("graphExtractionMaxTokens");
  const graphExtractionMaxJobTokens = field("graphExtractionMaxJobTokens");
  const graphExtractionConcurrency = field("graphExtractionConcurrency");
  const disabled = enabled?.checked === false;
  return h("div", {
    class: "desktop-settings-task-page desktop-settings-knowledge-page",
    "data-desktop-settings-task-page": "knowledge",
    "data-knowledge-disabled": disabled ? "true" : undefined,
  }, [
    h("div", { class: "desktop-settings-knowledge-toolbar" }, [
      h("label", {
        class: "desktop-settings-knowledge-enabled",
        "data-desktop-settings-knowledge-enabled": "",
      }, [
        h("span", "Knowledge enabled"),
        enabled ? renderSettingsControl(options, enabled) : null,
      ]),
      h(NButton, {
        size: "small",
        "data-desktop-settings-knowledge-action": "openDocuments",
        onClick: () => options.onSettingsAction?.({ action: "openKnowledgeDocuments", pane: options.pane }),
      }, { default: () => "Open documents" }),
    ]),
    h("section", {
      class: "desktop-settings-task-card desktop-settings-knowledge-pipeline",
      "data-desktop-settings-page-section": "knowledge-pipeline",
    }, [
      renderSectionHeading("Knowledge pipeline", "Retrieval is available. Advanced enrichment remains optional.", disabled ? "Disabled" : "Ready"),
      h("ol", { class: "desktop-settings-knowledge-stages" }, getKnowledgePipelineStages(group).map((stage) => h("li", {
        "data-desktop-settings-knowledge-stage": stage.id,
        "data-state": stage.state,
      }, [
        h("span", { class: "desktop-settings-knowledge-stage-marker" }, stage.index),
        h("strong", stage.label),
        h("small", stage.detail),
      ]))),
    ]),
    h("div", { class: "desktop-settings-knowledge-core-layout" }, [
      h("section", {
        class: "desktop-settings-task-card desktop-settings-retrieval-defaults",
        "data-desktop-settings-page-section": "retrieval-defaults",
      }, [
        renderSectionHeading("Retrieval defaults", "The settings used when a chat requests knowledge."),
        autoRetrieve ? renderSettingsField(options, group, autoRetrieve, highlightedFieldId) : null,
        retrievalMode ? renderRetrievalModeControl(options, retrievalMode) : null,
        maxChunks ? renderSettingsField(options, group, maxChunks, highlightedFieldId) : null,
        h("p", { class: "desktop-settings-recommendation-note" }, "Hybrid is recommended for mixed docs and exact terms."),
      ]),
      h("section", {
        class: "desktop-settings-task-card desktop-settings-quality-presets",
        "data-desktop-settings-page-section": "quality-presets",
      }, [
        renderSectionHeading("Quality preset", "A shortcut mapped to existing settings."),
        ...renderKnowledgePresetButtons(options),
        h("p", { class: "desktop-settings-supporting-copy" }, "Presets only change visible fields; every value remains editable."),
      ]),
    ]),
    h("section", {
      class: "desktop-settings-task-card desktop-settings-quality-layers",
      "data-desktop-settings-page-section": "quality-layers",
    }, [
      renderSectionHeading("Indexing & quality layers", "Tune source preparation and optional quality improvements."),
      h("div", { class: "desktop-settings-quality-layer-grid" }, [
        h("article", { class: "desktop-settings-quality-layer", "data-desktop-settings-quality-layer": "chunking" }, [
          h("h3", "Chunking"),
          chunkSize ? renderSettingsField(options, group, chunkSize, highlightedFieldId) : null,
          chunkOverlap ? renderSettingsField(options, group, chunkOverlap, highlightedFieldId) : null,
        ]),
        h("article", { class: "desktop-settings-quality-layer", "data-desktop-settings-quality-layer": "reranking" }, [
          h("h3", "Reranking"),
          rerankEnabled ? renderSettingsField(options, group, rerankEnabled, highlightedFieldId) : null,
          rerankTopN ? renderSettingsField(options, group, rerankTopN, highlightedFieldId) : null,
          rerankModel ? renderSettingsField(options, group, rerankModel, highlightedFieldId) : null,
          rerankApiBase ? renderSettingsField(options, group, rerankApiBase, highlightedFieldId) : null,
        ]),
        h("article", { class: "desktop-settings-quality-layer", "data-desktop-settings-quality-layer": "graph" }, [
          h("h3", "Knowledge graph"),
          graphExtractionEnabled ? renderSettingsField(options, group, graphExtractionEnabled, highlightedFieldId) : null,
          graphExtractionModel ? renderSettingsField(options, group, graphExtractionModel, highlightedFieldId) : null,
          graphExtractionMaxTokens ? renderSettingsField(options, group, graphExtractionMaxTokens, highlightedFieldId) : null,
          graphExtractionMaxJobTokens ? renderSettingsField(options, group, graphExtractionMaxJobTokens, highlightedFieldId) : null,
          graphExtractionConcurrency ? renderSettingsField(options, group, graphExtractionConcurrency, highlightedFieldId) : null,
        ]),
      ]),
      h("details", { class: "desktop-settings-advanced-fields desktop-settings-knowledge-advanced" }, [
        h("summary", "Advanced knowledge settings"),
        h("p", "Advanced graph and reranking fields remain editable in the quality layer cards."),
      ]),
    ]),
  ]);
}

function renderRetrievalModeControl(
  options: SettingsPaneIslandOptions,
  field: DesktopSettingsPaneField,
) {
  const modes = [
    { value: "sparse", label: "Keyword" },
    { value: "dense", label: "Semantic" },
    { value: "hybrid", label: "Hybrid" },
  ];
  return h("div", {
    class: "desktop-settings-segmented-control",
    role: "group",
    "aria-label": field.label,
  }, modes.map((mode) => h("button", {
    type: "button",
    "data-desktop-settings-retrieval-mode": mode.value,
    "aria-pressed": field.inputValue === mode.value ? "true" : "false",
    disabled: field.disabled ? true : undefined,
    onClick: () => emitEdit(options, field.id, mode.value),
  }, mode.label)));
}

function renderKnowledgePresetButtons(options: SettingsPaneIslandOptions) {
  const presets = [
    { id: "fast", label: "Fast", detail: "No rerank - no graph" },
    { id: "balanced", label: "Balanced", detail: "Hybrid - 5 chunks" },
    { id: "deep", label: "Deep", detail: "Rerank - graph" },
  ];
  return presets.map((preset) => h("button", {
    type: "button",
    class: "desktop-settings-quality-preset",
    "data-desktop-settings-quality-preset": preset.id,
    onClick: () => applyKnowledgePreset(options, preset.id),
  }, [
    h("strong", preset.label),
    h("span", preset.detail),
  ]));
}

function applyKnowledgePreset(options: SettingsPaneIslandOptions, presetId: string): void {
  const patches: Record<string, string | boolean> = presetId === "fast"
    ? {
        maxChunks: "3",
        retrievalMode: "sparse",
        rerankEnabled: false,
        graphExtractionEnabled: false,
      }
    : presetId === "deep"
      ? {
          maxChunks: "8",
          retrievalMode: "hybrid",
          rerankEnabled: true,
          graphExtractionEnabled: true,
        }
      : {
          maxChunks: "5",
          retrievalMode: "hybrid",
          rerankEnabled: false,
          graphExtractionEnabled: false,
        };
  for (const [fieldId, value] of Object.entries(patches)) {
    emitEdit(options, fieldId, value);
  }
}

function getKnowledgePipelineStages(group: DesktopSettingsPaneGroup): Array<{
  id: string;
  label: string;
  detail: string;
  state: "ready" | "optional" | "disabled";
  index: string;
}> {
  const field = (fieldId: string) => group.fields.find((candidate) => candidate.id === fieldId);
  const enabled = field("enabled")?.checked !== false;
  const rerank = field("rerankEnabled")?.checked === true;
  const graph = field("graphExtractionEnabled")?.checked === true;
  return [
    { id: "documents", label: "Documents", detail: "Available", state: enabled ? "ready" : "disabled", index: "1" },
    { id: "chunking", label: "Chunking", detail: "Configured", state: enabled ? "ready" : "disabled", index: "2" },
    { id: "embeddings", label: "Embeddings", detail: "Configured", state: enabled ? "ready" : "disabled", index: "3" },
    { id: "retrieval", label: "Retrieval", detail: "Available", state: enabled ? "ready" : "disabled", index: "4" },
    { id: "rerank", label: "Rerank", detail: rerank ? "Enabled" : "Optional", state: !enabled ? "disabled" : rerank ? "ready" : "optional", index: "5" },
    { id: "graph", label: "Graph", detail: graph ? "Enabled" : "Optional", state: !enabled ? "disabled" : graph ? "ready" : "optional", index: "6" },
  ];
}

function renderProviderModelsPage(
  options: SettingsPaneIslandOptions,
  group: DesktopSettingsPaneGroup,
  highlightedFieldId: string,
  searchQuery: string,
  updateSearchQuery: (value: string) => void,
  providerSetup: ProviderSetupState,
) {
  return h("div", {
    class: "desktop-settings-task-page desktop-settings-provider-page",
    "data-desktop-settings-task-page": "provider-models",
  }, [
    renderProviderManagement(options, searchQuery, updateSearchQuery, providerSetup),
    renderProviderDetailPanel(options, group, highlightedFieldId),
  ]);
}

function renderProviderManagement(
  options: SettingsPaneIslandOptions,
  searchQuery: string,
  updateSearchQuery: (value: string) => void,
  providerSetup: ProviderSetupState,
) {
  const cards = getProviderCards(options.pane).filter((provider) => !shouldHideProviderCard(provider, searchQuery));
  const allCards = getProviderCards(options.pane);
  const readyCount = allCards.filter((provider) => provider.connected || /ready|connected/i.test(provider.statusLabel)).length;
  const modelCount = options.pane.providerCatalog.reduce((total, provider) => total + (provider.models?.length ?? 0), 0);
  return h("section", {
    class: "desktop-settings-provider-section",
    "aria-label": "Provider management",
  }, [
    h("header", { class: "desktop-settings-provider-header" }, [
      h("div", [
        h("h2", "Connected providers"),
        h("p", { class: "desktop-settings-group-description" }, "Select a card to edit its connection and models."),
      ]),
      h("div", { class: "desktop-settings-provider-tools" }, [
        h("input", {
          class: "desktop-settings-provider-search",
          type: "search",
          value: searchQuery,
          placeholder: "Search providers...",
          "aria-label": "Search providers",
          onInput: (event: Event) => updateSearchQuery(String((event.target as HTMLInputElement | null)?.value ?? "")),
        }),
        h("span", {
          class: "desktop-settings-provider-summary",
          "data-desktop-settings-provider-summary": "total",
        }, `${allCards.length} ${allCards.length === 1 ? "provider" : "providers"}`),
        h("span", {
          class: "desktop-settings-provider-summary",
          "data-desktop-settings-provider-summary": "ready",
        }, `${readyCount} ready`),
        h("span", {
          class: "desktop-settings-provider-summary",
          "data-desktop-settings-provider-summary": "models",
        }, `${modelCount} ${modelCount === 1 ? "model" : "models"}`),
        h(NButton, {
          class: "desktop-settings-provider-icon-button",
          type: "default",
          size: "small",
          disabled: !options.pane.providerEditor.canDiscoverModels,
          "data-desktop-settings-action": "discoverModels",
          "aria-label": `Refresh models for ${options.pane.providerEditor.selectedProvider}`,
          onClick: () => requestProviderModelDiscovery(options, options.pane.providerEditor.selectedProvider),
        }, { default: () => "Refresh" }),
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
  ]);
}

function renderProviderDetailPanel(
  options: SettingsPaneIslandOptions,
  group: DesktopSettingsPaneGroup,
  highlightedFieldId: string,
) {
  const selected = getProviderCards(options.pane).find((provider) => provider.id === options.pane.providerEditor.selectedProvider)
    ?? getProviderCards(options.pane)[0];
  const profileId = findPaneField(options.pane, "provider-models", "profileId");
  const apiKey = findPaneField(options.pane, "provider-models", "apiKey");
  const apiBase = findPaneField(options.pane, "provider-models", "apiBase");
  const models = findPaneField(options.pane, "provider-models", "models");
  return h("aside", {
    class: "desktop-settings-task-card desktop-settings-provider-detail-panel",
    "data-desktop-settings-provider-detail": selected?.id ?? "",
  }, [
    h("header", { class: "desktop-settings-provider-detail-header" }, [
      h("div", [
        h("h2", `Edit ${selected?.label ?? options.pane.providerEditor.selectedProvider}`),
        h("p", { class: "desktop-settings-group-description" }, "Changes apply to the selected profile."),
      ]),
      h(NTag, { size: "small", round: true, type: selected?.statusTone ?? "default" }, { default: () => selected?.statusLabel ?? "Unknown" }),
    ]),
    h("section", {
      class: "desktop-settings-provider-detail-section",
      "data-desktop-settings-provider-detail-section": "connection",
    }, [
      h("h3", "Connection"),
      profileId ? renderSettingsField(options, group, profileId, highlightedFieldId) : null,
      apiKey ? renderSettingsField(options, group, apiKey, highlightedFieldId) : null,
      apiBase ? renderSettingsField(options, group, apiBase, highlightedFieldId) : null,
      h("div", { class: "desktop-settings-status-card" }, [
        h("strong", selected?.connected ? "Connection healthy" : "Connection needs attention"),
        h("span", selected?.baseUrl ?? "No endpoint configured"),
      ]),
    ]),
    h("section", {
      class: "desktop-settings-provider-detail-section",
      "data-desktop-settings-provider-detail-section": "models",
    }, [
      h("h3", "Model catalog"),
      models ? renderSettingsField(options, group, models, highlightedFieldId) : null,
      h("div", { class: "desktop-settings-provider-model-actions" }, [
        h(NButton, {
          size: "small",
          disabled: !options.pane.providerEditor.canDiscoverModels,
          "data-desktop-settings-action": "discoverModels",
          "data-desktop-settings-provider-action": "autoFetchModels",
          "aria-label": `Auto fetch models for ${selected?.id ?? options.pane.providerEditor.selectedProvider}`,
          onClick: () => requestProviderModelDiscovery(options, selected?.id ?? options.pane.providerEditor.selectedProvider),
        }, { default: () => "Auto fetch models" }),
      ]),
      h("div", { class: "desktop-settings-provider-model-list" }, options.pane.providerEditor.models.map((model) => h("span", {
        "data-desktop-settings-provider-model": model,
      }, model))),
      h("div", {
        class: "desktop-settings-provider-detail-actions",
        "aria-label": "Provider actions",
      }, [
        h(NButton, {
          size: "small",
          "data-desktop-settings-provider-command": "discoverModels",
          disabled: !options.pane.providerEditor.canDiscoverModels,
          onClick: () => requestProviderModelDiscovery(options, selected?.id ?? options.pane.providerEditor.selectedProvider),
        }, { default: () => "Discover models" }),
        h(NButton, {
          size: "small",
          "data-desktop-settings-provider-command": "editConnection",
          onClick: () => options.onFocusSettingsControl?.("apiBase"),
        }, { default: () => "Edit connection" }),
        h(NButton, {
          size: "small",
          "data-desktop-settings-provider-command": "useAsDefault",
          onClick: () => emitEdit(options, "provider", selected?.id ?? options.pane.providerEditor.selectedProvider),
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
      h(NButton, {
        size: "small",
        "data-desktop-settings-provider-action": "testConnection",
        onClick: () => options.onSettingsAction?.({
          action: "testProviderConnection",
          pane: options.pane,
          providerId: options.pane.providerEditor.selectedProvider,
        }),
      }, { default: () => "Test connection" }),
    ]),
  ]);
}

function renderProviderSetup(
  options: SettingsPaneIslandOptions,
  providerSetup: ProviderSetupState,
) {
  const providerId = providerSetup.providerId.trim();
  const profileName = providerSetup.profileName.trim() || providerId;
  const duplicate = providerId
    ? options.pane.providerCatalog.some((provider) => provider.id.toLowerCase() === providerId.toLowerCase())
    : false;
  const canCreate = Boolean(providerId) && !duplicate;
  return h("div", {
    class: "desktop-settings-provider-setup",
    "data-desktop-settings-provider-setup": "",
  }, [
    h("h3", "Add provider"),
    h("label", { class: "desktop-settings-inline-field" }, [
      h("span", "Provider ID"),
      h("input", {
        id: "desktop-settings-new-provider-id",
        "data-desktop-settings-control": "newProviderId",
        value: providerSetup.providerId,
        placeholder: "provider-id",
        "aria-describedby": "desktop-settings-provider-setup-guidance",
        onInput: (event: Event) => providerSetup.setProviderId(String((event.target as HTMLInputElement | null)?.value ?? "")),
      }),
    ]),
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
        value: providerSetup.providerId,
        onChange: (event: Event) => providerSetup.setProviderId(String((event.target as HTMLSelectElement | null)?.value ?? "")),
      }, ["openai", "deepseek", "anthropic", "ollama", "localai"].map((provider) => h("option", {
        value: provider,
        selected: providerSetup.providerId === provider ? "true" : undefined,
      }, provider))),
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
    h("p", {
      id: "desktop-settings-provider-setup-guidance",
      class: "desktop-settings-provider-setup-guidance",
    }, "Create a provider profile, then add API key and endpoint details below."),
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
          emitEdit(options, "selectedProvider", providerId);
          emitEdit(options, "profileId", profileName);
          emitEdit(options, "apiBase", providerSetup.endpoint.trim());
          emitEdit(options, "models", providerSetup.models.trim());
          if (providerSetup.useDefault) {
            emitEdit(options, "provider", providerId);
          }
          options.onFocusSettingsControl?.("selectedProvider");
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

function renderProviderCard(
  options: SettingsPaneIslandOptions,
  provider: ProviderCardModel,
) {
  return h(NCard, {
    class: "desktop-settings-provider-card",
    "data-desktop-settings-provider-card": provider.id,
    "data-selected": provider.badge ? "true" : undefined,
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
          onClick: () => emitEdit(options, "selectedProvider", provider.id),
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

function renderSingleSettingsGroup(groupNode: ReturnType<typeof renderSettingsGroup>) {
  return h("div", { class: "desktop-settings-grid" }, [groupNode]);
}

function renderSettingsGroup(
  options: SettingsPaneIslandOptions,
  group: DesktopSettingsPaneGroup,
  highlightedFieldId = "",
) {
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
      h("p", { class: "desktop-settings-group-description" }, getSettingsGroupDescription(group)),
      renderFilesWorkspaceActions(options, group),
      renderChannelsSummary(options, group),
      renderRuntimeSummary(options, group),
      renderDiagnosticsActionPage(options, group),
      renderMcpServerList(group),
      ...primaryFields.map((field) => renderSettingsField(options, group, field, highlightedFieldId)),
      advancedFields.length ? h("details", {
        class: "desktop-settings-advanced-fields",
        open: advancedFields.some((field) => field.id === highlightedFieldId) ? "" : undefined,
      }, [
        h("summary", "Advanced"),
        ...advancedFields.map((field) => renderSettingsField(options, group, field, highlightedFieldId)),
      ]) : null,
    ],
  });
}

function renderFilesWorkspaceActions(
  options: SettingsPaneIslandOptions,
  group: DesktopSettingsPaneGroup,
) {
  if (group.id !== "files-workspace") {
    return null;
  }
  const workspace = group.fields.find((field) => field.id === "workspace");
  const emit = (action: "chooseWorkspace" | "openWorkspace" | "openSessionFiles" | "openKnowledgeDocuments") => {
    options.onSettingsAction?.({ action, pane: options.pane });
  };
  return h("div", {
    class: "desktop-settings-files-actions",
    "aria-label": "Files and workspace actions",
  }, [
    h("p", {
      class: "desktop-settings-workspace-permission",
      "data-desktop-settings-workspace-permission": "",
    }, `Permission: ${workspace?.value ? "Configured workspace" : "No workspace selected"}`),
    h("button", {
      type: "button",
      "data-desktop-settings-file-action": "chooseWorkspace",
      onClick: () => emit("chooseWorkspace"),
    }, "Choose workspace"),
    h("button", {
      type: "button",
      "data-desktop-settings-file-action": "openWorkspace",
      onClick: () => emit("openWorkspace"),
    }, "Open workspace"),
    h("button", {
      type: "button",
      "data-desktop-settings-file-action": "openSessionFiles",
      onClick: () => emit("openSessionFiles"),
    }, "Session files"),
    h("button", {
      type: "button",
      "data-desktop-settings-file-action": "openKnowledgeDocuments",
      onClick: () => emit("openKnowledgeDocuments"),
    }, "Knowledge documents"),
  ]);
}

function renderChannelsSummary(
  options: SettingsPaneIslandOptions,
  group: DesktopSettingsPaneGroup,
) {
  if (group.id !== "channels") {
    return null;
  }
  return h("div", {
    class: "desktop-settings-channels-summary",
    "aria-label": "Channels behavior",
  }, [
    h("p", {
      "data-desktop-settings-channels-scope": "",
    }, "Global defaults apply to desktop channel behavior unless an integration provides its own override."),
    h("p", {
      "data-desktop-settings-channels-retry": "",
    }, "Max retries are additional attempts after the first delivery attempt."),
    h("p", {
      "data-desktop-settings-channels-empty": "",
    }, "No integration-specific overrides are configured yet."),
    h("button", {
      type: "button",
      "data-desktop-settings-channel-action": "setupIntegrations",
      onClick: () => options.onSettingsAction?.({ action: "setupChannelIntegrations", pane: options.pane }),
    }, "Set up integrations"),
  ]);
}

function renderDiagnosticsActionPage(
  options: SettingsPaneIslandOptions,
  group: DesktopSettingsPaneGroup,
) {
  if (group.id !== "logs-diagnostics" || !options.pane.diagnostics) {
    return null;
  }
  const diagnostics = options.pane.diagnostics;
  const emit = (
    action: "openDiagnosticsLogs" | "copyDiagnostics" | "exportDiagnosticsBundle" | "clearDiagnosticsLogs" | "resetLocalUiState",
  ) => {
    options.onSettingsAction?.({ action, pane: options.pane });
  };
  const actionButtons = [
    { action: "openDiagnosticsLogs" as const, key: "openLogs", label: "Open logs" },
    { action: "copyDiagnostics" as const, key: "copyRuntimeSummary", label: "Copy runtime summary" },
    { action: "exportDiagnosticsBundle" as const, key: "exportDiagnosticsBundle", label: "Export redacted diagnostics" },
    { action: "clearDiagnosticsLogs" as const, key: "clearLogs", label: "Clear logs" },
    { action: "resetLocalUiState" as const, key: "resetLocalUiState", label: "Reset local UI" },
  ];
  return h("div", {
    class: "desktop-settings-diagnostics-actions",
    "aria-label": "Diagnostics actions",
  }, [
    h("p", {
      "data-desktop-settings-diagnostics-runtime-summary": "",
    }, diagnostics.runtimeSummary),
    h("p", {
      "data-desktop-settings-diagnostics-gateway-ownership": "",
    }, diagnostics.gatewayOwnership),
    h("p", {
      "data-desktop-settings-diagnostics-version": "",
    }, diagnostics.version),
    h("p", {
      "data-desktop-settings-diagnostics-config-path": "",
    }, diagnostics.activeConfigPath),
    h("p", {
      "data-desktop-settings-diagnostics-config-error": "",
    }, diagnostics.lastConfigError),
    h("label", { class: "desktop-settings-inline-field" }, [
      h("span", "Log level"),
      h("select", {
        "data-desktop-settings-diagnostics-log-level": "",
        value: diagnostics.logLevel,
        onChange: (event: Event) => options.onSettingsAction?.({
          action: "setDiagnosticsLogLevel",
          pane: options.pane,
          logLevel: String((event.target as HTMLSelectElement | null)?.value ?? "info"),
        }),
      }, ["error", "info", "debug"].map((level) => h("option", {
        value: level,
        selected: diagnostics.logLevel === level ? "true" : undefined,
      }, level))),
    ]),
    h("div", { class: "desktop-settings-diagnostics-action-list" }, actionButtons.map((item) => h("button", {
      type: "button",
      "data-desktop-settings-diagnostics-action": item.key,
      onClick: () => emit(item.action),
    }, item.label))),
  ]);
}

function renderRuntimeSummary(
  options: SettingsPaneIslandOptions,
  group: DesktopSettingsPaneGroup,
) {
  if (group.id !== "gateway-runtime" || !options.pane.runtime) {
    return null;
  }
  const runtime = options.pane.runtime;
  const intents = [
    { id: "local-only", label: "Local only", host: "127.0.0.1" },
    { id: "local-network", label: "Local network", host: "0.0.0.0" },
    { id: "advanced-custom", label: "Advanced custom", host: null },
  ] as const;
  return h("div", {
    class: "desktop-settings-runtime-summary",
    "aria-label": "Runtime gateway controls",
  }, [
    h("div", { class: "desktop-settings-runtime-intents" }, intents.map((intent) => h("button", {
      type: "button",
      "data-desktop-settings-runtime-intent": intent.id,
      "data-active": runtime.intent === intent.id ? "true" : undefined,
      disabled: intent.host === null ? true : undefined,
      onClick: () => {
        if (intent.host !== null) {
          options.onSettingsAction?.({ action: "edit", pane: options.pane, fieldId: "host", value: intent.host });
        }
      },
    }, intent.label))),
    h("p", {
      "data-desktop-settings-runtime-current-endpoint": "",
    }, `Current endpoint: ${runtime.currentEndpoint}`),
    h("p", {
      "data-desktop-settings-runtime-pending-endpoint": "",
    }, `Pending endpoint after restart: ${runtime.pendingEndpoint}`),
    h("p", {
      "data-desktop-settings-runtime-port-status": "",
    }, runtime.portStatus),
    h("p", {
      "data-desktop-settings-runtime-heartbeat-dependency": "",
    }, runtime.heartbeatDependency),
  ]);
}

function renderMcpServerList(group: DesktopSettingsPaneGroup) {
  if (group.id !== "tools-approvals") {
    return null;
  }
  const mcpField = group.fields.find((field) => field.id === "mcpServers");
  const servers = parseMcpServerRows(mcpField?.inputValue ?? "");
  if (!servers.length) {
    return null;
  }
  return h("div", {
    class: "desktop-settings-mcp-server-list",
    "aria-label": "MCP servers",
  }, servers.map((server) => h("div", {
    class: "desktop-settings-mcp-server",
    "data-desktop-settings-mcp-server": server.name,
  }, [
    h("strong", server.name),
    h("span", server.transport),
    h("code", server.endpoint),
  ])));
}

function parseMcpServerRows(value: string): Array<{ name: string; transport: string; endpoint: string }> {
  try {
    const root = JSON.parse(value) as unknown;
    if (!root || typeof root !== "object" || Array.isArray(root)) {
      return [];
    }
    return Object.entries(root as Record<string, unknown>).map(([name, config]) => {
      const record = config && typeof config === "object" && !Array.isArray(config)
        ? config as Record<string, unknown>
        : {};
      const command = typeof record.command === "string" ? record.command : "";
      const url = typeof record.url === "string" ? record.url : "";
      return {
        name,
        transport: command ? "command" : url ? "url" : "unknown",
        endpoint: command || url || "Not configured",
      };
    });
  } catch {
    return [];
  }
}

function renderSettingsField(
  options: SettingsPaneIslandOptions,
  group: DesktopSettingsPaneGroup,
  field: DesktopSettingsPaneField,
  highlightedFieldId = "",
) {
  return h("div", {
    class: "desktop-settings-field",
    tabindex: field.id === highlightedFieldId ? -1 : undefined,
    "data-desktop-settings-field": field.id,
    "data-highlighted": field.id === highlightedFieldId ? "true" : undefined,
    "data-state": field.state,
    "data-persistent-path": field.persistentPath,
    "data-source-kind": field.sourceKind,
    "data-value-origin": field.valueOrigin,
    "data-apply-effect": field.applyEffect,
  }, [
    h("div", { class: "desktop-settings-field-copy" }, [
      h("label", { for: `desktop-settings-${field.id}` }, `${field.label}: `),
      h("span", { class: "desktop-settings-field-description" }, getSettingsFieldDescription(group.id, field)),
      renderSettingsFieldMeta(field),
      renderSettingsFieldNotice(field),
    ]),
    renderSettingsControl(options, field),
    renderSecretControls(options, field),
    renderSettingsFieldError(options.pane, field),
  ]);
}

function renderSettingsFieldNotice(field: DesktopSettingsPaneField) {
  if (!field.notice) {
    return null;
  }
  return h("span", {
    class: "desktop-settings-field-notice",
    "data-desktop-settings-field-notice": field.id,
  }, field.notice);
}

function renderSecretControls(
  options: SettingsPaneIslandOptions,
  field: DesktopSettingsPaneField,
) {
  if (!field.sensitive || field.control !== "password") {
    return null;
  }
  return h("div", { class: "desktop-settings-secret-controls" }, [
    h("p", {
      class: "desktop-settings-secret-policy",
      "data-desktop-settings-secret-policy": "",
    }, "Reveal is disabled by the desktop secret policy."),
    h("button", {
      type: "button",
      "data-desktop-settings-secret-action": "replace",
      onClick: () => document.getElementById(`desktop-settings-${field.id}`)?.focus(),
    }, "Replace key"),
    h("button", {
      type: "button",
      "data-desktop-settings-secret-action": "clear",
      onClick: () => emitEdit(options, field.id, ""),
    }, "Clear key"),
  ]);
}

function renderInlineField(
  options: SettingsPaneIslandOptions,
  field: DesktopSettingsPaneField,
) {
  return h("label", { class: "desktop-settings-inline-field" }, [
    h("span", field.label),
    field.id === "model"
      ? renderModelCombobox(options, field)
      : renderSettingsControl(options, field),
  ]);
}

function renderModelCombobox(options: SettingsPaneIslandOptions, field: DesktopSettingsPaneField) {
  const optionValues = field.options?.map((option) => option.value) ?? getDefaultLlmModelOptions(options.pane);
  const values = Array.from(new Set([field.inputValue, ...optionValues].filter(Boolean)));
  const listId = "desktop-settings-model-options";
  return [
    h("input", {
      id: `desktop-settings-${field.id}`,
      "data-desktop-settings-control": field.id,
      "data-state": field.state,
      "aria-invalid": field.state === "invalid" ? "true" : undefined,
      "aria-describedby": getSettingsFieldErrorId(options.pane, field),
      role: "combobox",
      list: listId,
      value: field.inputValue,
      placeholder: field.placeholder ?? "Enter model id",
      onInput: (event: Event) => emitEdit(options, field.id, String((event.target as HTMLInputElement | null)?.value ?? "")),
    }),
    h("datalist", { id: listId }, values.map((value) => h("option", { value }))),
  ];
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
    disabled: field.disabled ? true : undefined,
  };
  if (field.control === "checkbox") {
    const checked = Boolean(field.checked);
    const nextChecked = !checked;
    return h("button", {
      ...commonAttrs,
      type: "button",
      class: "desktop-settings-switch",
      role: "switch",
      "aria-checked": checked ? "true" : "false",
      "aria-label": `${field.label}: ${checked ? "On" : "Off"}`,
      "data-state": checked ? "on" : "off",
      "data-commit-mode": field.commitMode ?? "manual",
      onClick: () => handleSettingsSwitchChange(options, field, nextChecked),
    }, [
      h("span", { class: "desktop-settings-switch-track", "aria-hidden": "true" }, [
        h("span", { class: "desktop-settings-switch-thumb" }),
      ]),
      h("span", { class: "desktop-settings-switch-text" }, checked ? "On" : "Off"),
    ]);
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
  const validationField = field.validationField ?? settingsValidationFieldForControl(field.id);
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
  const chips = [
    h("span", { class: "desktop-settings-field-chip", "data-kind": field.requirement }, requirementLabel(field.requirement)),
    h("span", { class: "desktop-settings-field-chip", "data-kind": field.configurationMode }, configurationModeLabel(field.configurationMode)),
  ];
  if (field.sensitive) {
    chips.push(h("span", { class: "desktop-settings-field-chip", "data-kind": "sensitive" }, "Sensitive"));
  }
  if (field.sourceKind) {
    chips.push(h("span", { class: "desktop-settings-field-chip", "data-kind": field.sourceKind }, sourceKindLabel(field.sourceKind)));
  }
  if (field.valueOrigin) {
    chips.push(h("span", { class: "desktop-settings-field-chip", "data-kind": field.valueOrigin }, valueOriginLabel(field.valueOrigin)));
  }
  if (field.applyEffect) {
    chips.push(h("span", { class: "desktop-settings-field-chip", "data-kind": field.applyEffect }, applyEffectLabel(field.applyEffect)));
  }
  if (field.unit) {
    chips.push(h("span", { class: "desktop-settings-field-chip", "data-kind": "unit" }, field.unit));
  }
  if (field.recommendation) {
    chips.push(h("span", { class: "desktop-settings-field-chip", "data-kind": "recommendation" }, field.recommendation));
  }
  return h("span", { class: "desktop-settings-field-meta" }, chips);
}

function renderSaveButton(options: SettingsPaneIslandOptions) {
  if (!options.pane.dirty && !options.pane.save.canSave && options.pane.save.status !== "saving" && options.pane.save.status !== "failed") {
    return null;
  }
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

function requestProviderModelDiscovery(options: SettingsPaneIslandOptions, providerId: string): void {
  options.onSettingsAction?.({
    action: "discoverModels",
    pane: options.pane,
    providerId,
  });
}

function emitEdit(
  options: SettingsPaneIslandOptions,
  fieldId: string,
  value: string | boolean,
  commitMode?: DesktopSettingsPaneField["commitMode"],
): void {
  options.onSettingsAction?.({
    action: "edit",
    pane: options.pane,
    fieldId,
    value,
    commitMode,
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
      modelCountLabel: `${providerModels.length} ${providerModels.length === 1 ? "model" : "models"}`,
      sourceLabel: provider.profileId ? "Configured profile" : "Catalog",
    };
  });
}

function selectSettingsGroup(
  event: Event,
  groupId: DesktopSettingsPaneGroup["id"],
  setActiveGroupId?: (groupId: DesktopSettingsPaneGroup["id"]) => void,
): void {
  event.preventDefault();
  setActiveGroupId?.(groupId);
  const target = event.currentTarget;
  if (target instanceof HTMLElement) {
    closeSettingsLocalNavigationMenus(target.ownerDocument);
  }
}

function handleSettingsSwitchChange(
  options: SettingsPaneIslandOptions,
  field: DesktopSettingsPaneField,
  nextChecked: boolean,
): void {
  if (!confirmSettingsSwitchChange(field, nextChecked)) {
    return;
  }
  emitEdit(options, field.id, nextChecked, field.commitMode);
}

function confirmSettingsSwitchChange(field: DesktopSettingsPaneField, nextChecked: boolean): boolean {
  const confirmation = field.confirmation;
  if (!confirmation) {
    return true;
  }
  const matchesDirection = confirmation.when === "change"
    || (confirmation.when === "enable" && nextChecked)
    || (confirmation.when === "disable" && !nextChecked);
  if (!matchesDirection) {
    return true;
  }
  const confirm = globalThis.confirm;
  return typeof confirm === "function" ? confirm(confirmation.message) : true;
}

function closeSettingsLocalNavigationMenus(targetDocument: Document): void {
  for (const menu of targetDocument.querySelectorAll<HTMLDetailsElement>(".desktop-settings-local-nav-menu[open]")) {
    menu.removeAttribute("open");
  }
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
  const groups = getNavigableSettingsGroups(pane.groups);
  return groups.find((group) => group.id === activeGroupId) ?? groups[0] ?? null;
}

function getSettingsSearchResults(
  pane: DesktopSettingsPaneModel,
  query: string,
): SettingsSearchResult[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return [];
  }
  const results: Array<{ result: SettingsSearchResult; score: number }> = [];
  for (const group of getNavigableSettingsGroups(pane.groups)) {
    for (const field of group.fields) {
      const isSecret = field.sensitive || field.configurationMode === "secret";
      if (isSecret) {
        continue;
      }
      const fieldLabel = field.label.toLowerCase();
      const fieldId = field.id.toLowerCase();
      const haystack = [
        group.label,
        group.description ?? "",
        ...(group.aliases ?? []),
        field.label,
        field.description ?? getSettingsFieldDescription(group.id, field),
        ...(field.aliases ?? []),
        field.value,
        field.inputValue,
      ].join(" ").toLowerCase();
      if (!haystack.includes(normalizedQuery)) {
        continue;
      }
      const score = fieldLabel === normalizedQuery || fieldId === normalizedQuery
        ? 0
        : fieldLabel.includes(normalizedQuery) || fieldId.includes(normalizedQuery)
          ? 1
          : (field.aliases ?? []).some((alias) => alias.toLowerCase().includes(normalizedQuery))
            ? 2
            : 3;
      results.push({
        score,
        result: {
        key: `${group.id}.${field.id}`,
        groupId: group.id,
        groupLabel: group.label,
        fieldId: field.id,
        fieldLabel: field.label,
        description: field.description ?? "",
        advanced: field.advanced === true,
        },
      });
    }
  }
  return results
    .sort((left, right) => left.score - right.score)
    .slice(0, 8)
    .map((item) => item.result);
}

function getNavigableSettingsGroups(groups: DesktopSettingsPaneGroup[]): DesktopSettingsPaneGroup[] {
  return groups.filter((group) => (group.navigationMode ?? "section") === "section");
}

function getPreviewSettingsGroups(groups: DesktopSettingsPaneGroup[]): DesktopSettingsPaneGroup[] {
  return groups.filter((group) => group.navigationMode === "preview");
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

function navigationAreaLabel(area: NonNullable<DesktopSettingsPaneGroup["navigationArea"]>): string {
  return {
    core: "Core",
    application: "Application",
    system: "System",
  }[area];
}

function getSettingsGroupDescription(group: DesktopSettingsPaneGroup): string {
  if (group.description) {
    return group.description;
  }
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
  }[group.id];
}

function getSettingsFieldDescription(
  groupId: DesktopSettingsPaneGroup["id"],
  field: DesktopSettingsPaneField,
): string {
  if (field.description) {
    return field.description;
  }
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
  return descriptions[`${groupId}.${field.id}`] ?? `Current value: ${field.value || "Not configured"}.`;
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

function sourceKindLabel(sourceKind: NonNullable<DesktopSettingsPaneField["sourceKind"]>): string {
  return {
    config: "Local config",
    "local-ui-preference": "UI preference",
    cache: "Cache",
    "runtime-status": "Runtime status",
  }[sourceKind];
}

function valueOriginLabel(origin: NonNullable<DesktopSettingsPaneField["valueOrigin"]>): string {
  return {
    explicit: "Explicit value",
    default: "Default value",
    environment: "Environment value",
    secret: "Secret value",
    cache: "Cached value",
    runtime: "Runtime value",
    catalog: "Catalog value",
  }[origin];
}

function applyEffectLabel(effect: NonNullable<DesktopSettingsPaneField["applyEffect"]>): string {
  return {
    immediate: "Immediate",
    "gateway-restart": "Restart required",
    "workspace-reload": "Reload required",
  }[effect];
}
