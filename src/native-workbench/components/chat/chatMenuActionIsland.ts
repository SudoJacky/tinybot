import { createApp, defineComponent, h, type App } from "vue";
import { NButton, NConfigProvider } from "naive-ui";
import { desktopNaiveThemeOverrides } from "../shell/desktopNaiveTheme";

export interface ChatMenuActionIslandOptions {
  action: string;
  disabled: boolean;
  label: string;
  onClick?: () => void;
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
  host.onclick = () => {
    if (!options.disabled) {
      options.onClick?.();
    }
  };
  const app = createChatMenuActionApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.onclick = null;
      host.replaceChildren();
    },
  };
}

function createChatMenuActionApp(options: ChatMenuActionIslandOptions): App {
  return createApp(defineComponent({
    name: "ChatMenuActionIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => renderChatMenuActionChildren(options),
      });
    },
  }));
}

export function renderChatMenuActionNode(options: ChatMenuActionIslandOptions & { onClick?: () => void }) {
  return h("button", {
    class: "desktop-chat-menu-action",
    "data-desktop-chat-menu-action": options.action,
    disabled: options.disabled,
    role: "menuitem",
    type: "button",
    onClick: () => {
      if (!options.disabled) {
        options.onClick?.();
      }
    },
  }, renderChatMenuActionChildren(options));
}

export function renderChatMenuActionChildren(options: ChatMenuActionIslandOptions) {
  return h(NButton, {
    block: true,
    disabled: options.disabled,
    quaternary: true,
    size: "small",
  }, { default: () => options.label });
}
