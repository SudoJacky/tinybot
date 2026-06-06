import { createApp, defineComponent, h, onBeforeUnmount, onMounted, ref, type App } from "vue";
import { NConfigProvider, NSpace } from "naive-ui";
import type { DesktopTaskCenterItem } from "../desktopTaskCenter";
import type {
  DesktopKnowledgePaneModel,
} from "../desktopKnowledgeTraceability";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";
import { mountKnowledgeActionsIsland, type KnowledgeActionItem } from "./knowledgeActionsIsland";
import { mountKnowledgeDocumentDetailIsland } from "./knowledgeDocumentDetailIsland";
import { mountKnowledgeDocumentsIsland } from "./knowledgeDocumentsIsland";
import { mountKnowledgeGraphIsland } from "./knowledgeGraphIsland";
import { mountKnowledgeQueryIsland } from "./knowledgeQueryIsland";
import { mountKnowledgeReadinessIsland } from "./knowledgeReadinessIsland";
import { mountModuleWorkSectionIsland } from "./moduleWorkSectionIsland";

export type KnowledgePaneActionId = "runQuery" | "refreshGraph" | "rebuildIndex" | "deleteDocument" | "uploadDocument";

export interface KnowledgePaneActionEvent {
  action: KnowledgePaneActionId;
  pane: DesktopKnowledgePaneModel;
}

export interface KnowledgePaneIslandOptions {
  pane: DesktopKnowledgePaneModel;
  workItems?: DesktopTaskCenterItem[];
  onInspectWorkItem?: (item: DesktopTaskCenterItem) => void;
  onKnowledgeAction?: (event: KnowledgePaneActionEvent) => void;
}

export interface MountedKnowledgePaneIsland {
  unmount: () => void;
}

export function mountKnowledgePaneIsland(
  host: HTMLElement,
  options: KnowledgePaneIslandOptions,
): MountedKnowledgePaneIsland {
  host.setAttribute("data-desktop-vue-island", "knowledge-pane");
  host.className = "desktop-workbench-section desktop-knowledge-pane";
  host.setAttribute("data-desktop-module-surface", "knowledge");
  host.setAttribute("aria-label", "Knowledge workbench");

  const app = createKnowledgePaneApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createKnowledgePaneApp(options: KnowledgePaneIslandOptions): App {
  return createApp(defineComponent({
    name: "KnowledgePaneIsland",
    setup() {
      const mountedChildren: Array<{ unmount: () => void }> = [];
      const actions = ref<HTMLElement | null>(null);
      const work = ref<HTMLElement | null>(null);
      const readiness = ref<HTMLElement | null>(null);
      const documents = ref<HTMLElement | null>(null);
      const documentDetail = ref<HTMLElement | null>(null);
      const query = ref<HTMLElement | null>(null);
      const graph = ref<HTMLElement | null>(null);

      onMounted(() => {
        mountChild(mountedChildren, actions.value, (host) => mountKnowledgeActionsIsland(host, {
          actions: knowledgeActions(options.pane),
          onAction: (action) => options.onKnowledgeAction?.({ action, pane: options.pane }),
        }));
        if (options.workItems?.length) {
          mountChild(mountedChildren, work.value, (host) => mountModuleWorkSectionIsland(host, {
            title: "Knowledge jobs",
            items: options.workItems ?? [],
            onInspect: options.onInspectWorkItem,
          }));
        }
        mountChild(mountedChildren, readiness.value, (host) => mountKnowledgeReadinessIsland(host, {
          readiness: options.pane.readiness,
          configHints: options.pane.configHints,
        }));
        mountChild(mountedChildren, documents.value, (host) => mountKnowledgeDocumentsIsland(host, {
          documents: options.pane.documentRows,
        }));
        if (options.pane.selectedDocument) {
          mountChild(mountedChildren, documentDetail.value, (host) => mountKnowledgeDocumentDetailIsland(host, {
            document: options.pane.selectedDocument!,
          }));
        }
        mountChild(mountedChildren, query.value, (host) => mountKnowledgeQueryIsland(host, {
          draft: options.pane.query.draft,
          results: options.pane.query.results,
        }));
        mountChild(mountedChildren, graph.value, (host) => mountKnowledgeGraphIsland(host, {
          graph: options.pane.graph,
        }));
      });

      onBeforeUnmount(() => {
        while (mountedChildren.length) {
          mountedChildren.pop()?.unmount();
        }
      });

      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => h(NSpace, {
          class: "desktop-knowledge-stack",
          vertical: true,
          size: 12,
        }, {
          default: () => [
            h("h2", "Knowledge"),
            h("p", options.pane.status),
            h("div", { ref: actions }),
            options.workItems?.length ? h("section", { ref: work }) : null,
            h("section", { ref: readiness }),
            h("section", { ref: documents }),
            options.pane.selectedDocument ? h("section", { ref: documentDetail }) : null,
            h("section", { ref: query }),
            h("section", { ref: graph }),
          ],
        }),
      });
    },
  }));
}

function knowledgeActions(pane: DesktopKnowledgePaneModel): KnowledgeActionItem[] {
  return [
    { action: "uploadDocument", label: "Upload document", enabled: pane.actions.upload },
    { action: "runQuery", label: "Run query", enabled: pane.actions.query },
    { action: "refreshGraph", label: "Refresh graph", enabled: pane.actions.refreshGraph },
    { action: "rebuildIndex", label: "Rebuild index", enabled: pane.actions.rebuild },
    { action: "deleteDocument", label: "Delete document", enabled: pane.actions.deleteDocument },
  ];
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
