import { createApp, defineComponent, h, onBeforeUnmount, onMounted, ref, type App } from "vue";
import { NCard, NConfigProvider } from "naive-ui";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";
import { mountChatMenuActionIsland } from "./chatMenuActionIsland";
import { mountChatMenuEmptyIsland } from "./chatMenuEmptyIsland";

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
      const mountedChildren: Array<{ unmount: () => void }> = [];
      const actionHosts = ref<Array<HTMLButtonElement | null>>([]);
      const emptyHost = ref<HTMLElement | null>(null);

      const unmountChildren = (): void => {
        while (mountedChildren.length) {
          mountedChildren.pop()?.unmount();
        }
      };

      const mountActions = (): void => {
        unmountChildren();
        if (!options.actions.length) {
          mountChild(mountedChildren, emptyHost.value, (host) => mountChatMenuEmptyIsland(host, {
            message: options.emptyMessage,
          }));
          return;
        }
        options.actions.forEach((action, index) => {
          mountChild(mountedChildren, actionHosts.value[index] ?? null, (host) => mountChatMenuActionIsland(host, {
            action: action.action,
            disabled: action.disabled,
            label: labels.value[index] ?? action.label,
            onClick: () => {
              const nextLabel = action.onAction?.();
              if (typeof nextLabel === "string") {
                labels.value = labels.value.map((label, labelIndex) => labelIndex === index ? nextLabel : label);
                mountActions();
              }
            },
          }));
        });
      };

      onMounted(mountActions);
      onBeforeUnmount(unmountChildren);

      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => h(NCard, {
          class: "desktop-chat-menu-popover-card",
          size: "small",
          bordered: false,
        }, {
          default: () => options.actions.length
            ? options.actions.map((action, index) => h("button", {
              ref: (element) => {
                actionHosts.value[index] = element as HTMLButtonElement | null;
              },
              "data-desktop-chat-menu-action": action.action,
            }))
            : h("span", { ref: emptyHost }),
        }),
      });
    },
  }));
}

function mountChild<T extends { unmount: () => void }>(
  mountedChildren: Array<{ unmount: () => void }>,
  host: HTMLElement | null,
  mount: (host: HTMLElement) => T,
): void {
  if (!host) {
    return;
  }
  mountedChildren.push(mount(host));
}
