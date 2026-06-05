import { createApp, defineComponent, h, type App } from "vue";
import { NConfigProvider, NText } from "naive-ui";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export interface ComposerSendButtonIslandOptions {
  disabled: boolean;
  onSend?: () => void;
}

export interface MountedComposerSendButtonIsland {
  unmount: () => void;
}

export function mountComposerSendButtonIsland(
  host: HTMLElement,
  options: ComposerSendButtonIslandOptions,
): MountedComposerSendButtonIsland {
  host.setAttribute("data-desktop-vue-island", "composer-send-button");
  host.setAttribute("id", "desktop-native-composer-send");
  host.setAttribute("type", "button");
  host.className = "desktop-native-composer-send";
  host.setAttribute("data-desktop-composer-action", "send");
  host.setAttribute("aria-label", "Send message");
  setHostDisabled(host, options.disabled);
  host.addEventListener("click", () => {
    if ((host as HTMLButtonElement).disabled) {
      return;
    }
    options.onSend?.();
  });
  const app = createComposerSendButtonApp();
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createComposerSendButtonApp(): App {
  return createApp(defineComponent({
    name: "ComposerSendButtonIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => h(NText, { strong: true }, { default: () => "Send" }),
      });
    },
  }));
}

function setHostDisabled(host: HTMLElement, disabled: boolean): void {
  (host as HTMLButtonElement).disabled = disabled;
  if (disabled) {
    host.setAttribute("disabled", "");
  } else {
    host.removeAttribute("disabled");
  }
}
