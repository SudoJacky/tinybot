import { createApp, defineComponent, h, onBeforeUnmount, onMounted, ref, type App } from "vue";
import { NCard, NConfigProvider } from "naive-ui";
import type { GatewayRuntimeIslandActionEvent } from "../gateway/gatewayRuntimeIsland";
import { mountGatewayRuntimeIsland } from "../gateway/gatewayRuntimeIsland";
import type { TaskCenterIslandActionEvent } from "../tasks/taskCenterIsland";
import { mountTaskCenterIsland } from "../tasks/taskCenterIsland";
import type { GatewayRuntimeStatus } from "../../gateway/desktopGatewayStartup";
import type { DesktopTaskCenterItem } from "../../tasks/desktopTaskCenter";
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
      const mountedChildren: Array<{ unmount: () => void }> = [];
      const taskCenter = ref<HTMLElement | null>(null);
      const gatewayRuntime = ref<HTMLElement | null>(null);

      onMounted(() => {
        mountChild(mountedChildren, taskCenter.value, (host) => mountTaskCenterIsland(host, {
          items: options.taskItems,
          onAction: options.onTaskAction,
        }));
        mountChild(mountedChildren, gatewayRuntime.value, (host) => mountGatewayRuntimeIsland(host, {
          gatewayHttp: options.gatewayHttp,
          status: options.gatewayStatus,
          onAction: options.onGatewayAction,
        }));
      });

      onBeforeUnmount(() => {
        while (mountedChildren.length) {
          mountedChildren.pop()?.unmount();
        }
      });

      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => h(NCard, {
          class: "desktop-bottom-content-card",
          size: "small",
          bordered: false,
        }, {
          default: () => [
            h("section", { ref: taskCenter }),
            h("section", { ref: gatewayRuntime }),
          ],
        }),
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
