import { createApp, defineComponent, h, type App } from "vue";
import { NConfigProvider } from "naive-ui";
import type { GatewayRuntimeIslandActionEvent } from "./gatewayRuntimeIsland";
import { renderGatewayRuntimeSurface } from "./gatewayRuntimeIsland";
import type { TaskCenterIslandActionEvent } from "./taskCenterIsland";
import { renderTaskCenterSurface } from "./taskCenterIsland";
import type { GatewayRuntimeStatus } from "../desktopGatewayStartup";
import type { DesktopTaskCenterItem } from "../desktopTaskCenter";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export interface BottomRegionIslandOptions {
  gatewayHttp: string;
  gatewayStatus: GatewayRuntimeStatus | null;
  taskItems: DesktopTaskCenterItem[];
  onGatewayAction?: (event: GatewayRuntimeIslandActionEvent) => void;
  onTaskAction?: (event: TaskCenterIslandActionEvent) => void;
}

export interface MountedBottomRegionIsland {
  unmount: () => void;
}

export function mountBottomRegionIsland(
  host: HTMLElement,
  options: BottomRegionIslandOptions,
): MountedBottomRegionIsland {
  host.setAttribute("data-desktop-vue-island", "bottom-region");
  host.className = "desktop-bottom-content";
  const app = createBottomRegionApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createBottomRegionApp(options: BottomRegionIslandOptions): App {
  return createApp(defineComponent({
    name: "BottomRegionIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => [
          renderTaskCenterSurface({
            items: options.taskItems,
            onAction: options.onTaskAction,
          }),
          renderGatewayRuntimeSurface({
            gatewayHttp: options.gatewayHttp,
            status: options.gatewayStatus,
            onAction: options.onGatewayAction,
          }),
        ],
      });
    },
  }));
}
