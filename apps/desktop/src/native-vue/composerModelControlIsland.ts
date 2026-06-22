import { createApp, defineComponent, h, type App } from "vue";
import { NConfigProvider, NText } from "naive-ui";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export interface ComposerModelControlIslandOptions {
  model?: string | null;
  onModelSelect?: () => void;
}

export interface MountedComposerModelControlIsland {
  unmount: () => void;
}

export function mountComposerModelControlIsland(
  host: HTMLElement,
  options: ComposerModelControlIslandOptions,
): MountedComposerModelControlIsland {
  host.setAttribute("data-desktop-vue-island", "composer-model-control");
  host.setAttribute("type", "button");
  host.className = "desktop-native-composer-model";
  host.setAttribute("aria-label", "Select model");
  host.setAttribute("data-desktop-composer-action", "model-select");
  host.addEventListener("click", () => options.onModelSelect?.());
  const app = createComposerModelControlApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createComposerModelControlApp(options: ComposerModelControlIslandOptions): App {
  const model = options.model || "Tinybot Pro";
  return createApp(defineComponent({
    name: "ComposerModelControlIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => h(NText, { strong: true }, { default: () => model }),
      });
    },
  }));
}
