import { createApp, defineComponent, h, type App } from "vue";
import { NCard, NConfigProvider } from "naive-ui";
import type { DesktopSettingsPaneField, DesktopSettingsPaneGroup, DesktopSettingsPaneModel } from "../desktopSettingsProviders";
import type { DesktopSettingsActionEvent } from "../desktopWorkbenchShell";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export interface SettingsGroupsIslandOptions {
  pane: DesktopSettingsPaneModel;
  onSettingsAction?: (event: DesktopSettingsActionEvent) => void;
}

export interface MountedSettingsGroupsIsland {
  unmount: () => void;
}

export function mountSettingsGroupsIsland(
  host: HTMLElement,
  options: SettingsGroupsIslandOptions,
): MountedSettingsGroupsIsland {
  host.setAttribute("data-desktop-vue-island", "settings-groups");
  host.className = "desktop-settings-grid";
  const app = createSettingsGroupsApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createSettingsGroupsApp(options: SettingsGroupsIslandOptions): App {
  return createApp(defineComponent({
    name: "SettingsGroupsIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => options.pane.groups
          .map((group) => renderSettingsGroup(options, group))
          .filter(Boolean),
      });
    },
  }));
}

function renderSettingsGroup(options: SettingsGroupsIslandOptions, group: DesktopSettingsPaneGroup) {
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
  options: SettingsGroupsIslandOptions,
  group: DesktopSettingsPaneGroup,
  field: DesktopSettingsPaneField,
) {
  return h("div", {
    class: "desktop-settings-field",
    "data-desktop-settings-field": field.id,
    "data-state": field.state,
    "data-persistent-path": field.persistentPath,
    "data-source-kind": field.sourceKind,
    "data-value-origin": field.valueOrigin,
    "data-apply-effect": field.applyEffect,
  }, [
    h("div", { class: "desktop-settings-field-copy" }, [
      h("label", { for: `desktop-settings-${field.id}` }, `${field.label}: `),
      h("span", { class: "desktop-settings-field-description" }, getSettingsFieldDescription(group.id, field.id, field.value)),
      renderSettingsFieldMeta(field),
    ]),
    renderSettingsControl(options, field),
  ]);
}

function renderSettingsControl(options: SettingsGroupsIslandOptions, field: DesktopSettingsPaneField) {
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
    return h("select", {
      ...commonAttrs,
      value: field.inputValue,
      onChange: (event: Event) => emitEdit(options, field.id, String((event.target as HTMLSelectElement | null)?.value ?? "")),
    }, (field.options ?? []).map((option) => h("option", {
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

function renderSettingsFieldMeta(field: DesktopSettingsPaneField) {
  return h("span", { class: "desktop-settings-field-meta" }, [
    h("span", { class: "desktop-settings-field-chip", "data-kind": field.requirement }, requirementLabel(field.requirement)),
    h("span", { class: "desktop-settings-field-chip", "data-kind": field.configurationMode }, configurationModeLabel(field.configurationMode)),
    field.valueOrigin ? h("span", { class: "desktop-settings-field-chip", "data-kind": field.valueOrigin }, valueOriginLabel(field.valueOrigin)) : null,
    field.applyEffect ? h("span", { class: "desktop-settings-field-chip", "data-kind": field.applyEffect }, applyEffectLabel(field.applyEffect)) : null,
  ]);
}

function emitEdit(options: SettingsGroupsIslandOptions, fieldId: string, value: string | boolean): void {
  options.onSettingsAction?.({
    action: "edit",
    pane: options.pane,
    fieldId,
    value,
  });
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

function valueOriginLabel(origin: NonNullable<DesktopSettingsPaneField["valueOrigin"]>): string {
  return {
    explicit: "Explicit value",
    default: "Default value",
    secret: "Secret value",
    cache: "Cached value",
    runtime: "Runtime value",
    catalog: "Catalog value",
  }[origin];
}

function applyEffectLabel(effect: NonNullable<DesktopSettingsPaneField["applyEffect"]>): string {
  return {
    immediate: "Immediate",
    "gateway-restart": "Restart gateway",
    "workspace-reload": "Reload workspace",
  }[effect];
}
