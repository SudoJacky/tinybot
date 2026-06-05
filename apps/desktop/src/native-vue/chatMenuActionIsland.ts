import { createApp, defineComponent, h, type App } from "vue";
import { NButton, NConfigProvider } from "naive-ui";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export interface ChatMenuActionIslandOptions {
  action: string;
  disabled: boolean;
  label: string;
}

export interface MountedChatMenuActionIsland {
  unmount: () => void;
}

export function mountChatMenuActionIsland(
  host: HTMLElement,
  options: ChatMenuActionIslandOptions,
): MountedChatMenuActionIsland {
  host.setAttribute("data-desktop-vue-island", "chat-menu-action");
  host.className = "desktop-chat-menu-action";
  host.setAttribute("role", "menuitem");
  host.setAttribute("data-desktop-chat-menu-action", options.action);
  if (host instanceof HTMLButtonElement) {
    host.type = "button";
    host.disabled = options.disabled;
  }
  if (options.disabled) {
    host.setAttribute("disabled", "");
  } else {
    host.removeAttribute("disabled");
  }
  const app = createChatMenuActionApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createChatMenuActionApp(options: ChatMenuActionIslandOptions): App {
  return createApp(defineComponent({
    name: "ChatMenuActionIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => h(NButton, {
          block: true,
          disabled: options.disabled,
          quaternary: true,
          size: "small",
        }, { default: () => options.label }),
      });
    },
  }));
}
