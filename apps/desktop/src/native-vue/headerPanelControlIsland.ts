import { createApp, defineComponent, h, type App } from "vue";
import { NConfigProvider } from "naive-ui";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export type HeaderPanelControlId = "sidebar" | "inspector" | "bottom";

export interface HeaderPanelControlIslandOptions {
  panel: HeaderPanelControlId;
  visible: boolean;
  label: string;
  pressedLabel: string;
  unpressedLabel: string;
  onToggle?: (panel: HeaderPanelControlId) => void;
}

export interface MountedHeaderPanelControlIsland {
  unmount: () => void;
}

export function mountHeaderPanelControlIsland(
  host: HTMLElement,
  options: HeaderPanelControlIslandOptions,
): MountedHeaderPanelControlIsland {
  applyHeaderPanelControlHost(host, options);
  host.addEventListener("click", () => {
    options.onToggle?.(options.panel);
  });
  host.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    event.preventDefault();
    options.onToggle?.(options.panel);
  });
  const app = createHeaderPanelControlApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createHeaderPanelControlApp(options: HeaderPanelControlIslandOptions): App {
  return createApp(defineComponent({
    name: "HeaderPanelControlIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => renderHeaderPanelControlContent(options),
      });
    },
  }));
}

function applyHeaderPanelControlHost(host: HTMLElement, options: HeaderPanelControlIslandOptions): void {
  host.setAttribute("data-desktop-vue-island", "header-panel-control");
  host.setAttribute("type", "button");
  host.className = "desktop-chat-header-panel-button";
  host.setAttribute("data-desktop-panel-control", options.panel);
  host.setAttribute("data-desktop-panel-label-pressed", options.pressedLabel);
  host.setAttribute("data-desktop-panel-label-unpressed", options.unpressedLabel);
  host.setAttribute("aria-label", options.visible ? options.pressedLabel : options.unpressedLabel);
  host.setAttribute("title", options.visible ? options.pressedLabel : options.unpressedLabel);
  host.setAttribute("aria-pressed", String(options.visible));
}

export function renderHeaderPanelControlContent(options: HeaderPanelControlIslandOptions) {
  const iconDirection = options.panel === "sidebar" ? "collapse-left" : options.panel === "inspector" ? "collapse-right" : "";
  if (!iconDirection) {
    return options.label;
  }
  return h("span", {
    class: "desktop-chat-header-panel-icon",
    "data-panel-icon": iconDirection,
    "aria-hidden": "true",
  }, [
    h("span", { class: "desktop-chat-header-panel-icon-frame" }),
    h("span", { class: "desktop-chat-header-panel-icon-rail" }),
  ]);
}
