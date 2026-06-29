import { createApp, defineComponent, h, ref, type App } from "vue";
import { NConfigProvider, NText } from "naive-ui";
import { desktopNaiveThemeOverrides } from "../shell/desktopNaiveTheme";

export interface RecentChatDeleteEvent {
  chatId: string;
  sessionKey: string;
  title: string;
}

export interface RecentChatStatusChip {
  kind: "approval" | "files" | "knowledge" | "running";
  label: string;
}

export interface RecentChatRowIslandOptions {
  active: boolean;
  chatId: string;
  href: string;
  onDeleteSession?: (event: RecentChatDeleteEvent) => void;
  pinned: boolean;
  routeId: string;
  sessionKey: string;
  statusChips?: RecentChatStatusChip[];
  title: string;
  updatedLabel: string;
}

export interface MountedRecentChatRowIsland {
  unmount: () => void;
}

export function mountRecentChatRowIsland(
  host: HTMLElement,
  options: RecentChatRowIslandOptions,
): MountedRecentChatRowIsland {
  host.setAttribute("data-desktop-vue-island", "recent-chat-row");
  host.className = "desktop-sidebar-chat-row";
  host.setAttribute("role", "listitem");
  host.setAttribute("data-active", String(options.active));
  host.setAttribute("data-sidebar-row-kind", "chat");
  host.setAttribute("data-desktop-session-key", options.sessionKey);
  host.setAttribute("data-desktop-chat-id", options.chatId);
  host.setAttribute("data-desktop-route-id", options.routeId);
  host.setAttribute("data-pinned", String(options.pinned));
  const app = createRecentChatRowApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createRecentChatRowApp(options: RecentChatRowIslandOptions): App {
  return createApp(defineComponent({
    name: "RecentChatRowIsland",
    setup() {
      const confirming = ref(false);
      const deleting = ref(false);
      const onDeleteClick = (event: MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
        if (!confirming.value) {
          confirming.value = true;
          return;
        }
        deleting.value = true;
        options.onDeleteSession?.({
          chatId: options.chatId,
          sessionKey: options.sessionKey,
          title: options.title,
        });
      };

      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => [
          h("a", {
            class: "desktop-sidebar-row desktop-sidebar-row-main",
            "data-active": String(options.active),
            "data-desktop-entity-id": options.routeId,
            "data-desktop-entity-module": "chat",
            "data-sidebar-row-kind": "chat",
            href: options.href,
          }, [
            h("span", { class: "desktop-sidebar-row-title" }, [
              h(NText, { class: "desktop-sidebar-row-label", tag: "span" }, { default: () => options.title }),
              options.pinned
                ? h("span", {
                  class: "desktop-sidebar-pin-icon",
                  "data-desktop-session-pin-icon": "",
                  "aria-label": "Pinned session",
                }, "📌")
                : null,
            ]),
            h(NText, { class: "desktop-sidebar-row-meta", depth: 3, tag: "span" }, {
              default: () => options.updatedLabel,
            }),
          ]),
          h("button", {
            "aria-label": confirming.value ? `Confirm delete chat ${options.title}` : `Delete chat ${options.title}`,
            class: "desktop-sidebar-delete-session",
            "data-confirming": confirming.value ? "true" : null,
            "data-deleting": deleting.value ? "true" : null,
            "data-desktop-chat-delete": options.sessionKey,
            disabled: deleting.value ? "" : null,
            onClick: onDeleteClick,
            type: "button",
          }, deleting.value ? "删除中" : confirming.value ? "确认" : "x"),
        ],
      });
    },
  }));
}
