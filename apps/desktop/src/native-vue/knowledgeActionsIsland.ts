import { createApp, defineComponent, h, type App } from "vue";
import { NButton, NConfigProvider, NSpace } from "naive-ui";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export type KnowledgeActionId = "runQuery" | "refreshGraph" | "rebuildIndex" | "deleteDocument" | "uploadDocument";

export interface KnowledgeActionItem {
  action: KnowledgeActionId;
  label: string;
  enabled: boolean;
}

export interface KnowledgeActionsIslandOptions {
  actions: KnowledgeActionItem[];
  onAction?: (action: KnowledgeActionId) => void;
}

export interface MountedKnowledgeActionsIsland {
  unmount: () => void;
}

export function mountKnowledgeActionsIsland(
  host: HTMLElement,
  options: KnowledgeActionsIslandOptions,
): MountedKnowledgeActionsIsland {
  host.setAttribute("data-desktop-vue-island", "knowledge-actions");
  host.className = "desktop-knowledge-actions";
  const app = createKnowledgeActionsApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createKnowledgeActionsApp(options: KnowledgeActionsIslandOptions): App {
  return createApp(defineComponent({
    name: "KnowledgeActionsIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => h(NSpace, { size: 8, wrap: true }, {
          default: () => options.actions.map((item) => h(NButton, {
            "data-desktop-knowledge-action": item.action,
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

function actionButtonType(action: KnowledgeActionId): "default" | "error" | "primary" | "warning" {
  if (action === "deleteDocument") {
    return "error";
  }
  if (action === "rebuildIndex") {
    return "warning";
  }
  if (action === "uploadDocument" || action === "runQuery") {
    return "primary";
  }
  return "default";
}
