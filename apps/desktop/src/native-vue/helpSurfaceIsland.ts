import { createApp, defineComponent, h, type App } from "vue";
import { NButton, NCard, NConfigProvider, NSpace } from "naive-ui";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export type HelpSurfaceAction = "shortcut-help" | "page-help" | "backend-logs" | "help-tour";

export interface HelpSurfaceIslandOptions {
  onAction?: (action: HelpSurfaceAction) => void;
}

export interface MountedHelpSurfaceIsland {
  unmount: () => void;
}

export function mountHelpSurfaceIsland(
  host: HTMLElement,
  options: HelpSurfaceIslandOptions,
): MountedHelpSurfaceIsland {
  host.setAttribute("data-desktop-vue-island", "help-surface");
  host.className = "desktop-help-pane";
  host.setAttribute("data-desktop-module-surface", "docs");
  host.setAttribute("aria-label", "Desktop help");
  const app = createHelpSurfaceApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createHelpSurfaceApp(options: HelpSurfaceIslandOptions): App {
  return createApp(defineComponent({
    name: "HelpSurfaceIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => h(NCard, {
          bordered: false,
          embedded: true,
          contentStyle: "padding: 0;",
        }, {
          default: () => [
            h("h2", "Help"),
            h(NSpace, {
              class: "desktop-help-actions",
              vertical: true,
              size: 8,
            }, {
              default: () => [
                h("a", {
                  class: "desktop-help-action",
                  "data-desktop-help-action": "docs",
                  href: "/docs",
                }, "Open docs"),
                renderHelpButton("shortcut-help", "Shortcut help", options),
                renderHelpButton("page-help", "Page help", options),
                renderHelpButton("backend-logs", "Backend logs", options),
                renderHelpButton("help-tour", "Help tour", options),
              ],
            }),
          ],
        }),
      });
    },
  }));
}

function renderHelpButton(
  action: HelpSurfaceAction,
  label: string,
  options: HelpSurfaceIslandOptions,
) {
  return h(NButton, {
    class: "desktop-help-action",
    "data-desktop-help-action": action,
    type: action === "help-tour" ? "primary" : "default",
    secondary: action !== "help-tour",
    onClick: () => options.onAction?.(action),
  }, { default: () => label });
}
