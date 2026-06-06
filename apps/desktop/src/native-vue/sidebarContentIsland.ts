import { createApp, defineComponent, h, onBeforeUnmount, onMounted, ref, type App } from "vue";
import { NConfigProvider, NSpace } from "naive-ui";
import { mountSharedSidebarCommandsIsland, type SharedSidebarCommandItem } from "./sharedSidebarCommandsIsland";
import { mountSharedSidebarLinksIsland, type SharedSidebarLinkItem } from "./sharedSidebarLinksIsland";
import { mountSidebarActionsIsland } from "./sidebarActionsIsland";
import { mountSidebarRecentChatsIsland, type SidebarRecentChatRow } from "./sidebarRecentChatsIsland";
import { mountSidebarWorkspaceListIsland, type SidebarWorkspaceListRow } from "./sidebarWorkspaceListIsland";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export interface SidebarContentIslandOptions {
  commandItems: SharedSidebarCommandItem[];
  commandLabel?: string;
  recentChats: SidebarRecentChatRow[];
  resourceItems: SharedSidebarLinkItem[];
  resourceLabel?: string;
  targetDocument?: Document;
  workspaceRows: SidebarWorkspaceListRow[];
}

export interface MountedSidebarContentIsland {
  unmount: () => void;
}

export function mountSidebarContentIsland(
  host: HTMLElement,
  options: SidebarContentIslandOptions,
): MountedSidebarContentIsland {
  host.setAttribute("data-desktop-vue-island", "sidebar-content");
  host.className = "desktop-sidebar-content";
  const app = createSidebarContentApp({
    ...options,
    targetDocument: options.targetDocument ?? host.ownerDocument,
  });
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createSidebarContentApp(options: Required<SidebarContentIslandOptions>): App {
  return createApp(defineComponent({
    name: "SidebarContentIsland",
    setup() {
      const mountedChildren: Array<{ unmount: () => void }> = [];
      const actions = ref<HTMLElement | null>(null);
      const workspaces = ref<HTMLElement | null>(null);
      const recent = ref<HTMLElement | null>(null);
      const links = ref<HTMLElement | null>(null);
      const commands = ref<HTMLElement | null>(null);

      onMounted(() => {
        mountChild(mountedChildren, actions.value, (host) => mountSidebarActionsIsland(host));
        mountChild(mountedChildren, workspaces.value, (host) => mountSidebarWorkspaceListIsland(host, {
          rows: options.workspaceRows,
        }));
        mountChild(mountedChildren, recent.value, (host) => mountSidebarRecentChatsIsland(host, {
          rows: options.recentChats,
        }));
        mountChild(mountedChildren, links.value, (host) => mountSharedSidebarLinksIsland(host, {
          items: options.resourceItems,
          label: options.resourceLabel,
        }));
        mountChild(mountedChildren, commands.value, (host) => mountSharedSidebarCommandsIsland(host, {
          items: options.commandItems,
          label: options.commandLabel,
          targetDocument: options.targetDocument,
        }));
      });

      onBeforeUnmount(() => {
        while (mountedChildren.length) {
          mountedChildren.pop()?.unmount();
        }
      });

      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => h(NSpace, {
          class: "desktop-sidebar-content-stack",
          vertical: true,
          size: 12,
        }, {
          default: () => [
            h("section", { ref: actions }),
            h("section", { ref: workspaces }),
            h("section", { ref: recent }),
            h("section", { ref: links }),
            h("section", { ref: commands }),
          ],
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
