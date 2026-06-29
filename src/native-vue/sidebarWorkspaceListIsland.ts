import { createApp, defineComponent, h, type App } from "vue";
import { NConfigProvider, NText } from "naive-ui";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export interface SidebarWorkspaceListRow {
  active: boolean;
  entityId: string;
  meta: string;
  title: string;
}

export interface SidebarWorkspaceListIslandOptions {
  rows: SidebarWorkspaceListRow[];
}

export interface MountedSidebarWorkspaceListIsland {
  unmount: () => void;
}

export function mountSidebarWorkspaceListIsland(
  host: HTMLElement,
  options: SidebarWorkspaceListIslandOptions,
): MountedSidebarWorkspaceListIsland {
  host.setAttribute("data-desktop-vue-island", "sidebar-workspace-list");
  host.className = "desktop-sidebar-list-section desktop-sidebar-list-section-workspaces";
  const app = createSidebarWorkspaceListApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createSidebarWorkspaceListApp(options: SidebarWorkspaceListIslandOptions): App {
  return createApp(defineComponent({
    name: "SidebarWorkspaceListIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => renderSidebarWorkspaceListContent(options),
      });
    },
  }));
}

export function renderSidebarWorkspaceListSection(options: SidebarWorkspaceListIslandOptions) {
  return h("section", {
    class: "desktop-sidebar-list-section desktop-sidebar-list-section-workspaces",
  }, renderSidebarWorkspaceListContent(options));
}

export function renderSidebarWorkspaceListContent(options: SidebarWorkspaceListIslandOptions) {
  return [
    renderHeading(),
    h("div", {
      class: "desktop-workspace-list",
      role: "list",
    }, options.rows.map(renderWorkspaceRow)),
  ];
}

function renderHeading() {
  return h("div", { class: "desktop-sidebar-section-heading" }, [
    h("h2", "Workspaces"),
    h("button", {
      type: "button",
      class: "desktop-sidebar-section-action",
      "aria-label": "Workspaces action",
    }, "+"),
  ]);
}

function renderWorkspaceRow(row: SidebarWorkspaceListRow) {
  return h("a", {
    class: "desktop-sidebar-row",
    href: "/files",
    role: "listitem",
    "data-active": String(row.active),
    "data-sidebar-row-kind": "folder",
    "data-desktop-entity-module": "files",
    "data-desktop-entity-id": row.entityId,
  }, [
    h(NText, { class: "desktop-sidebar-row-label", tag: "span" }, { default: () => row.title }),
    h(NText, { class: "desktop-sidebar-row-meta", depth: 3, tag: "span" }, { default: () => row.meta }),
  ]);
}
