import { createApp, defineComponent, h, onBeforeUnmount, onMounted, ref, type App } from "vue";
import { NConfigProvider, NEmpty } from "naive-ui";
import type { AgentUiForm } from "../../agent-ui/agentUiEvents";
import { desktopNaiveThemeOverrides } from "../shell/desktopNaiveTheme";
import { mountAgentUiFormCardIsland } from "./agentUiFormCardIsland";

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
      const mountedChildren: Array<{ unmount: () => void }> = [];
      const formHosts = ref<Array<HTMLElement | null>>([]);

      onMounted(() => {
        options.forms.forEach((form, index) => {
          mountChild(mountedChildren, formHosts.value[index] ?? null, (host) => mountAgentUiFormCardIsland(host, {
            form,
            onCancel: options.onCancel,
            onSubmit: options.onSubmit,
          }));
        });
      });

      onBeforeUnmount(() => {
        while (mountedChildren.length) {
          mountedChildren.pop()?.unmount();
        }
      });

      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => [
          h("h2", "Agent UI forms"),
          options.forms.length
            ? options.forms.map((form, index) => h("article", {
              ref: (element) => {
                formHosts.value[index] = element as HTMLElement | null;
              },
              "data-agent-ui-form-id": form.form_id,
            }))
            : h(NEmpty, { description: "No pending Agent UI forms." }),
        ],
      });
    },
  }));
}

function mountChild<T extends { unmount: () => void }>(
  mountedChildren: Array<{ unmount: () => void }>,
  host: HTMLElement | null,
  mount: (host: HTMLElement) => T,
): void {
  if (!host) {
    return;
  }
  mountedChildren.push(mount(host));
}
