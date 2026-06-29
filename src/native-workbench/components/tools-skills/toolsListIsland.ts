import { createApp, defineComponent, h, type App } from "vue";
import { NConfigProvider, NEmpty, NList, NListItem, NSpace, NTag } from "naive-ui";
import type { DesktopToolRow } from "../../tools-skills/desktopToolsSkills";
import { desktopNaiveThemeOverrides } from "../shell/desktopNaiveTheme";

export interface ToolsListIslandOptions {
  tools: DesktopToolRow[];
}

export interface MountedToolsListIsland {
  unmount: () => void;
}

export function mountToolsListIsland(
  host: HTMLElement,
  options: ToolsListIslandOptions,
): MountedToolsListIsland {
  host.setAttribute("data-desktop-vue-island", "tools-list");
  host.className = "desktop-tools-list";
  const app = createToolsListApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createToolsListApp(options: ToolsListIslandOptions): App {
  return createApp(defineComponent({
    name: "ToolsListIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => [
          h("h2", "Tools"),
          options.tools.length
            ? renderTools(options.tools)
            : h(NEmpty, {
              class: "desktop-tools-list-empty",
              description: "No tools loaded.",
              size: "small",
            }),
        ],
      });
    },
  }));
}

function renderTools(tools: DesktopToolRow[]) {
  return h(NList, { bordered: false, hoverable: true }, {
    default: () => tools.map((tool) => h(NListItem, {
      "data-desktop-entity-module": "tools",
      "data-desktop-entity-id": tool.name,
    }, {
      default: () => h(NSpace, { vertical: true, size: 4 }, {
        default: () => [
          h("span", `${tool.displayName}: ${tool.meta}`),
          h(NSpace, { size: 4, wrap: true }, {
            default: () => [
              h(NTag, { size: "small", round: true, type: tool.enabled ? "success" : "default" }, {
                default: () => tool.enabled ? "enabled" : "disabled",
              }),
              tool.configHint ? h(NTag, { size: "small", round: true, type: "warning" }, { default: () => tool.configHint }) : null,
            ],
          }),
        ],
      }),
    })),
  });
}
