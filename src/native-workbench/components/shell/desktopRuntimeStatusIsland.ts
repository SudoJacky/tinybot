import { createApp, defineComponent, h, reactive, type App } from "vue";
import { NConfigProvider, NText } from "naive-ui";
import type { DesktopRuntimeStatusView } from "../../shell/desktopWindowFrame";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

interface DesktopRuntimeStatusIslandOptions {
  view: DesktopRuntimeStatusView;
}

interface MountedDesktopRuntimeStatusIsland {
  update: (options: DesktopRuntimeStatusIslandOptions) => void;
  unmount: () => void;
}

const mountedRuntimeStatus = new WeakMap<HTMLElement, MountedDesktopRuntimeStatusIsland>();

export function mountOrUpdateDesktopRuntimeStatusIsland(
  host: HTMLElement,
  options: DesktopRuntimeStatusIslandOptions,
): MountedDesktopRuntimeStatusIsland {
  const existing = mountedRuntimeStatus.get(host);
  if (existing) {
    existing.update(options);
    return existing;
  }

  const appState = reactive({ view: options.view });
  applyDesktopRuntimeStatusHost(host, appState.view);
  const app = createDesktopRuntimeStatusApp(appState);
  app.mount(host);
  const mounted: MountedDesktopRuntimeStatusIsland = {
    update: (nextOptions) => {
      appState.view = nextOptions.view;
      applyDesktopRuntimeStatusHost(host, nextOptions.view);
    },
    unmount: () => {
      app.unmount();
      host.replaceChildren();
      mountedRuntimeStatus.delete(host);
    },
  };
  mountedRuntimeStatus.set(host, mounted);
  return mounted;
}

function applyDesktopRuntimeStatusHost(host: HTMLElement, view: DesktopRuntimeStatusView): void {
  host.id = "desktop-runtime-status";
  host.className = "desktop-runtime-status";
  host.setAttribute("data-desktop-vue-island", "desktop-runtime-status");
  host.setAttribute("role", "button");
  host.setAttribute("tabindex", "0");
  host.setAttribute("data-desktop-runtime-command", "refresh-gateway-status");
  host.setAttribute("aria-live", "polite");
  host.setAttribute("data-runtime-tone", view.tone);
  host.setAttribute("title", view.detail);
}

function createDesktopRuntimeStatusApp(appState: { view: DesktopRuntimeStatusView }): App {
  return createApp(defineComponent({
    name: "DesktopRuntimeStatusIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => h(NText, {
          class: "desktop-runtime-status-label",
          depth: appState.view.tone === "ok" ? 2 : 3,
          tag: "span",
        }, {
          default: () => appState.view.label,
        }),
      });
    },
  }));
}
