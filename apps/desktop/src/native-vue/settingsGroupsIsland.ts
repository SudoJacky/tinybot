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
  options: SettingsGroupsIslandOptions,
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

function renderSettingsControl(options: SettingsGroupsIslandOptions, field: DesktopSettingsPaneField) {
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
    type: field.control === "number" ? "number" : "text",
    value: field.inputValue,
    onInput: (event: Event) => emitEdit(options, field.id, String((event.target as HTMLInputElement | null)?.value ?? "")),
  });
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
