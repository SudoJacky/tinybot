import { createApp, defineComponent, h, ref, type App } from "vue";
import { NConfigProvider } from "naive-ui";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";
import { renderChatMenuActionNode } from "./chatMenuActionIsland";
import { renderChatMenuEmptyNode } from "./chatMenuEmptyIsland";

export interface ChatMenuPopoverAction {
  action: string;
  disabled: boolean;
  label: string;
  onAction?: () => string | void;
}

export interface ChatMenuPopoverIslandOptions {
  actions: ChatMenuPopoverAction[];
  emptyMessage: string;
}

export interface MountedChatMenuPopoverIsland {
  unmount: () => void;
}

export function mountChatMenuPopoverIsland(
  host: HTMLElement,
  options: ChatMenuPopoverIslandOptions,
): MountedChatMenuPopoverIsland {
  host.setAttribute("data-desktop-vue-island", "chat-menu-popover");
  host.className = "desktop-chat-menu-popover";
  host.setAttribute("role", "menu");
  host.setAttribute("aria-label", "Chat session actions");
  const app = createChatMenuPopoverApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createChatMenuPopoverApp(options: ChatMenuPopoverIslandOptions): App {
  return createApp(defineComponent({
    name: "ChatMenuPopoverIsland",
    setup() {
      const labels = ref(options.actions.map((action) => action.label));
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => options.actions.length
          ? options.actions.map((action, index) => renderChatMenuActionNode({
            ...action,
            label: labels.value[index] ?? action.label,
            onClick: () => {
              const nextLabel = action.onAction?.();
              if (typeof nextLabel === "string") {
                labels.value = labels.value.map((label, labelIndex) => labelIndex === index ? nextLabel : label);
              }
            },
          }))
          : renderChatMenuEmptyNode({ message: options.emptyMessage }),
      });
    },
  }));
}
