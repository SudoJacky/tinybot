import { createApp, defineComponent, h, type App } from "vue";
import { NButton, NConfigProvider } from "naive-ui";
import type { DesktopMenuCommand, DesktopMenuCommandId } from "../desktopCommandNavigation";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

interface DesktopAppMenuCommandIslandOptions {
  command: DesktopMenuCommand;
  onCommand?: (id: DesktopMenuCommandId) => void;
}

export interface MountedDesktopAppMenuCommandIsland {
  unmount: () => void;
}

export function mountDesktopAppMenuCommandIsland(
  host: HTMLElement,
  options: DesktopAppMenuCommandIslandOptions,
): MountedDesktopAppMenuCommandIsland {
  applyDesktopAppMenuCommandHost(host, options.command);
  const app = createDesktopAppMenuCommandApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function applyDesktopAppMenuCommandHost(host: HTMLElement, command: DesktopMenuCommand): void {
  host.className = "desktop-application-menu-command";
  host.setAttribute("data-desktop-vue-island", "desktop-app-menu-command");
  host.setAttribute("data-desktop-menu-command-host", command.id);
}

function createDesktopAppMenuCommandApp(options: DesktopAppMenuCommandIslandOptions): App {
  return createApp(defineComponent({
    name: "DesktopAppMenuCommandIsland",
    setup() {
      const command = options.command;
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => h(NButton, {
          quaternary: true,
          size: "small",
          type: "button",
          class: "desktop-application-menu-item",
          "data-desktop-menu-command": command.id,
          "aria-label": `${command.label} (${command.shortcut})`,
          title: `${command.label} (${command.shortcut})`,
          onPointerdown: (event: PointerEvent) => event.stopPropagation(),
          onDblclick: (event: MouseEvent) => event.stopPropagation(),
          onClick: (event: MouseEvent) => {
            event.stopPropagation();
            options.onCommand?.(command.id);
          },
        }, { default: () => command.chromeLabel ?? command.label }),
      });
    },
  }));
}
