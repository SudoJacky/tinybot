import { createApp, defineComponent, h, onBeforeUnmount, onMounted, ref, type App } from "vue";
import { NConfigProvider } from "naive-ui";
import {
  buildDesktopCoworkCockpitView,
  type DesktopCoworkObservabilityPanel,
  type DesktopCoworkSelectionType,
  type DesktopCoworkSessionRow,
} from "../desktopCowork";
import type { DesktopCoworkActionEvent, DesktopCoworkPaneModel } from "../desktopWorkbenchShell";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";
import { mountCoworkActionsIsland } from "./coworkActionsIsland";
import { mountCoworkGraphIsland } from "./coworkGraphIsland";
import { mountCoworkHeaderIsland } from "./coworkHeaderIsland";
import { mountCoworkInspectorIsland } from "./coworkInspectorIsland";
import { mountCoworkObservabilityIsland } from "./coworkObservabilityIsland";
import { mountCoworkSessionsIsland } from "./coworkSessionsIsland";
import { mountCoworkTaskFeedIsland } from "./coworkTaskFeedIsland";

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
  host.setAttribute("aria-label", "Cowork cockpit");

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
  return createApp(defineComponent({
    name: "CoworkPaneIsland",
    setup() {
      const selectedView = ref(options.pane.cockpitView ?? null);
      const mountedChildren: Array<{ unmount: () => void }> = [];
      const mountedViewChildren: Array<{ unmount: () => void }> = [];
      const sessions = ref<HTMLElement | null>(null);
      const actions = ref<HTMLElement | null>(null);
      const header = ref<HTMLElement | null>(null);
      const graph = ref<HTMLElement | null>(null);
      const observability = ref<HTMLElement | null>(null);
      const inspector = ref<HTMLElement | null>(null);
      const taskFeed = ref<HTMLElement | null>(null);

      const mountViewChildren = (): void => {
        while (mountedViewChildren.length) {
          mountedViewChildren.pop()?.unmount();
        }
        const view = selectedView.value;
        if (!view) {
          return;
        }
        mountChild(mountedViewChildren, header.value, (host) => mountCoworkHeaderIsland(host, { header: view.header }));
        mountChild(mountedViewChildren, graph.value, (host) => mountCoworkGraphIsland(host, {
          graph: view.graph,
          onSelect: (selection) => {
            if (!selectedView.value) {
              return;
            }
            selectedView.value = buildDesktopCoworkCockpitView(selectedView.value.raw, {
              selected: { type: selection.type, id: selection.id },
            });
            options.onGraphSelect?.(selection);
            mountViewChildren();
          },
        }));
        mountChild(mountedViewChildren, observability.value, (host) => mountCoworkObservabilityIsland(host, {
          panels: view.observabilityPanels,
          onPanelSelected: options.onObservabilityPanelSelected,
        }));
        mountChild(mountedViewChildren, inspector.value, (host) => mountCoworkInspectorIsland(host, {
          view,
          onAction: (event) => emitAction(options, event),
        }));
        mountChild(mountedViewChildren, taskFeed.value, (host) => mountCoworkTaskFeedIsland(host, {
          items: view.taskCenterItems,
          totals: {
            agents: view.agents.length,
            tasks: view.tasks.length,
            mailbox: view.mailbox.length,
            artifacts: view.artifacts.length,
          },
        }));
      };

      onMounted(() => {
        mountChild(mountedChildren, sessions.value, (host) => mountCoworkSessionsIsland(host, {
          sessions: options.pane.sessionRows,
          onSelect: options.onSessionSelect,
        }));
        mountChild(mountedChildren, actions.value, (host) => mountCoworkActionsIsland(host, {
          sessionId: selectedView.value?.header.id ?? "",
          agents: selectedView.value?.agents ?? [],
          actionStatus: options.pane.actionStatus,
          summaryText: options.pane.summaryText,
          blueprintDiagnostics: options.pane.blueprintDiagnostics,
          onAction: (event) => emitAction(options, event),
        }));
        mountViewChildren();
      });

      onBeforeUnmount(() => {
        while (mountedViewChildren.length) {
          mountedViewChildren.pop()?.unmount();
        }
        while (mountedChildren.length) {
          mountedChildren.pop()?.unmount();
        }
      });

      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => [
          h("h2", "Cowork"),
          h("section", { ref: sessions }),
          h("section", { ref: actions }),
          selectedView.value
            ? [
              h("section", { ref: header }),
              h("section", { ref: graph }),
              h("section", { ref: observability }),
              h("section", { ref: inspector }),
              h("section", { ref: taskFeed }),
            ]
            : h("p", "Select a Cowork session to open the cockpit."),
        ],
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

function emitAction(options: CoworkPaneIslandOptions, event: CoworkPaneActionEvent): void {
  options.onCoworkAction?.({ ...event, pane: options.pane } as DesktopCoworkActionEvent);
}
