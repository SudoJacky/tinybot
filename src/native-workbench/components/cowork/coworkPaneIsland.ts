import { createApp, defineComponent, h, type App } from "vue";
import { NConfigProvider } from "naive-ui";
import type {
  DesktopCoworkObservabilityPanel,
  DesktopCoworkSelectionType,
  DesktopCoworkSessionRow,
} from "../../cowork/desktopCowork";
import type { DesktopCoworkActionEvent, DesktopCoworkPaneModel } from "../../shell/desktopWorkbenchShell";
import { desktopNaiveThemeOverrides } from "../shell/desktopNaiveTheme";

export interface CoworkPaneGraphSelection {
  type: DesktopCoworkSelectionType;
  id: string;
  label: string;
}

export interface CoworkPaneIslandOptions {
  pane: DesktopCoworkPaneModel;
  onCoworkAction?: (event: DesktopCoworkActionEvent) => void;
  onGraphSelect?: (selection: CoworkPaneGraphSelection) => void;
  onObservabilityPanelSelected?: (panel: DesktopCoworkObservabilityPanel) => void;
  onSessionSelect?: (session: DesktopCoworkSessionRow) => void;
}

export interface MountedCoworkPaneIsland {
  unmount: () => void;
}

export type CoworkPaneActionEvent = Omit<DesktopCoworkActionEvent, "pane">;

export function mountCoworkPaneIsland(
  host: HTMLElement,
  options: CoworkPaneIslandOptions,
): MountedCoworkPaneIsland {
  host.setAttribute("data-desktop-vue-island", "cowork-pane");
  host.className = "desktop-workbench-section desktop-cowork-cockpit";
  host.setAttribute("data-desktop-module-surface", "cowork");
  host.setAttribute("aria-label", "Cowork unavailable");

  const app = createCoworkPaneApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createCoworkPaneApp(options: CoworkPaneIslandOptions): App {
  void options;
  return createApp(defineComponent({
    name: "CoworkPaneIsland",
    setup: () => () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
      default: () => renderCoworkUnavailable(),
    }),
  }));
}

function renderCoworkUnavailable() {
  return h("section", { class: "desktop-cowork-unavailable" }, [
    h("p", { class: "desktop-cowork-unavailable-kicker" }, "Cowork"),
    h("h2", "Cowork is under construction"),
    h("p", "This page is temporarily unavailable."),
    h("p", "暂不开放"),
  ]);
}
