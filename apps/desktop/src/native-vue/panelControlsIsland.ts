import { createApp, defineComponent, h, type App } from "vue";
import { NButton, NConfigProvider, NSpace } from "naive-ui";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export type PanelControlId = "sidebar" | "inspector" | "bottom";

export interface PanelControlItem {
  panel: PanelControlId;
  label: string;
  ariaLabel: string;
  visible: boolean;
  shortcut?: string;
}

export interface PanelControlsIslandOptions {
  controls: PanelControlItem[];
  onToggle?: (panel: PanelControlId) => void;
}

export interface MountedPanelControlsIsland {
  unmount: () => void;
}

export function mountPanelControlsIsland(
  host: HTMLElement,
  options: PanelControlsIslandOptions,
): MountedPanelControlsIsland {
  host.setAttribute("data-desktop-vue-island", "panel-controls");
  host.className = "desktop-panel-controls";
  host.setAttribute("aria-label", "Workbench panel controls");
  const app = createPanelControlsApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createPanelControlsApp(options: PanelControlsIslandOptions): App {
  return createApp(defineComponent({
    name: "PanelControlsIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => renderPanelControlsContent(options),
      });
    },
  }));
}

export function renderPanelControlsSurface(options: PanelControlsIslandOptions) {
  return h("div", {
    class: "desktop-panel-controls",
    "aria-label": "Workbench panel controls",
  }, renderPanelControlsContent(options));
}

export function renderPanelControlsContent(options: PanelControlsIslandOptions) {
  return h(NSpace, {
    class: "desktop-panel-controls-list",
    size: 8,
  }, {
    default: () => options.controls.map((control) => h(NButton, {
      class: "desktop-panel-control",
      type: control.visible ? "primary" : "default",
      secondary: true,
      "data-desktop-panel-control": control.panel,
      "aria-label": control.ariaLabel,
      "aria-pressed": String(control.visible),
      "aria-keyshortcuts": control.shortcut,
      onClick: () => options.onToggle?.(control.panel),
      onKeydown: (event: KeyboardEvent) => {
        if (event.key !== "Enter" && event.key !== " ") {
          return;
        }
        event.preventDefault();
        options.onToggle?.(control.panel);
      },
    }, { default: () => control.label })),
  });
}
