import { createApp, defineComponent, h, ref, type App } from "vue";
import { NConfigProvider, NText } from "naive-ui";
import type { RecentChatDeleteEvent, RecentChatRowIslandOptions } from "./recentChatRowIsland";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export type SidebarRecentChatRow = Omit<RecentChatRowIslandOptions, "onDeleteSession">;

export interface SidebarRecentChatsIslandOptions {
  rows: SidebarRecentChatRow[];
  onDeleteSession?: (event: RecentChatDeleteEvent) => void;
}

export interface MountedSidebarRecentChatsIsland {
  unmount: () => void;
}

export function mountSidebarRecentChatsIsland(
  host: HTMLElement,
  options: SidebarRecentChatsIslandOptions,
): MountedSidebarRecentChatsIsland {
  host.setAttribute("data-desktop-vue-island", "sidebar-recent-chats");
  host.className = "desktop-sidebar-list-section desktop-sidebar-list-section-recent";
  const app = createSidebarRecentChatsApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createSidebarRecentChatsApp(options: SidebarRecentChatsIslandOptions): App {
  return createApp(defineComponent({
    name: "SidebarRecentChatsIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => renderSidebarRecentChatsContent(options),
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
  onDeleteSession?: (event: RecentChatDeleteEvent) => void;
}>({
  name: "SidebarRecentChatRow",
  props: ["row", "onDeleteSession"],
  setup(props) {
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
      props.onDeleteSession?.({
        chatId: props.row.chatId,
        sessionKey: props.row.sessionKey,
        title: props.row.title,
      });
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
            renderStatusChips(props.row.sessionKey, props.row.statusChips),
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

function renderStatusChips(sessionKey: string, chips: SidebarRecentChatRow["statusChips"] = []) {
  if (!chips?.length) {
    return null;
  }
  return h("span", {
    "aria-label": "Chat status",
    class: "desktop-sidebar-row-status",
    "data-desktop-chat-status": sessionKey,
  }, chips.map((chip) => h("span", {
    class: "desktop-sidebar-status-chip",
    "data-status-kind": chip.kind,
  }, chip.label)));
}
