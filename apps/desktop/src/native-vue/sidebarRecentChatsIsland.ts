import { createApp, defineComponent, h, ref, type App, type Ref } from "vue";
import { NConfigProvider, NText } from "naive-ui";
import type { RecentChatDeleteEvent, RecentChatRowIslandOptions } from "./recentChatRowIsland";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";
import { logDesktopNativeDebug } from "../desktopNativeChatDebug";

export type SidebarRecentChatRow = Omit<RecentChatRowIslandOptions, "onDeleteSession">;

export interface SidebarRecentChatsIslandOptions {
  rows: SidebarRecentChatRow[];
  onDeleteSession?: (event: RecentChatDeleteEvent) => unknown | Promise<unknown>;
}

export interface MountedSidebarRecentChatsIsland {
  update: (options: SidebarRecentChatsIslandOptions) => void;
  unmount: () => void;
}

const mountedSidebarRecentChats = new WeakMap<HTMLElement, MountedSidebarRecentChatsIsland>();

export function mountSidebarRecentChatsIsland(
  host: HTMLElement,
  options: SidebarRecentChatsIslandOptions,
): MountedSidebarRecentChatsIsland {
  host.setAttribute("data-desktop-vue-island", "sidebar-recent-chats");
  host.className = "desktop-sidebar-list-section desktop-sidebar-list-section-recent";
  const mounted = mountedSidebarRecentChats.get(host);
  if (mounted) {
    mounted.update(options);
    return mounted;
  }
  const state = ref(options);
  const app = createSidebarRecentChatsApp(state);
  app.mount(host);
  const nextMounted = {
    update: (nextOptions: SidebarRecentChatsIslandOptions) => {
      state.value = nextOptions;
    },
    unmount: () => {
      mountedSidebarRecentChats.delete(host);
      app.unmount();
      host.replaceChildren();
    },
  };
  mountedSidebarRecentChats.set(host, nextMounted);
  return nextMounted;
}

function createSidebarRecentChatsApp(state: Ref<SidebarRecentChatsIslandOptions>): App {
  return createApp(defineComponent({
    name: "SidebarRecentChatsIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => renderSidebarRecentChatsContent(state.value),
      });
    },
  }));
}

export function renderSidebarRecentChatsSection(options: SidebarRecentChatsIslandOptions) {
  return h("section", {
    class: "desktop-sidebar-list-section desktop-sidebar-list-section-recent",
  }, renderSidebarRecentChatsContent(options));
}

export function renderSidebarRecentChatsContent(options: SidebarRecentChatsIslandOptions) {
  return [
    renderHeading(),
    h("div", {
      class: "desktop-recent-chat-list",
      role: "list",
    }, options.rows.length
      ? options.rows.map((row) => renderRecentChatRow(row, options))
      : [h("p", "No recent chats.")]),
  ];
}

function renderHeading() {
  return h("div", { class: "desktop-sidebar-section-heading" }, [
    h("h2", "Recent chats"),
  ]);
}

function renderRecentChatRow(row: SidebarRecentChatRow, options: SidebarRecentChatsIslandOptions) {
  return h(RecentChatRowComponent, {
    row,
    onDeleteSession: options.onDeleteSession,
  });
}

const RecentChatRowComponent = defineComponent<{
  row: SidebarRecentChatRow;
  onDeleteSession?: (event: RecentChatDeleteEvent) => unknown | Promise<unknown>;
}>({
  name: "SidebarRecentChatRow",
  props: ["row", "onDeleteSession"],
  setup(props) {
    const confirming = ref(false);
    const deleting = ref(false);
    const onDeleteClick = async (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (!confirming.value) {
        confirming.value = true;
        logDesktopNativeDebug("recentChat.delete.confirm", summarizeRecentChatRow(props.row));
        return;
      }
      deleting.value = true;
      logDesktopNativeDebug("recentChat.delete.request", summarizeRecentChatRow(props.row));
      try {
        await Promise.resolve(props.onDeleteSession?.({
          chatId: props.row.chatId,
          sessionKey: props.row.sessionKey,
          title: props.row.title,
        }));
        logDesktopNativeDebug("recentChat.delete.complete", summarizeRecentChatRow(props.row));
      } catch {
        logDesktopNativeDebug("recentChat.delete.failed", summarizeRecentChatRow(props.row));
        // The shell reports deletion failures separately; the row only needs to leave its transient state.
      } finally {
        deleting.value = false;
        confirming.value = false;
      }
    };

    return () => h("div", {
      class: "desktop-sidebar-chat-row",
      role: "listitem",
      "data-active": String(props.row.active),
      "data-sidebar-row-kind": "chat",
      "data-desktop-session-key": props.row.sessionKey,
      "data-desktop-chat-id": props.row.chatId,
      "data-desktop-route-id": props.row.routeId,
      "data-pinned": String(props.row.pinned),
    }, [
      h("a", {
        class: "desktop-sidebar-row desktop-sidebar-row-main",
        "data-active": String(props.row.active),
        "data-desktop-entity-id": props.row.routeId,
        "data-desktop-entity-module": "chat",
        "data-sidebar-row-kind": "chat",
        href: props.row.href,
      }, [
        h("span", { class: "desktop-sidebar-row-title" }, [
          h(NText, { class: "desktop-sidebar-row-label", tag: "span" }, { default: () => props.row.title }),
          props.row.pinned
            ? h("span", {
              class: "desktop-sidebar-pin-icon",
              "data-desktop-session-pin-icon": "",
              "aria-label": "Pinned session",
            }, "馃搶")
            : null,
        ]),
            h(NText, { class: "desktop-sidebar-row-meta", depth: 3, tag: "span" }, {
              default: () => props.row.updatedLabel,
            }),
          ]),
      h("button", {
        "aria-label": confirming.value ? `Confirm delete chat ${props.row.title}` : `Delete chat ${props.row.title}`,
        class: "desktop-sidebar-delete-session",
        "data-confirming": confirming.value ? "true" : null,
        "data-deleting": deleting.value ? "true" : null,
        "data-desktop-chat-delete": props.row.sessionKey,
        disabled: deleting.value ? "" : null,
        onClick: onDeleteClick,
        type: "button",
      }, deleting.value ? "Deleting" : confirming.value ? "Confirm" : "x"),
    ]);
  },
});

function summarizeRecentChatRow(row: SidebarRecentChatRow): Record<string, unknown> {
  return {
    active: row.active,
    chatId: row.chatId,
    pinned: row.pinned,
    routeId: row.routeId,
    sessionKey: row.sessionKey,
  };
}
