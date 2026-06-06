import { createApp, defineComponent, h, type App } from "vue";
import { NConfigProvider, NText } from "naive-ui";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export interface MountedCommandPaletteIsland {
  unmount: () => void;
}

export function mountCommandPaletteIsland(host: HTMLElement): MountedCommandPaletteIsland {
  host.setAttribute("data-desktop-vue-island", "command-palette");
  host.id = "desktop-command-palette";
  host.className = "desktop-command-palette";
  host.setAttribute("role", "dialog");
  host.setAttribute("aria-modal", "false");
  host.setAttribute("aria-label", "Command palette");
  host.hidden = true;
  const app = createCommandPaletteApp();
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createCommandPaletteApp(): App {
  return createApp(defineComponent({
    name: "CommandPaletteIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => [
          h("div", { class: "desktop-command-palette-header" }, [
            h("h2", "Command Palette"),
            h("button", {
              id: "desktop-command-palette-close",
              class: "desktop-command-palette-close",
              type: "button",
              "aria-label": "Close command palette",
            }, "Close"),
          ]),
          h("input", {
            id: "desktop-command-palette-input",
            class: "desktop-command-palette-input",
            type: "search",
            "aria-label": "Search commands and workbench data",
            placeholder: "Search commands, sessions, files, knowledge, tools, skills, Cowork",
          }),
          h("div", {
            id: "desktop-command-palette-results",
            class: "desktop-command-palette-results",
            "aria-live": "polite",
          }),
          h(NText, {
            id: "desktop-command-palette-status",
            class: "desktop-command-palette-status",
            depth: 3,
            tag: "p",
          }, { default: () => "Type to search." }),
        ],
      });
    },
  }));
}
