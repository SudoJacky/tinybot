import { createApp, defineComponent, h, ref, type App } from "vue";
import { NButton, NCard, NConfigProvider, NSpace } from "naive-ui";
import type { DesktopCoworkObservabilityPanel } from "../../cowork/desktopCowork";
import { desktopNaiveThemeOverrides } from "../shell/desktopNaiveTheme";

const COWORK_OBSERVABILITY_ROW_LIMIT = 24;

export interface CoworkObservabilityIslandOptions {
  panels: DesktopCoworkObservabilityPanel[];
  onPanelSelected?: (panel: DesktopCoworkObservabilityPanel) => void;
}

export interface MountedCoworkObservabilityIsland {
  unmount: () => void;
}

export function mountCoworkObservabilityIsland(
  host: HTMLElement,
  options: CoworkObservabilityIslandOptions,
): MountedCoworkObservabilityIsland {
  host.setAttribute("data-desktop-vue-island", "cowork-observability");
  host.className = "desktop-cowork-observability";
  host.setAttribute("aria-label", "Cowork observability");
  const app = createCoworkObservabilityApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createCoworkObservabilityApp(options: CoworkObservabilityIslandOptions): App {
  return createApp(defineComponent({
    name: "CoworkObservabilityIsland",
    setup() {
      const selectedPanelId = ref(options.panels[0]?.id ?? "");
      const filterText = ref("");
      const selectPanel = (panel: DesktopCoworkObservabilityPanel): void => {
        selectedPanelId.value = panel.id;
        options.onPanelSelected?.(panel);
      };

      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => [
          h("h2", "Observability"),
          renderTabs(options.panels, selectedPanelId.value, selectPanel),
          h("input", {
            class: "desktop-cowork-observability-filter",
            type: "search",
            "aria-label": "Filter Cowork observability rows",
            placeholder: "Filter current panel",
            "data-desktop-cowork-filter": "observability",
            value: filterText.value,
            onInput: (event: Event) => {
              filterText.value = String((event.target as HTMLInputElement | null)?.value ?? "");
            },
          }),
          renderPanel(options.panels, selectedPanelId.value, filterText.value),
        ],
      });
    },
  }));
}

function renderTabs(
  panels: DesktopCoworkObservabilityPanel[],
  selectedPanelId: string,
  onSelect: (panel: DesktopCoworkObservabilityPanel) => void,
) {
  return h(NSpace, {
    class: "desktop-cowork-observability-tabs",
    role: "tablist",
    size: 6,
  }, {
    default: () => panels.map((panel) => h(NButton, {
      class: "desktop-cowork-observability-tab",
      role: "tab",
      "data-desktop-cowork-panel": panel.id,
      "aria-selected": panel.id === selectedPanelId ? "true" : "false",
      size: "tiny",
      type: panel.id === selectedPanelId ? "primary" : "default",
      secondary: panel.id !== selectedPanelId,
      onClick: () => onSelect(panel),
    }, { default: () => panel.label })),
  });
}

function renderPanel(
  panels: DesktopCoworkObservabilityPanel[],
  selectedPanelId: string,
  query: string,
) {
  const selectedPanel = panels.find((panel) => panel.id === selectedPanelId) ?? panels[0];
  if (!selectedPanel) {
    return h(NCard, {
      class: "desktop-cowork-observability-panel",
      bordered: false,
      embedded: true,
      contentStyle: "padding: 0;",
    }, {
      default: () => h("p", "No Cowork observability data."),
    });
  }

  const normalizedQuery = query.trim().toLowerCase();
  const matchedRows = normalizedQuery
    ? selectedPanel.rows.filter((row) => `${row.label} ${row.value}`.toLowerCase().includes(normalizedQuery))
    : selectedPanel.rows;
  const visibleRows = matchedRows.slice(0, COWORK_OBSERVABILITY_ROW_LIMIT);

  return h(NCard, {
    class: "desktop-cowork-observability-panel",
    bordered: false,
    embedded: true,
    contentStyle: "padding: 0;",
  }, {
    default: () => [
      h("h2", selectedPanel.label),
      h("p", selectedPanel.summary),
      h("p", { class: "desktop-cowork-limit-status" }, coworkFilteredLimitStatus(
        visibleRows.length,
        matchedRows.length,
        selectedPanel.rows.length,
        Boolean(normalizedQuery),
      )),
      ...visibleRows.map((row) => h("p", {
        class: "desktop-cowork-observability-row",
      }, `${row.label}: ${row.value}`)),
    ],
  });
}

function coworkFilteredLimitStatus(
  visible: number,
  matched: number,
  total: number,
  filtered: boolean,
): string {
  if (!filtered) {
    return `Showing ${visible} of ${total} ${total === 1 ? "row" : "rows"}`;
  }
  return `Showing ${visible} of ${matched} matching rows (${total} total)`;
}
