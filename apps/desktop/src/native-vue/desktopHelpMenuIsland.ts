import { createApp, defineComponent, h, ref, type App } from "vue";
import { NButton, NConfigProvider, NText } from "naive-ui";
import type { DesktopMenuCommand, DesktopMenuCommandId } from "../desktopCommandNavigation";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

interface DesktopHelpMenuIslandOptions {
  commands: DesktopMenuCommand[];
  onCommand?: (id: DesktopMenuCommandId) => void;
}

export interface MountedDesktopHelpMenuIsland {
  unmount: () => void;
}

export function mountDesktopHelpMenuIsland(
  host: HTMLElement,
  options: DesktopHelpMenuIslandOptions,
): MountedDesktopHelpMenuIsland {
  applyDesktopHelpMenuHost(host);
  const app = createDesktopHelpMenuApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function applyDesktopHelpMenuHost(host: HTMLElement): void {
  host.className = "desktop-help-menu";
  host.setAttribute("data-desktop-vue-island", "desktop-help-menu");
}

function createDesktopHelpMenuApp(options: DesktopHelpMenuIslandOptions): App {
  return createApp(defineComponent({
    name: "DesktopHelpMenuIsland",
    setup() {
      const expanded = ref(false);
      const close = () => {
        expanded.value = false;
      };
      const toggle = () => {
        expanded.value = !expanded.value;
      };

      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => [
          h(NButton, {
            quaternary: true,
            size: "small",
            type: "button",
            class: "desktop-application-menu-item desktop-help-menu-trigger",
            "aria-haspopup": "menu",
            "aria-expanded": String(expanded.value),
            onPointerdown: (event: PointerEvent) => event.stopPropagation(),
            onDblclick: (event: MouseEvent) => event.stopPropagation(),
            onClick: (event: MouseEvent) => {
              event.stopPropagation();
              toggle();
            },
            onKeydown: (event: KeyboardEvent) => {
              if (event.key !== "Escape") {
                return;
              }
              event.preventDefault();
              close();
            },
          }, { default: () => "Help" }),
          h("div", {
            class: "desktop-help-menu-popover",
            role: "menu",
            "aria-label": "Help menu",
            hidden: !expanded.value,
          }, options.commands.map((command) => h(NButton, {
            key: command.id,
            quaternary: true,
            size: "small",
            type: "button",
            class: "desktop-help-menu-item",
            role: "menuitem",
            "data-desktop-menu-command": command.id,
            "aria-label": `${command.label} (${command.shortcut})`,
            title: `${command.label} (${command.shortcut})`,
            onPointerdown: (event: PointerEvent) => event.stopPropagation(),
            onDblclick: (event: MouseEvent) => event.stopPropagation(),
            onClick: (event: MouseEvent) => {
              event.stopPropagation();
              close();
              options.onCommand?.(command.id);
            },
          }, {
            default: () => [
              h(NText, { class: "desktop-help-menu-label", tag: "span" }, { default: () => command.label }),
              h(NText, { class: "desktop-help-menu-shortcut", depth: 3, tag: "span" }, { default: () => command.shortcut }),
            ],
          }))),
        ],
      });
    },
  }));
}
