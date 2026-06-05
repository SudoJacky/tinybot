import { createApp, defineComponent, h, type App } from "vue";
import { NConfigProvider } from "naive-ui";
import { renderSharedSidebarCommandsSection, type SharedSidebarCommandItem } from "./sharedSidebarCommandsIsland";
import { renderSharedSidebarLinksSection, type SharedSidebarLinkItem } from "./sharedSidebarLinksIsland";
import { renderSidebarActionsContent } from "./sidebarActionsIsland";
import { renderSidebarRecentChatsSection, type SidebarRecentChatRow } from "./sidebarRecentChatsIsland";
import { renderSidebarWorkspaceListSection, type SidebarWorkspaceListRow } from "./sidebarWorkspaceListIsland";
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
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => [
          h("section", { class: "desktop-sidebar-actions" }, renderSidebarActionsContent()),
          renderSidebarWorkspaceListSection({ rows: options.workspaceRows }),
          renderSidebarRecentChatsSection({ rows: options.recentChats }),
          renderSharedSidebarLinksSection({ items: options.resourceItems, label: options.resourceLabel }),
          renderSharedSidebarCommandsSection({
            items: options.commandItems,
            label: options.commandLabel,
            targetDocument: options.targetDocument,
          }),
        ],
      });
    },
  }));
}
