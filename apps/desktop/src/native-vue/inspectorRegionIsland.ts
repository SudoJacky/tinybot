import { createApp, defineComponent, h, type App } from "vue";
import type { DesktopRunChainItem } from "../desktopRunChainInspector";
import type { DesktopWorkLensActionId, DesktopWorkLensProjection } from "../desktopWorkLens";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";
import { renderRunChainOverviewSurface, type RunChainOverviewIslandAction } from "./runChainOverviewIsland";
import { renderRunChainInspectorSurface } from "./runChainInspectorIsland";
import { renderWorkLensSurface } from "./workLensIsland";
import { NConfigProvider } from "naive-ui";

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
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => [
          renderRunChainOverviewSurface({
            items: options.runChainItems,
            onAction: options.onRunChainAction,
          }),
          options.workLens
            ? renderWorkLensSurface({
              workLens: options.workLens,
              placement: "inspector",
              onAction: options.onWorkLensAction,
              copyText: options.copyText,
            })
            : options.runChainItems.length
              ? renderRunChainInspectorSurface({
                items: options.runChainItems,
                selectedItemKey: options.selectedRunChainItemKey,
                onSelect: options.onRunChainItemSelected,
              })
              : null,
        ],
      });
    },
  }));
}
