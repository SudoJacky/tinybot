import { createApp, defineComponent, h, type App } from "vue";
import { NCard, NConfigProvider } from "naive-ui";
import type { DesktopSettingsPaneField, DesktopSettingsPaneModel } from "../desktopSettingsProviders";
import type { DesktopSettingsActionEvent } from "../desktopWorkbenchShell";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export interface SettingsDefaultLlmIslandOptions {
  pane: DesktopSettingsPaneModel;
  onSettingsAction?: (event: DesktopSettingsActionEvent) => void;
}

export interface MountedSettingsDefaultLlmIsland {
  unmount: () => void;
}

export function mountSettingsDefaultLlmIsland(
  host: HTMLElement,
  options: SettingsDefaultLlmIslandOptions,
): MountedSettingsDefaultLlmIsland {
  host.setAttribute("data-desktop-vue-island", "settings-default-llm");
  host.className = "desktop-settings-default-llm-card";
  host.setAttribute("aria-label", "Default LLM settings");
  const app = createSettingsDefaultLlmApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createSettingsDefaultLlmApp(options: SettingsDefaultLlmIslandOptions): App {
  return createApp(defineComponent({
    name: "SettingsDefaultLlmIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => h(NCard, { size: "small", bordered: false }, {
          default: () => renderDefaultLlmCard(options),
        }),
      });
    },
  }));
}

function renderDefaultLlmCard(options: SettingsDefaultLlmIslandOptions) {
  const provider = findPaneField(options.pane, "provider", "selectedProvider");
  const model = findPaneField(options.pane, "agent", "model");
  return [
    h("div", { class: "desktop-settings-card-heading" }, [
      h("h2", "Default LLM"),
    ]),
    h("div", { class: "desktop-settings-default-llm-form" }, [
      provider ? renderInlineField(options, provider, "Provider") : null,
      model ? renderInlineField(options, model, "Model") : null,
      renderSaveButton(options),
    ]),
    h("p", { class: "desktop-settings-default-llm-copy" }, "Configure the global default LLM model. Individual agents can still choose a different model."),
  ];
}

function renderInlineField(
  options: SettingsDefaultLlmIslandOptions,
  field: DesktopSettingsPaneField,
  label: string,
) {
  return h("label", { class: "desktop-settings-inline-field" }, [
    h("span", label),
    field.id === "model" && options.pane.providerEditor.models.length > 0
      ? renderModelSelect(options, field)
      : renderControl(options, field),
  ]);
}

function renderModelSelect(options: SettingsDefaultLlmIslandOptions, field: DesktopSettingsPaneField) {
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

function renderControl(options: SettingsDefaultLlmIslandOptions, field: DesktopSettingsPaneField) {
  if (field.control === "select") {
    const values = field.options?.length ? field.options : [{ value: field.inputValue, label: field.inputValue }];
    return h("select", {
      id: `desktop-settings-${field.id}`,
      "data-desktop-settings-control": field.id,
      "data-state": field.state,
      "aria-invalid": field.state === "invalid" ? "true" : undefined,
      value: field.inputValue,
      onChange: (event: Event) => emitEdit(options, field.id, String((event.target as HTMLSelectElement | null)?.value ?? "")),
    }, values.map((option) => h("option", {
      value: option.value,
      selected: option.value === field.inputValue ? "true" : undefined,
    }, option.label)));
  }
  return h("input", {
    id: `desktop-settings-${field.id}`,
    "data-desktop-settings-control": field.id,
    "data-state": field.state,
    "aria-invalid": field.state === "invalid" ? "true" : undefined,
    type: "text",
    value: field.inputValue,
    onInput: (event: Event) => emitEdit(options, field.id, String((event.target as HTMLInputElement | null)?.value ?? "")),
  });
}

function renderSaveButton(options: SettingsDefaultLlmIslandOptions) {
  return h("button", {
    class: "desktop-settings-save-status-button",
    type: "button",
    "data-desktop-settings-action": "save",
    disabled: !options.pane.save.canSave,
    onClick: () => options.onSettingsAction?.({ action: "save", pane: options.pane }),
  }, saveLabel(options.pane));
}

function emitEdit(options: SettingsDefaultLlmIslandOptions, fieldId: string, value: string | boolean): void {
  options.onSettingsAction?.({
    action: "edit",
    pane: options.pane,
    fieldId,
    value,
  });
}

function findPaneField(
  pane: DesktopSettingsPaneModel,
  groupId: DesktopSettingsPaneModel["groups"][number]["id"],
  fieldId: string,
): DesktopSettingsPaneField | null {
  return pane.groups.find((group) => group.id === groupId)?.fields.find((field) => field.id === fieldId) ?? null;
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
