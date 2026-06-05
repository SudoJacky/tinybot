import { createApp, defineComponent, h, ref, type App } from "vue";
import { NConfigProvider, NText } from "naive-ui";
import { isAgentUiFormSubmittable, type AgentUiForm, type AgentUiFormField } from "../agentUiEvents";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";
import { renderAgentUiFormActionsNode } from "./agentUiFormActionsIsland";
import { renderAgentUiFormFieldNode } from "./agentUiFormFieldIsland";

export interface AgentUiFormCardIslandOptions {
  form: AgentUiForm;
  onCancel?: (form: AgentUiForm) => void;
  onSubmit?: (form: AgentUiForm, values: Record<string, unknown>) => void;
}

export interface MountedAgentUiFormCardIsland {
  unmount: () => void;
}

export function mountAgentUiFormCardIsland(
  host: HTMLElement,
  options: AgentUiFormCardIslandOptions,
): MountedAgentUiFormCardIsland {
  host.setAttribute("data-desktop-vue-island", "agent-ui-form-card");
  host.className = "desktop-agent-ui-form-card";
  host.setAttribute("data-agent-ui-form-id", options.form.form_id);
  host.setAttribute("data-agent-ui-form-status", options.form.status ?? "pending");
  const app = createAgentUiFormCardApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createAgentUiFormCardApp(options: AgentUiFormCardIslandOptions): App {
  return createApp(defineComponent({
    name: "AgentUiFormCardIsland",
    setup() {
      const formHost = ref<HTMLElement | null>(null);
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => [
          h("h2", options.form.title || options.form.form_id),
          h(NText, { class: "desktop-agent-ui-form-status", tag: "p" }, { default: () => options.form.status ?? "pending" }),
          options.form.description ? h(NText, { tag: "p" }, { default: () => options.form.description }) : null,
          h("form", {
            ref: formHost,
            class: "desktop-agent-ui-form",
            "data-agent-ui-form-id": options.form.form_id,
          }, [
            ...options.form.fields.map((field) => renderAgentUiFormFieldNode({
              disabled: !isAgentUiFormSubmittable(options.form),
              error: options.form.errors?.[field.name],
              field,
              value: agentUiFieldValue(options.form, field),
            })),
            options.form.errors?.form
              ? h(NText, { class: "desktop-agent-ui-form-error", tag: "p", type: "error" }, { default: () => options.form.errors?.form ?? "" })
              : null,
            isAgentUiFormSubmittable(options.form)
              ? renderAgentUiFormActionsNode({
                cancelLabel: options.form.cancel_label || "Cancel",
                onCancel: () => options.onCancel?.(options.form),
                onSubmit: () => options.onSubmit?.(options.form, collectAgentUiFormValues(options.form, formHost.value)),
                submitLabel: options.form.submit_label || "Submit",
              })
              : null,
          ]),
        ],
      });
    },
  }));
}

function agentUiFieldValue(form: AgentUiForm, field: AgentUiFormField): unknown {
  return form.values?.[field.name] ?? form.initial_values?.[field.name] ?? field.default ?? "";
}

function collectAgentUiFormValues(form: AgentUiForm, formElement: HTMLElement | null): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  if (!formElement) {
    return values;
  }
  for (const field of form.fields) {
    const control = formElement.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`[data-agent-ui-form-field="${field.name}"]`);
    if (!control) {
      continue;
    }
    if (field.type === "checkbox") {
      values[field.name] = (control as HTMLInputElement).checked === true;
    } else if (field.type === "number") {
      const numeric = Number(control.value);
      values[field.name] = Number.isFinite(numeric) ? numeric : control.value;
    } else {
      values[field.name] = control.value;
    }
  }
  return values;
}
