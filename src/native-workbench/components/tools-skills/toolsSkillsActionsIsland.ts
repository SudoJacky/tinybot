import { createApp, defineComponent, h, type App } from "vue";
import { NButton, NConfigProvider, NSpace } from "naive-ui";
import { desktopNaiveThemeOverrides } from "../shell/desktopNaiveTheme";

export type ToolsSkillsActionId = "createSkill" | "saveSkill" | "validateSkill" | "deleteSkill" | "toggleAlways";

export interface ToolsSkillsActionItem {
  action: ToolsSkillsActionId;
  label: string;
  enabled: boolean;
}

export interface ToolsSkillsActionsIslandOptions {
  actions: ToolsSkillsActionItem[];
  onAction?: (action: ToolsSkillsActionId) => void;
}

export interface MountedToolsSkillsActionsIsland {
  unmount: () => void;
}

export function mountToolsSkillsActionsIsland(
  host: HTMLElement,
  options: ToolsSkillsActionsIslandOptions,
): MountedToolsSkillsActionsIsland {
  host.setAttribute("data-desktop-vue-island", "tools-skills-actions");
  host.className = "desktop-tools-skills-actions";
  const app = createToolsSkillsActionsApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createToolsSkillsActionsApp(options: ToolsSkillsActionsIslandOptions): App {
  return createApp(defineComponent({
    name: "ToolsSkillsActionsIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => h(NSpace, { size: 8, wrap: true }, {
          default: () => options.actions.map((item) => h(NButton, {
            "data-desktop-tools-skills-action": item.action,
            disabled: !item.enabled,
            secondary: true,
            size: "small",
            type: actionButtonType(item.action),
            onClick: () => {
              if (item.enabled) {
                options.onAction?.(item.action);
              }
            },
          }, { default: () => item.label })),
        }),
      });
    },
  }));
}

function actionButtonType(action: ToolsSkillsActionId): "default" | "error" | "primary" {
  if (action === "deleteSkill") {
    return "error";
  }
  if (action === "saveSkill" || action === "createSkill") {
    return "primary";
  }
  return "default";
}
