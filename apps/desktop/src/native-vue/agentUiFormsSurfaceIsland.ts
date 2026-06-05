import { createApp, defineComponent, h, type App } from "vue";
import { NConfigProvider, NEmpty } from "naive-ui";
import type { AgentUiForm } from "../agentUiEvents";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";
import { renderAgentUiFormCardNode } from "./agentUiFormCardIsland";

export interface AgentUiFormsSurfaceIslandOptions {
  forms: AgentUiForm[];
  onCancel?: (form: AgentUiForm) => void;
  onSubmit?: (form: AgentUiForm, values: Record<string, unknown>) => void;
}

export interface MountedAgentUiFormsSurfaceIsland {
  unmount: () => void;
}

export function mountAgentUiFormsSurfaceIsland(
  host: HTMLElement,
  options: AgentUiFormsSurfaceIslandOptions,
): MountedAgentUiFormsSurfaceIsland {
  host.setAttribute("data-desktop-vue-island", "agent-ui-forms-surface");
  host.className = "desktop-workbench-section desktop-agent-ui-forms";
  host.setAttribute("data-desktop-module-surface", "chat");
  host.setAttribute("aria-label", "Agent UI forms");
  const app = createAgentUiFormsSurfaceApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createAgentUiFormsSurfaceApp(options: AgentUiFormsSurfaceIslandOptions): App {
  return createApp(defineComponent({
    name: "AgentUiFormsSurfaceIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => [
          h("h2", "Agent UI forms"),
          options.forms.length
            ? options.forms.map((form) => renderAgentUiFormCardNode({
              form,
              onCancel: options.onCancel,
              onSubmit: options.onSubmit,
            }))
            : h(NEmpty, { description: "No pending Agent UI forms." }),
        ],
      });
    },
  }));
}
