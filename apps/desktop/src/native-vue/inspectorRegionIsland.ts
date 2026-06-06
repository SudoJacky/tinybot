import { createApp, defineComponent, h, onBeforeUnmount, onMounted, ref, type App } from "vue";
import type { DesktopRunChainItem } from "../desktopRunChainInspector";
import type { DesktopWorkLensActionId, DesktopWorkLensProjection } from "../desktopWorkLens";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";
import { mountRunChainInspectorIsland } from "./runChainInspectorIsland";
import { mountRunChainOverviewIsland, type RunChainOverviewIslandAction } from "./runChainOverviewIsland";
import { mountWorkLensIsland } from "./workLensIsland";
import { NCard, NConfigProvider } from "naive-ui";

export interface InspectorRegionWorkLensActionEvent {
  action: DesktopWorkLensActionId;
  workLens: DesktopWorkLensProjection;
}

export interface InspectorRegionIslandOptions {
  runChainItems: DesktopRunChainItem[];
  selectedRunChainItemKey?: string | null;
  workLens?: DesktopWorkLensProjection | null;
  onRunChainAction?: (action: RunChainOverviewIslandAction) => void;
  onRunChainItemSelected?: (item: DesktopRunChainItem) => void;
  onWorkLensAction?: (event: InspectorRegionWorkLensActionEvent) => void;
  copyText?: (text: string) => void | Promise<void>;
}

export interface MountedInspectorRegionIsland {
  unmount: () => void;
}

export function mountInspectorRegionIsland(
  host: HTMLElement,
  options: InspectorRegionIslandOptions,
): MountedInspectorRegionIsland {
  host.setAttribute("data-desktop-vue-island", "inspector-region");
  host.className = "desktop-inspector-content";

  const app = createInspectorRegionApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createInspectorRegionApp(options: InspectorRegionIslandOptions): App {
  return createApp(defineComponent({
    name: "InspectorRegionIsland",
    setup() {
      const mountedChildren: Array<{ unmount: () => void }> = [];
      const overview = ref<HTMLElement | null>(null);
      const lens = ref<HTMLElement | null>(null);
      const inspector = ref<HTMLElement | null>(null);

      onMounted(() => {
        mountChild(mountedChildren, overview.value, (host) => mountRunChainOverviewIsland(host, {
          items: options.runChainItems,
          onAction: options.onRunChainAction,
        }));
        if (options.workLens) {
          mountChild(mountedChildren, lens.value, (host) => mountWorkLensIsland(host, {
            workLens: options.workLens!,
            placement: "inspector",
            onAction: options.onWorkLensAction,
            copyText: options.copyText,
          }));
        } else if (options.runChainItems.length) {
          mountChild(mountedChildren, inspector.value, (host) => mountRunChainInspectorIsland(host, {
            eventTarget: host.ownerDocument,
            items: options.runChainItems,
            selectedItemKey: options.selectedRunChainItemKey,
            onSelect: options.onRunChainItemSelected,
          }));
        }
      });

      onBeforeUnmount(() => {
        while (mountedChildren.length) {
          mountedChildren.pop()?.unmount();
        }
      });

      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => h(NCard, {
          class: "desktop-inspector-content-card",
          size: "small",
          bordered: false,
        }, {
          default: () => [
            h("section", { ref: overview }),
            options.workLens
              ? h("section", { ref: lens })
              : options.runChainItems.length
                ? h("section", { ref: inspector })
                : null,
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
