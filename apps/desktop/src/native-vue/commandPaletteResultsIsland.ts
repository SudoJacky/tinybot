import { createApp, defineComponent, h, type App } from "vue";
import { NButton, NConfigProvider, NText } from "naive-ui";
import type { DesktopCommandPaletteResult } from "../desktopCommandPalette";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export interface CommandPaletteResultsIslandOptions {
  results: DesktopCommandPaletteResult[];
}

export interface MountedCommandPaletteResultsIsland {
  unmount: () => void;
}

export function mountCommandPaletteResultsIsland(
  host: HTMLElement,
  options: CommandPaletteResultsIslandOptions,
): MountedCommandPaletteResultsIsland {
  host.setAttribute("data-desktop-vue-island", "command-palette-results");
  host.id = "desktop-command-palette-results";
  host.className = "desktop-command-palette-results";
  host.setAttribute("aria-live", "polite");
  const app = createCommandPaletteResultsApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createCommandPaletteResultsApp(options: CommandPaletteResultsIslandOptions): App {
  return createApp(defineComponent({
    name: "CommandPaletteResultsIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => options.results.length
          ? options.results.map((result, index) => renderResultButton(result, index === 0))
          : h(NText, { class: "desktop-command-palette-empty", tag: "p" }, { default: () => "No command palette matches." }),
      });
    },
  }));
}

function renderResultButton(result: DesktopCommandPaletteResult, selected: boolean) {
  return h(NButton, {
    "aria-selected": String(selected),
    "data-palette-command": result.destination.commandId,
    "data-palette-entity": result.destination.entityId,
    "data-palette-group": result.groupId,
    "data-palette-href": result.destination.href,
    "data-palette-module": result.destination.module,
    "data-palette-result-id": result.id,
    class: "desktop-command-palette-result",
    tag: "button",
    type: "button",
  }, {
    default: () => [
      h(NText, { strong: true, tag: "strong" }, { default: () => result.title }),
      h(NText, { depth: 3, tag: "span" }, { default: () => [result.group, result.secondary].filter(Boolean).join(" / ") }),
    ],
  });
}
