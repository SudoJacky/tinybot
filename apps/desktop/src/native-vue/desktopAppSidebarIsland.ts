import { createApp, defineComponent, h, type App } from "vue";
import { NButton, NConfigProvider, NText } from "naive-ui";
import type {
  DesktopSidebarGroup,
  DesktopSidebarItem,
  DesktopSidebarModel,
} from "../desktopSharedModels";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export interface DesktopAppSidebarIslandOptions {
  model: DesktopSidebarModel;
  targetDocument?: Document;
}

export interface MountedDesktopAppSidebarIsland {
  unmount: () => void;
}

export function mountDesktopAppSidebarIsland(
  host: HTMLElement,
  options: DesktopAppSidebarIslandOptions,
): MountedDesktopAppSidebarIsland {
  host.setAttribute("data-desktop-vue-island", "desktop-app-sidebar");
  const app = createDesktopAppSidebarApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createDesktopAppSidebarApp(options: DesktopAppSidebarIslandOptions): App {
  return createApp(defineComponent({
    name: "DesktopAppSidebarIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => h("nav", {
          "aria-label": "Desktop sidebar",
          class: "desktop-app-sidebar-content",
        }, options.model.groups.map((group) => renderGroup(options, group))),
      });
    },
  }));
}

function renderGroup(options: DesktopAppSidebarIslandOptions, group: DesktopSidebarGroup) {
  return h("section", {
    class: "desktop-app-sidebar-group",
    "data-sidebar-group": group.id,
  }, [
    h(NText, { class: "desktop-app-sidebar-group-label", tag: "p" }, {
      default: () => group.label ?? defaultGroupLabel(group.id),
    }),
    h("div", {
      class: "desktop-app-sidebar-list",
      role: "list",
    }, group.items.map((item) => renderSidebarItem(options, item))),
  ]);
}

function renderSidebarItem(options: DesktopAppSidebarIslandOptions, item: DesktopSidebarItem) {
  const shared = {
    class: "desktop-app-sidebar-item",
    "data-active": item.active ? "true" : undefined,
    "data-sidebar-command": item.commandId,
    "data-sidebar-href": item.kind === "link" ? item.href : undefined,
    "data-sidebar-icon": item.icon,
    "data-sidebar-item-id": item.id,
    "data-sidebar-item-kind": item.kind,
    "data-sidebar-shortcut": item.shortcut,
    "aria-current": item.active ? "page" : undefined,
    "aria-disabled": item.disabled ? "true" : undefined,
    role: "listitem",
  };
  const children = () => [
    h(NText, { class: "desktop-app-sidebar-item-label", tag: "span" }, { default: () => item.label }),
    item.meta || item.shortcut
      ? h(NText, { class: "desktop-app-sidebar-item-meta", depth: 3, tag: "span" }, { default: () => item.meta ?? item.shortcut ?? "" })
      : null,
  ];
  if (item.kind === "link" && item.href) {
    return h("a", {
      ...shared,
      href: item.href,
    }, children());
  }
  return h(NButton, {
    ...shared,
    disabled: item.disabled,
    quaternary: true,
    tag: "button",
    type: "button",
    onClick: () => dispatchSidebarCommand(options.targetDocument ?? document, item),
  }, { default: children });
}

function dispatchSidebarCommand(targetDocument: Document, item: DesktopSidebarItem): void {
  if (!item.commandId || item.disabled) {
    return;
  }
  targetDocument.dispatchEvent(new CustomEvent("desktop-menu-command", {
    detail: { id: item.commandId, source: "desktop-sidebar" },
  }));
}

function defaultGroupLabel(groupId: DesktopSidebarGroup["id"]): string {
  switch (groupId) {
    case "actions":
      return "Actions";
    case "workspace":
      return "Workspace";
    case "footer":
      return "System";
  }
}
