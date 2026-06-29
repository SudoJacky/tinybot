import { createApp, defineComponent, h, type App } from "vue";
import { NButton, NConfigProvider } from "naive-ui";
import { desktopNaiveThemeOverrides } from "../shell/desktopNaiveTheme";
import { renderHeaderPanelControlContent, type HeaderPanelControlId } from "../shell/headerPanelControlIsland";

export type ChatHeaderActionsPanelId = Extract<HeaderPanelControlId, "sidebar" | "inspector">;

export interface ChatHeaderActionItem {
  panel: ChatHeaderActionsPanelId;
  visible: boolean;
  label: string;
  pressedLabel: string;
  unpressedLabel: string;
}

export interface ChatHeaderActionsIslandOptions {
  actions: ChatHeaderActionItem[];
  onToggle?: (panel: ChatHeaderActionsPanelId) => void;
}

export interface MountedChatHeaderActionsIsland {
  unmount: () => void;
}

export function mountChatHeaderActionsIsland(
  host: HTMLElement,
  options: ChatHeaderActionsIslandOptions,
): MountedChatHeaderActionsIsland {
  host.setAttribute("data-desktop-vue-island", "chat-header-actions");
  host.className = "desktop-chat-header-actions";
  const app = createChatHeaderActionsApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createChatHeaderActionsApp(options: ChatHeaderActionsIslandOptions): App {
  return createApp(defineComponent({
    name: "ChatHeaderActionsIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => options.actions.map((action) => renderActionButton(action, options)),
      });
    },
  }));
}

function renderActionButton(action: ChatHeaderActionItem, options: ChatHeaderActionsIslandOptions) {
  const accessibleLabel = action.visible ? action.pressedLabel : action.unpressedLabel;
  return h(NButton, {
    class: "desktop-chat-header-panel-button",
    "data-desktop-panel-control": action.panel,
    "data-desktop-panel-label-pressed": action.pressedLabel,
    "data-desktop-panel-label-unpressed": action.unpressedLabel,
    "aria-label": accessibleLabel,
    focusable: false,
    quaternary: true,
    size: "small",
    title: accessibleLabel,
    "aria-pressed": String(action.visible),
    onClick: () => options.onToggle?.(action.panel),
    onKeydown: (event: KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }
      event.preventDefault();
      options.onToggle?.(action.panel);
    },
  }, { default: () => renderHeaderPanelControlContent(action) });
}
