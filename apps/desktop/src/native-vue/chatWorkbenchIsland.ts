import { createApp, defineComponent, h, type App } from "vue";
import { NConfigProvider, NText } from "naive-ui";
import type { DesktopTaskCenterItem } from "../desktopTaskCenter";
import { renderModuleWorkSectionSurface } from "./moduleWorkSectionIsland";
import { renderPanelControlsSurface, type PanelControlId, type PanelControlItem } from "./panelControlsIsland";
import { renderQuickActionsSurface } from "./quickActionsIsland";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export interface ChatWorkbenchIslandOptions {
  moduleWorkItems?: DesktopTaskCenterItem[];
  onInspectWorkItem?: (item: DesktopTaskCenterItem) => void;
  onPanelToggle?: (panel: PanelControlId) => void;
  panelControls: PanelControlItem[];
}

export interface MountedChatWorkbenchIsland {
  unmount: () => void;
}

export function mountChatWorkbenchIsland(
  host: HTMLElement,
  options: ChatWorkbenchIslandOptions,
): MountedChatWorkbenchIsland {
  host.setAttribute("data-desktop-vue-island", "chat-workbench");
  host.className = "desktop-chat-workbench-chrome";
  const app = createChatWorkbenchApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createChatWorkbenchApp(options: ChatWorkbenchIslandOptions): App {
  return createApp(defineComponent({
    name: "ChatWorkbenchIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => [
          h(NText, { tag: "span" }, { default: () => "Ready for a new session" }),
          h(NText, { depth: 3, tag: "span" }, { default: () => "Start from chat, inspect workspace, or check gateway status." }),
          renderQuickActionsSurface(),
          renderPanelControlsSurface({
            controls: options.panelControls,
            onToggle: options.onPanelToggle,
          }),
          ...(options.moduleWorkItems?.length
            ? [renderModuleWorkSectionSurface({
              title: "Chat runs",
              items: options.moduleWorkItems,
              onInspect: options.onInspectWorkItem,
            })]
            : []),
        ],
      });
    },
  }));
}
