import { createApp, defineComponent, h, type App } from "vue";
import { NButton, NConfigProvider, NSpace } from "naive-ui";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export interface AgentUiFormActionsIslandOptions {
  cancelLabel?: string;
  onCancel?: () => void;
  onSubmit?: () => void;
  submitLabel?: string;
}

export interface MountedAgentUiFormActionsIsland {
  unmount: () => void;
}

export function mountAgentUiFormActionsIsland(
  host: HTMLElement,
  options: AgentUiFormActionsIslandOptions,
): MountedAgentUiFormActionsIsland {
  host.setAttribute("data-desktop-vue-island", "agent-ui-form-actions");
  host.className = "desktop-agent-ui-form-actions";
  const app = createAgentUiFormActionsApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createAgentUiFormActionsApp(options: AgentUiFormActionsIslandOptions): App {
  return createApp(defineComponent({
    name: "AgentUiFormActionsIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => renderAgentUiFormActionsChildren(options),
      });
    },
  }));
}

export function renderAgentUiFormActionsNode(options: AgentUiFormActionsIslandOptions) {
  return h("div", { class: "desktop-agent-ui-form-actions" }, renderAgentUiFormActionsChildren(options));
}

export function renderAgentUiFormActionsChildren(options: AgentUiFormActionsIslandOptions) {
  return h(NSpace, { size: 8 }, {
    default: () => [
      h(NButton, {
        "data-agent-ui-form-action": "submit",
        secondary: true,
        size: "small",
        type: "primary",
        onClick: () => options.onSubmit?.(),
      }, { default: () => options.submitLabel || "Submit" }),
      h(NButton, {
        "data-agent-ui-form-action": "cancel",
        secondary: true,
        size: "small",
        onClick: () => options.onCancel?.(),
      }, { default: () => options.cancelLabel || "Cancel" }),
    ],
  });
}
