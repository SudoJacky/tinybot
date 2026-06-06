import { createApp, defineComponent, h, type App } from "vue";
import { NConfigProvider, NSpace } from "naive-ui";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export interface SharedSidebarCommandItem {
  commandId: string;
  icon?: string;
  id: string;
  kind: "command";
  label: string;
}

export interface SharedSidebarCommandsIslandOptions {
  items: SharedSidebarCommandItem[];
  label?: string;
  targetDocument?: Document;
}

export interface MountedSharedSidebarCommandsIsland {
  unmount: () => void;
}

export function mountSharedSidebarCommandsIsland(
  host: HTMLElement,
  options: SharedSidebarCommandsIslandOptions,
): MountedSharedSidebarCommandsIsland {
  host.setAttribute("data-desktop-vue-island", "shared-sidebar-commands");
  host.className = "desktop-workbench-section";
  const app = createSharedSidebarCommandsApp({
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

function createSharedSidebarCommandsApp(options: Required<SharedSidebarCommandsIslandOptions>): App {
  return createApp(defineComponent({
    name: "SharedSidebarCommandsIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => renderSharedSidebarCommandsContent(options),
      });
    },
  }));
}

export function renderSharedSidebarCommandsSection(options: Required<SharedSidebarCommandsIslandOptions>) {
  return h("section", { class: "desktop-workbench-section" }, renderSharedSidebarCommandsContent(options));
}

export function renderSharedSidebarCommandsContent(options: Required<SharedSidebarCommandsIslandOptions>) {
  const dispatchCommand = (commandId: string) => {
    options.targetDocument.dispatchEvent(new CustomEvent("desktop-menu-command", {
      detail: { id: commandId, source: "native-sidebar" },
    }));
  };

  return [
    h("h2", options.label ?? "System"),
    h(NSpace, { vertical: true, size: 6 }, {
      default: () => options.items.map((item) => h("button", {
        class: "desktop-workbench-link",
        "data-sidebar-command": item.commandId,
        "data-sidebar-icon": item.icon,
        "data-sidebar-item-id": item.id,
        "data-sidebar-item-kind": item.kind,
        onClick: () => dispatchCommand(item.commandId),
        type: "button",
      }, item.label)),
    }),
  ];
}
