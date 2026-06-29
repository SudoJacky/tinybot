import { createApp, defineComponent, h, type App } from "vue";
import { NConfigProvider, NText } from "naive-ui";
import type { AgentUiFormField } from "../../agent-ui/agentUiEvents";
import { desktopNaiveThemeOverrides } from "../shell/desktopNaiveTheme";

export interface AgentUiFormFieldIslandOptions {
  disabled: boolean;
  error?: string;
  field: AgentUiFormField;
  value: unknown;
}

export interface MountedAgentUiFormFieldIsland {
  unmount: () => void;
}

export function mountAgentUiFormFieldIsland(
  host: HTMLElement,
  options: AgentUiFormFieldIslandOptions,
): MountedAgentUiFormFieldIsland {
  host.setAttribute("data-desktop-vue-island", "agent-ui-form-field");
  host.className = "desktop-agent-ui-form-field";
  const app = createAgentUiFormFieldApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createAgentUiFormFieldApp(options: AgentUiFormFieldIslandOptions): App {
  return createApp(defineComponent({
    name: "AgentUiFormFieldIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => renderAgentUiFormFieldChildren(options),
      });
    },
  }));
}

export function renderAgentUiFormFieldNode(options: AgentUiFormFieldIslandOptions) {
  return h("label", { class: "desktop-agent-ui-form-field" }, renderAgentUiFormFieldChildren(options));
}

export function renderAgentUiFormFieldChildren(options: AgentUiFormFieldIslandOptions) {
  return [
    h(NText, { tag: "span" }, { default: () => options.field.label || options.field.name }),
    renderControl(options),
    options.field.help ? h(NText, { depth: 3, tag: "span" }, { default: () => options.field.help }) : null,
    options.error ? h(NText, { class: "desktop-agent-ui-form-error", tag: "span", type: "error" }, { default: () => options.error }) : null,
  ];
}

export function renderControl(options: AgentUiFormFieldIslandOptions) {
  const field = options.field;
  const value = options.value ?? "";
  const shared = {
    "data-agent-ui-form-field": field.name,
    disabled: options.disabled,
    name: field.name,
  };
  if (field.type === "textarea") {
    return h("textarea", {
      ...shared,
      value: String(value),
    });
  }
  if (field.type === "select" || field.type === "radio") {
    return h("select", {
      ...shared,
      value: String(value),
    }, (field.options ?? []).map((option) => h("option", {
      selected: String(option.value) === String(value),
      value: String(option.value),
    }, option.label)));
  }
  return h("input", {
    ...shared,
    checked: field.type === "checkbox" ? value === true : undefined,
    type: field.type === "checkbox" ? "checkbox" : field.type === "number" ? "number" : "text",
    value: field.type === "checkbox" ? undefined : String(value),
  });
}
