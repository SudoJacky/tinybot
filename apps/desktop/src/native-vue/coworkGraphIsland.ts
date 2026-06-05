import { createApp, defineComponent, h, ref, type App } from "vue";
import { NButton, NCard, NConfigProvider, NSpace, NTag } from "naive-ui";
import type { DesktopCoworkGraphView, DesktopCoworkSelectionType } from "../desktopCowork";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

const COWORK_GRAPH_NODE_LIMIT = 24;
const COWORK_GRAPH_EDGE_LIMIT = 12;

export interface CoworkGraphSelection {
  type: DesktopCoworkSelectionType;
  id: string;
  label: string;
}

export interface CoworkGraphIslandOptions {
  graph: DesktopCoworkGraphView;
  onSelect?: (selection: CoworkGraphSelection) => void;
}

export interface MountedCoworkGraphIsland {
  unmount: () => void;
}

export function mountCoworkGraphIsland(
  host: HTMLElement,
  options: CoworkGraphIslandOptions,
): MountedCoworkGraphIsland {
  host.setAttribute("data-desktop-vue-island", "cowork-graph");
  host.className = "desktop-cowork-graph";
  const app = createCoworkGraphApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createCoworkGraphApp(options: CoworkGraphIslandOptions): App {
  return createApp(defineComponent({
    name: "CoworkGraphIsland",
    setup() {
      const selectedEntityId = ref("");
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => [
          h("h2", "Graph"),
          h("p", options.graph.caption),
          renderNodes(options, selectedEntityId),
          h("p", { class: "desktop-cowork-limit-status" }, limitStatus(
            Math.min(options.graph.nodes.length, COWORK_GRAPH_NODE_LIMIT),
            options.graph.nodes.length,
            "node",
            "nodes",
          )),
          renderEdges(options.graph),
          h("p", { class: "desktop-cowork-limit-status" }, limitStatus(
            Math.min(options.graph.edges.length, COWORK_GRAPH_EDGE_LIMIT),
            options.graph.edges.length,
            "edge",
            "edges",
          )),
        ],
      });
    },
  }));
}

function renderNodes(
  options: CoworkGraphIslandOptions,
  selectedEntityId: { value: string },
) {
  return h(NSpace, { vertical: true, size: 6 }, {
    default: () => options.graph.nodes.slice(0, COWORK_GRAPH_NODE_LIMIT).map((node) => {
      const type = coworkSelectionTypeForKind(node.kind);
      return h(NButton, {
        class: "desktop-cowork-graph-node",
        "data-desktop-cowork-entity": node.id,
        "data-desktop-cowork-kind": node.kind,
        "aria-selected": selectedEntityId.value === node.id ? "true" : "false",
        block: true,
        secondary: selectedEntityId.value !== node.id,
        type: selectedEntityId.value === node.id ? "primary" : "default",
        onClick: () => {
          if (!type) {
            return;
          }
          selectedEntityId.value = node.id;
          options.onSelect?.({ type, id: node.id, label: node.label });
        },
      }, {
        default: () => [
          h("span", `${node.label}: ${node.kind}${node.status ? ` / ${node.status}` : ""}`),
          node.status ? h(NTag, { size: "small", round: true }, { default: () => node.status }) : null,
        ],
      });
    }),
  });
}

function renderEdges(graph: DesktopCoworkGraphView) {
  const edges = graph.edges.slice(0, COWORK_GRAPH_EDGE_LIMIT);
  if (!edges.length) {
    return null;
  }
  return h(NCard, {
    class: "desktop-cowork-graph-edges",
    bordered: false,
    embedded: true,
    contentStyle: "padding: 0;",
  }, {
    default: () => edges.map((edge) => h("p", `${edge.source} -> ${edge.target}${edge.label ? ` / ${edge.label}` : ""}`)),
  });
}

function limitStatus(visible: number, total: number, singular: string, plural: string): string {
  const noun = total === 1 ? singular : plural;
  return `Showing ${visible} of ${total} ${noun}`;
}

function coworkSelectionTypeForKind(kind: string): DesktopCoworkSelectionType {
  const value = kind.toLowerCase();
  if (value.includes("agent")) {
    return "agent";
  }
  if (value.includes("task")) {
    return "task";
  }
  if (value.includes("mail")) {
    return "mailbox";
  }
  if (value.includes("thread")) {
    return "thread";
  }
  if (value.includes("trace")) {
    return "trace";
  }
  if (value.includes("artifact")) {
    return "artifact";
  }
  if (value.includes("work") || value.includes("unit")) {
    return "workUnit";
  }
  if (value.includes("branch")) {
    return "branch";
  }
  return "";
}
