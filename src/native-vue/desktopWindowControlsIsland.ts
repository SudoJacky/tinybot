import { createApp, defineComponent, h, type App } from "vue";
import { NButton, NConfigProvider, NIcon } from "naive-ui";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

interface DesktopWindowControlsIslandOptions {
  onMinimize: () => Promise<void>;
  onToggleMaximize: () => Promise<void>;
  onClose: () => Promise<void>;
  onError?: (error: unknown) => void;
}

export interface MountedDesktopWindowControlsIsland {
  unmount: () => void;
}

export function mountDesktopWindowControlsIsland(
  host: HTMLElement,
  options: DesktopWindowControlsIslandOptions,
): MountedDesktopWindowControlsIsland {
  applyDesktopWindowControlsHost(host);
  const app = createDesktopWindowControlsApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function applyDesktopWindowControlsHost(host: HTMLElement): void {
  host.className = "desktop-window-controls";
  host.setAttribute("data-desktop-vue-island", "desktop-window-controls");
}

function createDesktopWindowControlsApp(options: DesktopWindowControlsIslandOptions): App {
  const controls = [
    { action: "minimize", label: "Minimize", text: "-", handler: options.onMinimize },
    { action: "maximize", label: "Maximize", text: "[]", handler: options.onToggleMaximize },
    { action: "close", label: "Close", text: "x", handler: options.onClose },
  ] as const;

  return createApp(defineComponent({
    name: "DesktopWindowControlsIsland",
    setup() {
      const run = (handler: () => Promise<void>) => {
        void handler().catch((error) => options.onError?.(error));
      };

      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => controls.map((control) => h(NButton, {
          key: control.action,
          quaternary: true,
          size: "small",
          class: [
            "desktop-window-button",
            `desktop-window-button-${control.action}`,
          ],
          "data-window-action": control.action,
          "aria-label": control.label,
          title: control.label,
          onPointerdown: (event: PointerEvent) => event.stopPropagation(),
          onDblclick: (event: MouseEvent) => event.stopPropagation(),
          onClick: (event: MouseEvent) => {
            event.stopPropagation();
            run(control.handler);
          },
        }, {
          icon: () => h(NIcon, null, { default: () => control.text }),
        })),
      });
    },
  }));
}
