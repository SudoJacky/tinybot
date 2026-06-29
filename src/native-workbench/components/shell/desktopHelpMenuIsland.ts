import { createApp, defineComponent, h, onBeforeUnmount, onMounted, ref, type App } from "vue";
import { NButton, NConfigProvider, NText } from "naive-ui";
import type { DesktopMenuCommand, DesktopMenuCommandId } from "../../command/desktopCommandNavigation";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

interface DesktopHelpMenuIslandOptions {
  label?: string;
  menuLabel?: string;
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
  applyDesktopHelpMenuHost(host, options.label ?? "Help");
  const app = createDesktopHelpMenuApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function applyDesktopHelpMenuHost(host: HTMLElement, label: string): void {
  host.className = `desktop-help-menu desktop-${label.toLowerCase()}-menu`;
  host.setAttribute("data-desktop-vue-island", "desktop-help-menu");
  host.setAttribute("data-desktop-menu-label", label);
}

function createDesktopHelpMenuApp(options: DesktopHelpMenuIslandOptions): App {
  return createApp(defineComponent({
    name: "DesktopHelpMenuIsland",
    setup() {
      const expanded = ref(false);
      const label = options.label ?? "Help";
      const close = () => {
        expanded.value = false;
      };
      const handleDocumentClick = () => close();
      const handleCloseAll = () => close();

      onMounted(() => {
        document.addEventListener("click", handleDocumentClick);
        document.addEventListener("desktop-menu-close-all", handleCloseAll);
      });

      onBeforeUnmount(() => {
        document.removeEventListener("click", handleDocumentClick);
        document.removeEventListener("desktop-menu-close-all", handleCloseAll);
      });

      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => [
          h(NButton, {
            quaternary: true,
            size: "small",
            attrType: "button",
            class: "desktop-application-menu-item desktop-help-menu-trigger",
            "aria-haspopup": "menu",
            "aria-expanded": String(expanded.value),
            onPointerdown: (event: PointerEvent) => event.stopPropagation(),
            onDblclick: (event: MouseEvent) => event.stopPropagation(),
            onClick: (event: MouseEvent) => {
              event.stopPropagation();
              if (expanded.value) {
                close();
              } else {
                document.dispatchEvent(new CustomEvent("desktop-menu-close-all"));
                expanded.value = true;
              }
            },
            onKeydown: (event: KeyboardEvent) => {
              if (event.key !== "Escape") {
                return;
              }
              event.preventDefault();
              close();
            },
          }, { default: () => label }),
          h("div", {
            class: "desktop-help-menu-popover",
            role: "menu",
            "aria-label": options.menuLabel ?? `${label} menu`,
            hidden: !expanded.value,
          }, options.commands.map((command) => h(NButton, {
            key: command.id,
            quaternary: true,
            size: "small",
            attrType: "button",
            class: "desktop-help-menu-item",
            role: "menuitem",
            "data-desktop-menu-command": command.id,
            "aria-label": menuCommandAccessibleLabel(command),
            title: menuCommandAccessibleLabel(command),
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
              command.shortcut
                ? h(NText, { class: "desktop-help-menu-shortcut", depth: 3, tag: "span" }, { default: () => command.shortcut })
                : null,
            ],
          }))),
        ],
      });
    },
  }));
}

function menuCommandAccessibleLabel(command: DesktopMenuCommand): string {
  return command.shortcut ? `${command.label} (${command.shortcut})` : command.label;
}
