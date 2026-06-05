import { createApp, defineComponent, h, type App } from "vue";
import { NConfigProvider, NText } from "naive-ui";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export interface ComposerAttachButtonIslandOptions {
  onAttach?: () => void;
}

export interface MountedComposerAttachButtonIsland {
  unmount: () => void;
}

export function mountComposerAttachButtonIsland(
  host: HTMLElement,
  options: ComposerAttachButtonIslandOptions,
): MountedComposerAttachButtonIsland {
  host.setAttribute("data-desktop-vue-island", "composer-attach-button");
  host.setAttribute("id", "desktop-native-composer-attach");
  host.setAttribute("type", "button");
  host.className = "desktop-native-composer-action";
  host.setAttribute("data-desktop-composer-action", "attach");
  host.setAttribute("aria-label", "Attach temporary file to current session");
  host.addEventListener("click", () => {
    options.onAttach?.();
  });
  const app = createComposerAttachButtonApp();
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createComposerAttachButtonApp(): App {
  return createApp(defineComponent({
    name: "ComposerAttachButtonIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => h(NText, { strong: true }, { default: () => "+" }),
      });
    },
  }));
}
